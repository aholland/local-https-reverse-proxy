import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { bin, preferGlobal } from '../package.json';

test('Ensure that the bin is set to the correct path and is executable', async () => {
  spawnSync('pnpm', ['build'], { cwd: resolve(__dirname, '..') });

  await expect(access(bin, constants.R_OK | constants.X_OK)).resolves.not.toThrowError();
  expect(preferGlobal).toBe(true);
});
