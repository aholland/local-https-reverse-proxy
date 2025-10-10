#!/usr/bin/env node

import * as fs from 'fs';
import * as https from 'https';
import * as net from 'net';
import * as httpProxy from 'http-proxy-3';
import * as pino from 'pino';
import { isProxy, parse } from './lib';

const parsed = parse();

const config = isProxy(parsed) ? {proxy: parsed} : parsed;

const defaults = config['defaults'];
const logLevel = (defaults && defaults['logLevel']) || 'info';

const logger = pino.pino({
    level: logLevel,
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname'
        }
    }
});

/**
 * Check if target port is accepting connections by attempting a TCP connection.
 * Retries within the specified time window.
 * @returns Promise<boolean> - true if target is available, false otherwise
 */
async function checkTargetAvailable(
    hostname: string,
    port: number,
    maxRetryMs: number,
    retryInterval: number,
    proxyName: string
): Promise<boolean> {
    const startTime = Date.now();
    let retryCount = 0;

    while (Date.now() - startTime < maxRetryMs) {
        try {
            await new Promise<void>((resolve, reject) => {
                const socket = new net.Socket();
                const timeout = 100; // Quick connection timeout

                socket.setTimeout(timeout);

                socket.once('connect', () => {
                    socket.destroy();
                    resolve();
                });

                socket.once('error', (err) => {
                    socket.destroy();
                    reject(err);
                });

                socket.once('timeout', () => {
                    socket.destroy();
                    reject(new Error('Connection timeout'));
                });

                socket.connect(port, hostname);
            });

            // Success! Target is available
            if (retryCount > 0) {
                logger.info({
                    proxy: proxyName,
                    target: `http://${hostname}:${port}`,
                    retries: retryCount,
                    elapsed: Date.now() - startTime
                }, 'Target server became available');
            }
            return true;

        } catch (err: any) {
            retryCount++;
            const elapsed = Date.now() - startTime;

            // Check if we still have time to retry
            if (elapsed >= maxRetryMs) {
                logger.error({
                    proxy: proxyName,
                    target: `http://${hostname}:${port}`,
                    error: err.code || 'UNKNOWN',
                    retries: retryCount,
                    elapsed
                }, 'Target server not available - retry window exceeded');
                return false;
            }

            logger.debug({
                proxy: proxyName,
                target: `http://${hostname}:${port}`,
                retry: retryCount,
                delay: retryInterval,
                elapsed,
                error: err.code || 'UNKNOWN'
            }, 'Target not ready, retrying...');

            // Wait before next retry
            await new Promise(resolve => setTimeout(resolve, retryInterval));
        }
    }

    return false;
}

for (const name of Object.keys(config)) {
    if (name === 'defaults' || name === 'ignore') {
        continue;
    }
    const proxyConfig = config[name];
    const get = (key: string, checkDefault: boolean, allowUndefined: boolean) => {
        const value = proxyConfig && typeof proxyConfig === 'object' && proxyConfig[key] ? proxyConfig[key] : checkDefault && defaults && defaults[key] ? defaults[key] : null;
        if (!allowUndefined && value == null) {
            const msg1 = `No ${key} provided  for config ${name} in the config file. `
            const msg2 = checkDefault ? `Either the default element or the` : `The`;
            const msg3 = ` individual proxy entry (${name}) must have a child named '${key}`;
            throw Error(msg1 + msg2 + msg3);
        }
        return value;
    }
    const key: string = get('key', true, false);
    const cert: string = get('cert', true, false);
    const hostname: string = get('hostname', true, false);
    const target: number = (typeof proxyConfig != 'object') ? proxyConfig : get('target', false, false);
    const source: number = get('source', false, true) ?? target + 1000;
    const maxRetryMs: number = get('maxRetryMs', true, true) ?? 1000;
    const retryInterval: number = get('retryInterval', true, true) ?? 50;

    // Create proxy instance (not a server)
    const proxy = httpProxy.createProxyServer({
        xfwd: true,
        ws: true,
        target: {
            host: hostname,
            port: target
        }
    });

    // Handle proxy errors (for errors other than connection refused)
    proxy.on('error', (e: any, req: any, res: any) => {
        logger.error({
            proxy: name,
            error: e.code,
            message: e.message
        }, 'Proxy error occurred');

        // Send error response if possible
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Bad Gateway: Proxy error');
        }
    });

    // Modify headers before forwarding
    proxy.on('proxyReq', (proxyReq, req) => {
        logger.debug({ proxy: name, method: req.method, url: req.url }, 'Forwarding request');
        const origin = proxyReq.getHeader('origin');
        if (origin) {
            proxyReq.setHeader('origin', origin.toString().replace(/^https:/, 'http:'));
        }
        const ref = proxyReq.getHeader('referer');
        if (ref) {
            proxyReq.setHeader('referer', ref.toString().replace(/^https:/, 'http:'));
        }
    });

    // Modify response headers
    proxy.on('proxyRes', (proxyRes, req) => {
        logger.debug({
            proxy: name,
            status: proxyRes.statusCode,
            method: req.method,
            url: req.url
        }, 'Response received');
        const loc = proxyRes.headers.location;
        if (loc) {
            proxyRes.headers.location = loc.replace(/^http:/, 'https:');
        }
        const acao = proxyRes.headers["access-control-allow-origin"];
        if (acao) {
            proxyRes.headers["access-control-allow-origin"] = acao.replace(/^http:/, 'https:');
        }
    });

    // Create HTTPS server that checks target availability before proxying
    const server = https.createServer(
        {
            key: fs.readFileSync(key, 'utf8'),
            cert: fs.readFileSync(cert, 'utf8')
        },
        async (req: any, res: any) => {
            // Add error handlers to prevent uncaught exceptions on socket errors
            req.on('error', (err: any) => {
                logger.debug({
                    proxy: name,
                    error: err.code,
                    message: err.message
                }, 'Request socket error');
            });

            res.on('error', (err: any) => {
                logger.debug({
                    proxy: name,
                    error: err.code,
                    message: err.message
                }, 'Response socket error');
            });

            // Check if target is available before proxying
            const targetAvailable = await checkTargetAvailable(
                hostname,
                target,
                maxRetryMs,
                retryInterval,
                name
            );

            if (!targetAvailable) {
                // Target is not available after retries
                logger.warn({
                    proxy: name,
                    method: req.method,
                    url: req.url,
                    target: `http://${hostname}:${target}`
                }, 'Returning 502 - target server unavailable');

                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway: Target server not available');
                return;
            }

            // Target is available, proxy the request (only called ONCE)
            proxy.web(req, res);
        }
    );

    // Handle WebSocket upgrade requests
    server.on('upgrade', async (req: any, socket: any, head: any) => {
        // Add error handler to prevent uncaught exceptions on socket errors
        socket.on('error', (err: any) => {
            logger.debug({
                proxy: name,
                error: err.code,
                message: err.message
            }, 'WebSocket socket error');
        });

        const targetAvailable = await checkTargetAvailable(
            hostname,
            target,
            maxRetryMs,
            retryInterval,
            name
        );

        if (!targetAvailable) {
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            return;
        }

        proxy.ws(req, socket, head);
    });

    server.listen(source);

    logger.info({
        proxy: name,
        sourceUrl: `https://${hostname}:${source}`,
        targetUrl: `http://${hostname}:${target}`
    }, 'Proxy started');

    process.on('exit', () => {
        server.close();
        proxy.close();
        logger.info({ proxy: name }, 'Proxy closed');
    });
}

process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down');
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down');
    process.exit(0);
});
process.on('exit', (code) => {
    const level = code === 0 ? 'info' : 'error';
    logger[level]({ exitCode: code }, 'Process exiting');
});

// Log uncaught errors instead of crashing silently
process.on('uncaughtException', (error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ reason, promise }, 'Unhandled promise rejection');
    process.exit(1);
});
