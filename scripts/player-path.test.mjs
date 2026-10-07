import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { playerBinaryPath } = require('../apps/desktop/electron/player-path.cjs');

test('finds target-triple development builds before legacy target paths', async () => {
  const desktopDir = await mkdtemp(join(tmpdir(), 'tjxy-player-path-'));
  const target = join(desktopDir, 'target', 'aarch64-apple-darwin', 'release');
  const legacy = join(desktopDir, 'target', 'release');
  await mkdir(target, { recursive: true });
  await mkdir(legacy, { recursive: true });
  const targetBinary = join(target, 'tjxy-player');
  const legacyBinary = join(legacy, 'tjxy-player');
  await writeFile(targetBinary, 'target');
  await writeFile(legacyBinary, 'legacy');

  assert.equal(playerBinaryPath({
    packaged: false,
    desktopDir,
    platform: 'darwin',
    arch: 'arm64',
  }), targetBinary);
});

test('uses the packaged resources directory for installed builds', async () => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'tjxy-player-resources-'));
  const playerDir = join(resourcesPath, 'player');
  await mkdir(playerDir, { recursive: true });
  const binary = join(playerDir, 'tjxy-player');
  await writeFile(binary, 'packaged');

  assert.equal(playerBinaryPath({
    packaged: true,
    resourcesPath,
    desktopDir: '/unused',
    platform: 'darwin',
    arch: 'arm64',
  }), binary);
});
