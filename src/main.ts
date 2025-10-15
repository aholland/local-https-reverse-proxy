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
    retryIntervalMs: number,
    proxyName: string,
    isDevTooling: boolean = false
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

            // Log first retry at info level (or debug for dev tooling)
            if (retryCount === 1) {
                const level = isDevTooling ? 'debug' : 'info';
                logger[level]({
                    proxy: proxyName,
                    target: `http://${hostname}:${port}`,
                    error: err.code || 'UNKNOWN',
                    maxRetryMs
                }, 'Target not available, starting retry attempts');
            } else {
                logger.debug({
                    proxy: proxyName,
                    target: `http://${hostname}:${port}`,
                    retry: retryCount,
                    delay: retryIntervalMs,
                    elapsed,
                    error: err.code || 'UNKNOWN'
                }, 'Target not ready, retrying...');
            }

            // Wait before next retry
            await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
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
    const maxRetryMs: number = get('maxRetryMs', true, true) ?? 1000;
    const retryIntervalMs: number = get('retryIntervalMs', true, true) ?? 50;

    // Parse target(s) configuration
    const singleTarget = get('target', false, true);
    const multiTargets = get('targets', false, true);

    // Build routes array from both single target and multi-targets
    const routeConfigs: Array<{ name: string; path: string; port: number; aliases?: string[] }> = [];

    if (multiTargets && typeof multiTargets === 'object' && !Array.isArray(multiTargets)) {
        // Named targets as object
        for (const [targetName, targetConfig] of Object.entries(multiTargets as Record<string, { path: string; port: number; aliases?: string[] }>)) {
            // Validate aliases don't have trailing slashes
            if (targetConfig.aliases) {
                for (const alias of targetConfig.aliases) {
                    if (alias.endsWith('/') && alias !== '/') {
                        throw Error(`Alias "${alias}" in target "${targetName}" has a trailing slash. Aliases must not end with a slash (e.g., use "/bid" not "/bid/").`);
                    }
                }
            }

            routeConfigs.push({
                name: targetName,
                path: targetConfig.path,
                port: targetConfig.port,
                aliases: targetConfig.aliases
            });
        }
    }

    if (singleTarget) {
        // Single target becomes the fallback route
        routeConfigs.push({ name: 'default', path: '/', port: singleTarget });
    }

    if (routeConfigs.length === 0) {
        throw Error(`No target or targets provided for config ${name} in the config file.`);
    }

    // Sort routes by path specificity (longest/most specific first)
    routeConfigs.sort((a, b) => b.path.length - a.path.length);

    // Determine source port (use first target + 1000 if not specified)
    const source: number = get('source', false, true) ?? routeConfigs[0].port + 1000;

    // Create route objects with separate proxy instances and health check promises
    const routes = routeConfigs.map(routeConfig => {
        // Each route gets its own health check promise (in closure)
        let activeHealthCheck: Promise<boolean> | null = null;

        /**
         * Get or create a shared health check promise for this specific route.
         * Concurrent requests to the same route await the same health check.
         */
        const getOrCreateHealthCheck = (isDevTooling: boolean = false): Promise<boolean> => {
            if (!activeHealthCheck) {
                // No active check - start a new one
                activeHealthCheck = checkTargetAvailable(
                    hostname,
                    routeConfig.port,
                    maxRetryMs,
                    retryIntervalMs,
                    name,
                    isDevTooling
                ).finally(() => {
                    // Clear the shared promise when done so next request creates a new one
                    activeHealthCheck = null;
                });
            }
            return activeHealthCheck;
        };

        // Create proxy instance for this route
        const proxy = httpProxy.createProxyServer({
            xfwd: true,
            ws: true,
            target: {
                host: hostname,
                port: routeConfig.port
            }
        });

        return {
            name: routeConfig.name,
            path: routeConfig.path,
            port: routeConfig.port,
            aliases: routeConfig.aliases || [],
            proxy,
            getOrCreateHealthCheck
        };
    });

    // Set up event handlers for each route's proxy instance
    routes.forEach(route => {
        // Handle proxy errors (for errors other than connection refused)
        route.proxy.on('error', (e: any, req: any, res: any) => {
            logger.error({
                proxy: name,
                target: route.name,
                route: route.path,
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
        route.proxy.on('proxyReq', (proxyReq, req) => {
            logger.debug({ proxy: name, target: route.name, route: route.path, method: req.method, url: req.url }, 'Forwarding request');
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
        route.proxy.on('proxyRes', (proxyRes, req) => {
            logger.debug({
                proxy: name,
                target: route.name,
                route: route.path,
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

            // Visual feedback: green dot for successful HTTP response
            process.stdout.write('\x1b[32m·\x1b[0m');
        });
    });

    // Create HTTPS server that checks target availability before proxying
    const server = https.createServer(
        {
            key: fs.readFileSync(key, 'utf8'),
            cert: fs.readFileSync(cert, 'utf8')
        },
        async (req: any, res: any) => {
            try {
                // Add error handlers to prevent uncaught exceptions on socket errors
                req.on('error', (err: any) => {
                    logger.warn({
                        proxy: name,
                        error: err.code,
                        message: err.message,
                        method: req.method,
                        url: req.url
                    }, 'Request socket error (connection interrupted)');
                });

                res.on('error', (err: any) => {
                    logger.warn({
                        proxy: name,
                        error: err.code,
                        message: err.message
                    }, 'Response socket error (connection interrupted)');
                });

                // Check if URL matches any alias - redirect if it does
                for (const route of routes) {
                    for (const alias of route.aliases) {
                        // Check if URL matches this alias using same logic as path matching
                        const matchesAlias = req.url === alias ||
                                           req.url.startsWith(alias + '/') ||
                                           req.url.startsWith(alias + '?');

                        if (matchesAlias) {
                            // Construct redirect URL by replacing alias with main path
                            // Strip trailing slash from main path to avoid double slashes
                            const mainPath = route.path.endsWith('/') && route.path !== '/'
                                ? route.path.slice(0, -1)
                                : route.path;
                            const redirectUrl = req.url.replace(alias, mainPath);

                            logger.debug({
                                proxy: name,
                                target: route.name,
                                alias,
                                mainPath: route.path,
                                originalUrl: req.url,
                                redirectUrl
                            }, 'Redirecting alias to main path');

                            res.writeHead(301, {
                                'Location': redirectUrl,
                                'Content-Type': 'text/plain'
                            });
                            res.end(`Moved Permanently: ${alias} -> ${route.path}`);
                            return;
                        }
                    }
                }

                // Match request path to route (routes are sorted by specificity)
                const matchedRoute = routes.find(route => {
                    // Special case: '/' matches everything (fallback)
                    if (route.path === '/') {
                        return true;
                    }
                    // Match if URL starts with path and is followed by / or ? or end of string
                    return req.url === route.path ||
                           req.url.startsWith(route.path + '/') ||
                           req.url.startsWith(route.path + '?');
                });

                if (!matchedRoute) {
                    // No route matched (shouldn't happen if '/' fallback exists)
                    logger.error({
                        proxy: name,
                        method: req.method,
                        url: req.url
                    }, 'No route matched for request');

                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found: No matching route');
                    return;
                }

                // Check if target is available before proxying
                // Use shared health check - concurrent requests to same route await same check
                const targetAvailable = await matchedRoute.getOrCreateHealthCheck();

                if (!targetAvailable) {
                    // Target is not available after retries
                    logger.warn({
                        proxy: name,
                        target: matchedRoute.name,
                        route: matchedRoute.path,
                        method: req.method,
                        url: req.url,
                        targetUrl: `http://${hostname}:${matchedRoute.port}`
                    }, 'Returning 502 - target server unavailable');

                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Bad Gateway: Target server not available');
                    return;
                }

                // Target is available, proxy the request (only called ONCE)
                matchedRoute.proxy.web(req, res);
            } catch (err: any) {
                logger.error({
                    proxy: name,
                    error: err.message,
                    stack: err.stack,
                    method: req.method,
                    url: req.url
                }, 'Unexpected error handling HTTP request');

                if (res && !res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error');
                }
            }
        }
    );

    // Handle WebSocket upgrade requests
    server.on('upgrade', async (req: any, socket: any, head: any) => {
        try {
            // Check if this is Vite dev tooling (to reduce log noise)
            const wsProtocol = req.headers['sec-websocket-protocol'] || '';
            const isDevTooling = wsProtocol.includes('vite-ping');

            // Debug: log WebSocket protocol to see what we're getting
            if (wsProtocol) {
                logger.debug({
                    proxy: name,
                    wsProtocol,
                    isDevTooling
                }, 'WebSocket upgrade - protocol detected');
            }

            // Add error handler to prevent uncaught exceptions on socket errors
            socket.on('error', (err: any) => {
                const level = isDevTooling ? 'debug' : 'warn';
                logger[level]({
                    proxy: name,
                    error: err.code,
                    message: err.message,
                    url: req.url
                }, 'WebSocket socket error (connection interrupted)');
            });

            // Match request path to route (routes are sorted by specificity)
            const matchedRoute = routes.find(route => {
                // Special case: '/' matches everything (fallback)
                if (route.path === '/') {
                    return true;
                }
                // Match if URL starts with path and is followed by / or ? or end of string
                return req.url === route.path ||
                       req.url.startsWith(route.path + '/') ||
                       req.url.startsWith(route.path + '?');
            });

            if (!matchedRoute) {
                // No route matched (shouldn't happen if '/' fallback exists)
                logger.error({
                    proxy: name,
                    url: req.url
                }, 'No route matched for WebSocket upgrade');

                socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
                return;
            }

            // Use shared health check - concurrent requests to same route await same check
            const targetAvailable = await matchedRoute.getOrCreateHealthCheck(isDevTooling);

            // Visual feedback: yellow dot for vite-ping (all attempts), green for other WebSockets (success only)
            if (isDevTooling) {
                process.stdout.write('\x1b[33m·\x1b[0m');
            }

            if (!targetAvailable) {
                const level = isDevTooling ? 'debug' : 'warn';
                logger[level]({
                    proxy: name,
                    target: matchedRoute.name,
                    route: matchedRoute.path,
                    url: req.url,
                    targetUrl: `http://${hostname}:${matchedRoute.port}`
                }, 'Returning 502 - target server unavailable for WebSocket upgrade');
                socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                return;
            }

            matchedRoute.proxy.ws(req, socket, head);

            // Green dot for successful non-vite WebSocket
            if (!isDevTooling) {
                process.stdout.write('\x1b[32m·\x1b[0m');
            }
        } catch (err: any) {
            logger.error({
                proxy: name,
                error: err.message,
                stack: err.stack,
                url: req.url
            }, 'Unexpected error handling WebSocket upgrade');
            socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        }
    });

    server.listen(source);

    // Log proxy startup with route information
    if (routes.length === 1) {
        const routeInfo: any = {
            proxy: name,
            sourceUrl: `https://${hostname}:${source}`,
            target: routes[0].name,
            targetUrl: `http://${hostname}:${routes[0].port}`
        };
        if (routes[0].aliases.length > 0) {
            routeInfo.aliases = routes[0].aliases;
        }
        logger.info(routeInfo, 'Proxy started');
    } else {
        logger.info({
            proxy: name,
            sourceUrl: `https://${hostname}:${source}`,
            routes: routes.map(r => {
                const route: any = { name: r.name, path: r.path, target: `http://${hostname}:${r.port}` };
                if (r.aliases.length > 0) {
                    route.aliases = r.aliases;
                }
                return route;
            })
        }, 'Proxy started with multiple routes');
    }

    process.on('exit', () => {
        server.close();
        routes.forEach(route => route.proxy.close());
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
