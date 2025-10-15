# local-https-reverse-proxy

[![License](https://img.shields.io/npm/l/local-ssl-proxy.svg)](https://github.com/cameronhunter/local-ssl-proxy/blob/master/LICENSE.md)

**HTTPS reverse proxy** with SSL/TLS termination and path-based routing. Uses self-signed certificates for local development.

**This is an enhanced fork** of [cameronhunter/local-ssl-proxy](https://github.com/cameronhunter/local-ssl-proxy) with additional features for advanced development workflows.

## Key Enhancements

This fork adds:
- 🚀 **Path-based routing** - Route different URL paths to different backend services
- 🔀 **Alias support** - HTTP 301 redirects for alternate paths
- 📝 **Structured logging** - Uses `pino` for high-performance, configurable logging
- 🔄 **Smart retry logic** - Automatically retries connections during server startup
- 🎯 **WebSocket support** - Full WebSocket proxying with proper error handling
- ⚡ **http-proxy-3** - Modern TypeScript rewrite with memory leak fixes
- 📦 **Config management** - Support for `config.local.json` for personal settings
- 🎨 **Visual feedback** - Colored activity indicators in terminal
- ⚙️ **Defaults support** - Share common config across multiple proxies

## Quick Start

```sh
# Install dependencies
pnpm install

# Run with default config
pnpm start
```

## Usage

### Simple Proxy

Start a proxy from port `9001` to `9000`:

```sh
pnpm start
```

Or with a custom config file:

```sh
pnpm start --config my-config.json
```

Start your web server on the target port and navigate to `https://localhost:<source-port>`. You'll get a certificate warning because it's self-signed - this is safe to ignore during development.

### Configuration File

The proxy uses `config.local.json` if it exists, otherwise falls back to `config.json`. This allows you to:
- Keep `config.json` as a template in version control
- Use `config.local.json` for personal machine-specific settings (add to `.gitignore`)

#### Basic Configuration

```json
{
  "My proxy": {
    "source": 3001,
    "target": 3000,
    "key": "resources/localhost-key.pem",
    "cert": "resources/localhost.pem",
    "hostname": "localhost"
  }
}
```

#### Using Defaults

Share common configuration across multiple proxies:

```json
{
  "defaults": {
    "key": "resources/localhost-key.pem",
    "cert": "resources/localhost.pem",
    "hostname": "localhost",
    "logLevel": "info"
  },
  "Frontend": {
    "source": 3001,
    "target": 3000
  },
  "Backend": {
    "source": 4001,
    "target": 4000
  }
}
```

#### Path-Based Routing

Route different URL paths to different backend services:

```json
{
  "defaults": {
    "key": "resources/localhost-key.pem",
    "cert": "resources/localhost.pem",
    "hostname": "localhost"
  },
  "Multi-app": {
    "source": 5174,
    "target": 5173,
    "targets": {
      "api": {
        "path": "/api",
        "port": 3000
      },
      "admin": {
        "path": "/admin",
        "port": 8080,
        "aliases": ["/adm"]
      }
    }
  }
}
```

This configuration:
- Routes `https://localhost:5174/api/*` → `http://localhost:3000/api/*`
- Routes `https://localhost:5174/admin/*` → `http://localhost:8080/admin/*`
- Redirects `https://localhost:5174/adm/*` → `https://localhost:5174/admin/*` (HTTP 301)
- Routes all other paths to the default target: `https://localhost:5174/*` → `http://localhost:5173/*`

#### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | number | `target + 1000` | HTTPS port to listen on |
| `target` | number | required | HTTP port to forward to (for simple proxy) |
| `targets` | object | optional | Named targets for path-based routing |
| `key` | string | required | Path to SSL private key |
| `cert` | string | required | Path to SSL certificate |
| `hostname` | string | required | Hostname to bind to |
| `logLevel` | string | `'info'` | Log level: `'debug'`, `'info'`, `'warn'`, `'error'`, `'fatal'` |
| `maxRetryMs` | number | `1000` | Max time (ms) to retry failed connections |
| `retryIntervalMs` | number | `50` | Time (ms) between retry attempts |

#### Target Configuration

For path-based routing, each named target supports:

| Option | Type | Description |
|--------|------|-------------|
| `path` | string | URL path to match (e.g., `"/api"`) |
| `port` | number | Backend port to forward to |
| `aliases` | string[] | Alternate paths that redirect to main path |

**Note**: Aliases must not end with a slash (use `"/bid"` not `"/bid/"`).

## SSL Certificates

### Generate Trusted Certificates with mkcert

1. Install [mkcert](https://github.com/FiloSottile/mkcert):
   ```sh
   # macOS
   brew install mkcert

   # Windows
   choco install mkcert
   ```

2. Create and install local CA:
   ```sh
   mkcert -install
   ```

3. Generate certificates:
   ```sh
   # In the project directory
   pnpm renew-certs

   # Or manually
   cd resources
   mkcert localhost
   ```

4. Start the proxy - certificates in `resources/` will be used automatically

You can now access your proxied services without certificate warnings!

## Logging

The proxy uses [pino](https://github.com/pinojs/pino) for structured, high-performance logging:

```json
{
  "defaults": {
    "logLevel": "debug"
  }
}
```

**Log Levels:**
- `debug` - All requests, responses, and detailed diagnostics
- `info` - Startup, shutdown, and important events (default)
- `warn` - Warnings and recoverable errors
- `error` - Errors requiring attention
- `fatal` - Critical errors before process exit

**Visual Feedback:**
- 🟢 Green dots - Successful HTTP responses
- 🟡 Yellow dots - Vite dev server ping (filtered to reduce noise)

## Retry Logic

The proxy automatically retries connections when the target server isn't ready:

- Retries for up to `maxRetryMs` milliseconds (default: 1000ms)
- Waits `retryIntervalMs` between attempts (default: 50ms)
- ~20 retry attempts over 1 second by default
- Only retries on `ECONNREFUSED` errors (server not started yet)
- Returns `502 Bad Gateway` if target remains unavailable

This is particularly useful when starting multiple services concurrently.

## WebSocket Support

WebSockets are fully supported and automatically proxied:

- Proper upgrade handling for WebSocket connections
- Concurrent request deduplication for health checks
- Automatic retry logic for WebSocket connections
- Reduced logging noise for Vite dev tooling

## Development

```sh
# Install dependencies
pnpm install

# Run in development mode (uses ts-node)
pnpm start

# Build for production
pnpm build

# Run tests
pnpm test

# Clean build artifacts
pnpm clean
```

## Use Cases

This proxy is particularly useful for:
- **OAuth Development** - Testing OAuth flows that require HTTPS callbacks
- **PWA Development** - Service workers require HTTPS
- **Secure Cookies** - Testing httpOnly/secure cookie flags
- **Microservices** - Routing multiple backend services through a single HTTPS endpoint
- **External Webhooks** - Use with dynamic DNS to test webhook integrations
- **Multi-app Development** - Work on frontend and backend simultaneously with path-based routing

## Technical Details

- Built with TypeScript
- Uses `http-proxy-3` - modern rewrite with memory leak fixes
- Supports HTTP/1.1 and WebSocket protocols
- Automatic header rewriting for HTTPS ↔ HTTP conversion
- Graceful shutdown handling (SIGINT/SIGTERM)
- Concurrent health check deduplication for efficiency

## License

MIT - see [LICENSE](LICENSE) file for details

## Credits

Original project by [Cameron Hunter](https://github.com/cameronhunter)

This fork maintained by [Anthony Holland](https://github.com/aholland)
