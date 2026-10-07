'use strict';

const { existsSync } = require('node:fs');
const { join } = require('node:path');

const HOST_TARGETS = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
};

function playerBinaryPath({
  explicitPath,
  packaged,
  resourcesPath,
  desktopDir,
  platform,
  arch,
}) {
  const name = platform === 'win32' ? 'tjxy-player.exe' : 'tjxy-player';
  if (explicitPath) {
    const candidate = explicitPath;
    return existsSync(candidate) ? candidate : null;
  }
  const candidates = packaged
    ? [join(resourcesPath, 'player', name)]
    : [
        join(desktopDir, 'target', HOST_TARGETS[`${platform}:${arch}`] ?? '', 'release', name),
        join(desktopDir, 'target', HOST_TARGETS[`${platform}:${arch}`] ?? '', 'debug', name),
        join(desktopDir, 'target', 'release', name),
        join(desktopDir, 'target', 'debug', name),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

module.exports = { HOST_TARGETS, playerBinaryPath };
