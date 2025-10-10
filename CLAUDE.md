# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is local-ssl-proxy?

This is a local fork of the [local-ssl-proxy npm package](https://www.npmjs.com/package/local-ssl-proxy), adapted and maintained locally for personal development use. It creates HTTPS endpoints for local HTTP services and acts as a reverse proxy that:
- Accepts HTTPS connections on a specified port (source)
- Forwards requests to an HTTP service on another port (target)
- Handles SSL/TLS termination using provided certificates
- Supports WebSocket connections
- Automatically retries failed connections

This is particularly useful when:
- Testing OAuth flows that require HTTPS callbacks
- Developing PWAs that need HTTPS for service workers
- Testing secure cookies or other HTTPS-only features
- Simulating production HTTPS environments locally

## Commands

### Development
- `pnpm start` - Run the proxy with config.json (uses ts-node, no build required)
- `pnpm build` - Compile TypeScript to JavaScript (outputs to build/) and make binary executable
- `pnpm test` - Run all tests with Vitest
- `pnpm clean` - Clean build artifacts

### Certificate Management
- `pnpm renew-certs` - Regenerate SSL certificates in resources/ using mkcert

Note: The project requires Node.js 24.x (specified in package.json engines)

## Architecture

This is a local SSL proxy server that creates HTTPS endpoints for HTTP services during development.

### Key Components

1. **src/lib.ts** - CLI parsing and configuration handling
   - Defines `Proxy` type with required fields: hostname, source, target, cert, key
   - `parse()` function handles both CLI args and JSON config files
   - Supports single proxy or multi-proxy configurations

2. **src/main.ts** - Core proxy server implementation
   - Uses `http-proxy` library for proxying
   - Logs all proxy requests/responses with timestamps and colored output (gray/green/blue/red)
   - Error handling: Returns 502 Bad Gateway on ECONNREFUSED errors (src/main.ts:35-51)
   - Header modifications for HTTPS→HTTP conversion:
     - `origin` header: changes https: to http: (src/main.ts:69-72)
     - `referer` header: changes https: to http: (src/main.ts:73-76)
     - `location` response header: changes http: to https: (src/main.ts:83-86)
     - `access-control-allow-origin` response header: changes http: to https: (src/main.ts:87-90)
   - Supports WebSocket connections (ws: true)
   - Handles graceful shutdown via SIGINT/SIGTERM signals (src/main.ts:105-116)

### Configuration

The proxy expects SSL certificate paths. When paths start with `~`, Node.js doesn't expand them automatically - use full paths instead.

Configuration supports both single proxy and multi-proxy setups:

**Multi-proxy config.json:**
```json
{
  "My proxy": {
    "source": 3001,
    "target": 3000,
    "key": "/full/path/to/key.pem",
    "cert": "/full/path/to/cert.pem",
    "hostname": "localhost"
  },
  "Another proxy": {
    "source": 4001,
    "target": 4000,
    "key": "/full/path/to/key.pem",
    "cert": "/full/path/to/cert.pem",
    "hostname": "localhost"
  }
}
```

**Defaults support** (src/main.ts:12-35):
- A `defaults` key can be used to provide shared configuration
- Individual proxies inherit from defaults but can override specific values
- `source` defaults to `target + 1000` if not specified
- Required fields: `key`, `cert`, `hostname`, `target`

**Retry configuration** (src/main.ts:34-35):
- `maxRetryMs` (default: 1000): Maximum time in milliseconds to retry failed connections
- `retryInterval` (default: 50): Time in milliseconds between retry attempts
- Retries only occur for ECONNREFUSED errors (target server not yet started)
- With defaults: ~20 retry attempts over 1 second to catch servers during startup
- Much faster than previous implementation which took ~10 seconds

### How to use this proxy

This proxy is run directly from its source directory in IntelliJ IDEA:

1. **Open in IDEA**: Keep this project open in IntelliJ IDEA for easy debugging and modifications

2. **Configure**: Edit config.json with your proxy settings (multiple proxies supported)

3. **Run**: Execute `pnpm start` in the terminal to start all configured proxies

4. **Access**: Your HTTP services are now available via HTTPS on the configured source ports

### Typical workflow

1. Start your HTTP development server (e.g., on port 3000)
2. Run `pnpm start` in this proxy project
3. Access your app via HTTPS (e.g., https://localhost:3001)
4. The proxy handles SSL termination and forwards to your HTTP service

### Common Issues

- **Certificate errors**: Ensure certificates are trusted by your system (mkcert handles this)
- **Port conflicts**: Check that source ports aren't already in use
- **Connection refused**: The proxy will retry connections, but ensure target service is running
- **Path expansion**: Always use full paths for certificates, not `~` shortcuts

### Testing

Tests use Vitest and are located in test/:
- `test/lib.test.ts` - Unit tests for configuration parsing
- `test/functional.test.ts` - Tests that built binary is executable

No linting configuration exists in the project.