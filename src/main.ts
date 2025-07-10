#!/usr/bin/env node

import * as fs from 'fs';
import * as httpProxy from 'http-proxy';
import { blue, bold, gray, green, red } from 'ansi-colors';
import { isProxy, parse } from './lib';

const parsed = parse();

const config = isProxy(parsed) ? {proxy: parsed} : parsed;

const defaults = config['defaults'];

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

    const maxRetries = 10;
    const loopingListener = (e: any, req, res) => {
        console.log(gray(`[${new Date().toISOString()}] Proxy ${bold(name)}: Error occurred - ${e.code}`));
        
        // Track retry count per request
        if (!req._retryCount) {
            req._retryCount = 0;
        }
        
        if (e.code === 'ECONNREFUSED' && req._retryCount < maxRetries) {
            req._retryCount++;
            // Faster initial retries: 100ms, 200ms, 400ms, 800ms, then 1s intervals
            const delay = req._retryCount <= 4 ? Math.pow(2, req._retryCount - 1) * 100 : 1000;
            console.error(gray(`Proxy ${bold(name)}: Connection to target at http://${hostname}:${target} refused. Retry ${req._retryCount}/${maxRetries} in ${delay}ms...`));
            setTimeout(() => {
                // Increase max listeners to avoid warning during retries
                if (req.setMaxListeners) {
                    req.setMaxListeners(15);
                }
                proxy.web(req, res, {}, loopingListener);
            }, delay);
        } else {
            console.error(red(`Request failed to ${name}: ${bold(e.code)} - ${e.message || 'Unknown error'}`));
            if (res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end(`Bad Gateway: Unable to connect to target server after ${req._retryCount || 0} retries`);
            }
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
        .on('error', loopingListener)
        .on('proxyReq', (proxyReq, req) => {
            console.log(gray(`[${new Date().toISOString()}] Proxy ${bold(name)}: Forwarding request to ${req.method} ${req.url}`));
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
            console.log(green(`[${new Date().toISOString()}] Proxy ${bold(name)}: Response received - ${proxyRes.statusCode} ${req.method} ${req.url}`));
            res.getHeaderNames().forEach((name) => {
                console.log(blue(`Proxy-res ${bold(name)}:  ${res.getHeader(name)}`));
            });
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

    console.log(
        green(
            `Started ${isProxy(parsed) ? 'proxy' : bold(name)}: https://${hostname}:${source} → http://${hostname}:${target}`
        )
    );
    process.on('exit', (code) => {
        proxy.close();
        console.log(`Closed proxy ${bold(name)}`);
    });
}

process.on('SIGINT', () => {
    console.log('Received SIGINT');
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Received SIGTERM');
    process.exit(0);
});
process.on('exit', (code) => {
    const color = code === 0 ? blue : red;
    console.log(color(`Exiting with code: ${code}`));
});
