import { createCommand } from 'commander';
import { resolve, isAbsolute } from 'path';
import * as fs from 'fs';

const { name, version } = require('../package.json');

const exists = (path: string) => {
  fs.accessSync(absolutePath(path));
  return path;
};

const absolutePath = (path: string) => (isAbsolute(path) ? path : resolve(process.cwd(), path));
const parseInteger = (value: string) => parseInt(value, 10);

const getDefaultConfigPath = () => {
  const localConfig = resolve(process.cwd(), 'config.local.json');
  const defaultConfig = resolve(process.cwd(), 'config.json');

  if (fs.existsSync(localConfig)) {
    return localConfig;
  }
  return defaultConfig;
};

const program = createCommand(name)
  .version(version, '-v, --version', 'show version number')
  .option('-n, --hostname <hostname>', 'hostname for the server', 'localhost')
  .option('-s, --source <source>', 'source port for the server', parseInteger, 9001)
  .option('-t, --target <target>', 'target port for the server', parseInteger, 9000)
  .option(
    '-c, --cert <cert>',
    'path to SSL certificate',
    exists,
    resolve(__dirname, '..', 'resources', 'localhost.pem')
  )
  .option('-k, --key <key>', 'path to SSL key', exists, resolve(__dirname, '..', 'resources', 'localhost-key.pem'))
  .option('-o, --config <config>', 'path to configuration file', (path) => require(absolutePath(path)), () => require(getDefaultConfigPath()));

type TargetRoute = {
  path: string;
  port: number;
  aliases?: string[];
};

type Proxy = {
  hostname: string;
  source: number;
  target?: number;  // Single target (fallback) - optional now
  targets?: Record<string, TargetRoute>;  // Named targets with path routing
  cert: string;
  key: string;
  maxRetryMs?: number;
  retryIntervalMs?: number;
};

type Config = { config: Record<string, Proxy> };
type ParsedArguments = Proxy | Config;

function isConfig(args: unknown): args is Config {
  return Boolean(args && typeof args === 'object' && 'config' in args);
}

export function isProxy(input: unknown): input is Proxy {
  if (
    !input ||
    typeof input !== 'object' ||
    !('hostname' in input) ||
    typeof input.hostname !== 'string' ||
    !('source' in input) ||
    typeof input.source !== 'number' ||
    !('cert' in input) ||
    typeof input.cert !== 'string' ||
    !('key' in input) ||
    typeof input.key !== 'string'
  ) {
    return false;
  }

  // Must have either target or targets
  const hasTarget = 'target' in input && typeof input.target === 'number';
  const hasTargets = 'targets' in input && typeof input.targets === 'object' && input.targets !== null && !Array.isArray(input.targets);

  return hasTarget || hasTargets;
}

export function parse(args?: string[]): Proxy | Record<string, Proxy> {
  const proxy: ParsedArguments =
    args === undefined ? program.parse().opts() : program.parse(args, { from: 'user' }).opts();

  return isConfig(proxy) ? proxy.config : proxy;
}
