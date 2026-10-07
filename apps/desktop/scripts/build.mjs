#!/usr/bin/env node
// Full desktop build:
//   1. typecheck and build the admin /app frontend into apps/desktop/dist
//   2. compile the tjxy-player helper for the target platform
//   3. stage the helper plus its bundled runtime into player-bin/
//   4. run electron-builder (extra CLI args are passed through, e.g.
//      `node scripts/build.mjs --mac dmg`)
//
// The admin workspace defaults to ../TJXY/admin (override: TJXY_ADMIN_DIR).
// A non-host Rust target can be selected with TJXY_PLAYER_TARGET (requires a
// matching toolchain and runtime/<platform>/lib contents).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFrontend } from '../../../scripts/prepare-frontend.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const adminDir = process.env.TJXY_SKIP_FRONTEND ? '' : prepareFrontend();
const distDir = join(desktopDir, 'dist');
const playerDir = join(desktopDir, 'player');
const stageDir = join(desktopDir, 'player-bin');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const HOST_TARGET = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
}[`${process.platform}:${process.arch}`];
const playerTarget = process.env.TJXY_PLAYER_TARGET ?? HOST_TARGET;
const RUNTIME_DIRS = {
  'aarch64-apple-darwin': 'macos-aarch64',
  'x86_64-apple-darwin': 'macos-x86_64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
  'aarch64-pc-windows-msvc': 'windows-aarch64',
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
  'aarch64-unknown-linux-gnu': 'linux-aarch64',
};

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

if (!process.env.TJXY_SKIP_FRONTEND && !existsSync(join(adminDir, 'package.json'))) {
  console.error(`admin workspace not found at ${adminDir}`);
  console.error('Set TJXY_ADMIN_DIR to the admin/ directory of a TJXY checkout.');
  process.exit(1);
}

// 1. Frontend (the old beforeBuildCommand ran typecheck + vite build).
// CI downloads a shared dist artifact instead; TJXY_SKIP_FRONTEND skips this.
if (process.env.TJXY_SKIP_FRONTEND) {
  if (!existsSync(join(distDir, 'index.html'))) {
    console.error(`TJXY_SKIP_FRONTEND set but no dist at ${distDir}`);
    process.exit(1);
  }
} else {
  run(npm, ['run', 'typecheck'], { cwd: adminDir });
  run(npm, ['exec', '--', 'vite', 'build', '--outDir', distDir], {
    cwd: adminDir,
    env: { ...process.env, VITE_TJXY_SHELL: 'desktop' },
  });
}

// 2. Player helper: stage libmpv before the build (Windows needs mpv.lib at
// link time), then cargo build, then bundle the Linux shared-library closure.
if (!playerTarget) {
  console.warn(`\n> no player target for ${process.platform}/${process.arch}; skipping helper build`);
} else {
  run('node', [join(desktopDir, 'scripts', 'stage-runtime.mjs'), playerTarget]);
  run('cargo', ['build', '--release', '--target', playerTarget, '--manifest-path', join(playerDir, 'Cargo.toml')]);
}

// 3. Stage the helper binary plus the bundled runtime libraries.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
if (playerTarget) {
  const binary = playerTarget.includes('windows') ? 'tjxy-player.exe' : 'tjxy-player';
  const built = join(desktopDir, 'target', playerTarget, 'release', binary);
  if (!existsSync(built)) {
    console.error(`player binary missing at ${built}`);
    process.exit(1);
  }
  if (playerTarget.includes('linux')) {
    run('node', [join(desktopDir, 'scripts', 'stage-runtime.mjs'), playerTarget, '--deps', built]);
  }
  cpSync(built, join(stageDir, binary));
  const runtimeName = RUNTIME_DIRS[playerTarget];
  const runtimeLib = join(playerDir, 'runtime', runtimeName, 'lib');
  if (existsSync(runtimeLib)) {
    cpSync(runtimeLib, join(stageDir, 'runtime', runtimeName, 'lib'), { recursive: true });
  } else {
    console.warn(`> warning: no bundled runtime at ${runtimeLib}`);
  }
}

// 4. electron-builder (CLI args pass through). pnpm places package binaries
// in the workspace root .bin directory.
const builder = join(repoRoot, 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
run(builder, process.argv.slice(2), { cwd: desktopDir });
