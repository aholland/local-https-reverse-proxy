#!/usr/bin/env node

import * as fs from 'fs';
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

    const handleProxyError = (e: any, req, res) => {
        logger.debug({ proxy: name, error: e.code }, 'Proxy error occurred');

        if (e.code === 'ECONNREFUSED') {
            // Track start time for retry window
            if (!req._retryStartTime) {
                req._retryStartTime = Date.now();
                req._retryCount = 0;
            }

            const elapsed = Date.now() - req._retryStartTime;

            // Retry if still within the time window
            if (elapsed < maxRetryMs) {
                req._retryCount++;
                logger.debug({
                    proxy: name,
                    target: `http://${hostname}:${target}`,
                    retry: req._retryCount,
                    delay: retryInterval,
                    elapsed
                }, 'Connection refused, retrying');

                // Increase max listeners to avoid warning during retries
                if (req.setMaxListeners) {
                    req.setMaxListeners(25);
                }

                setTimeout(() => {
                    proxy.web(req, res, {}, handleProxyError);
                }, retryInterval);
                return;
            }

            // Max retry time exceeded
            logger.error({
                proxy: name,
                error: e.code,
                retries: req._retryCount,
                maxRetryMs
            }, 'Request failed - retry window exceeded');
        } else {
            logger.error({ proxy: name, error: e.code, message: e.message }, 'Request failed');
        }

        // Type guard to ensure res is a valid ServerResponse
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Bad Gateway: Unable to connect to target server`);
        } else if (!res || typeof res.writeHead !== 'function') {
            logger.error({ proxy: name }, 'Cannot send error response - invalid response object');
        }
    };

    const proxy = httpProxy
        .createServer({
            xfwd: true,
            ws: true,
            target: {
                host: hostname,
                port: target
            },
            ssl: {
                key: fs.readFileSync(key, 'utf8'),
                cert: fs.readFileSync(cert, 'utf8')
            }
        })
        .on('error', handleProxyError)
        .on('proxyReq', (proxyReq, req) => {
            logger.debug({ proxy: name, method: req.method, url: req.url }, 'Forwarding request');
            const origin = proxyReq.getHeader('origin');
            if (origin) {
                proxyReq.setHeader('origin', origin.toString().replace(/^https:/, 'http:'));
            }
            const ref = proxyReq.getHeader('referer');
            if (ref) {
                proxyReq.setHeader('referer', ref.toString().replace(/^https:/, 'http:'));
            }
        })
        .on('proxyRes', (proxyRes, req, res) => {
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
        })
        .listen(source);

    logger.info({
        proxy: name,
        sourceUrl: `https://${hostname}:${source}`,
        targetUrl: `http://${hostname}:${target}`
    }, 'Proxy started');

    process.on('exit', (code) => {
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
