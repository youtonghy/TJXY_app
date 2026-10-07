#!/usr/bin/env node
// Starts the admin /app dev server (desktop shell build) and launches the
// Electron window once the port answers. Mirrors the old `tauri dev`
// beforeDevCommand/devUrl pair; the admin workspace defaults to the sibling
// checkout at ../TJXY/admin and can be overridden with TJXY_ADMIN_DIR.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { findAvailablePort } from './dev-port.mjs';
import { prepareFrontend } from '../../../scripts/prepare-frontend.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const adminDir = prepareFrontend();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(join(adminDir, 'package.json'))) {
  console.error(`admin workspace not found at ${adminDir}`);
  console.error('Set TJXY_ADMIN_DIR to the admin/ directory of a TJXY checkout.');
  process.exit(1);
}

// Electron no longer runs Cargo implicitly as `tauri dev` did. Build the
// helper before opening the shell and use that exact development binary.
const playerName = process.platform === 'win32' ? 'tjxy-player.exe' : 'tjxy-player';
const playerBin = process.env.TJXY_PLAYER_BIN
  ? resolve(process.env.TJXY_PLAYER_BIN)
  : join(desktopDir, 'target', 'debug', playerName);
if (!process.env.TJXY_PLAYER_BIN) {
  execFileSync('cargo', ['build', '--manifest-path', join(desktopDir, 'player', 'Cargo.toml')], {
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: join(desktopDir, 'target') },
  });
}
if (!existsSync(playerBin)) {
  console.error(`player binary not found at ${playerBin}`);
  process.exit(1);
}

const children = new Set();
function run(command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function shutdown(code) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

// Always start this checkout's frontend. An occupied port may belong to an
// unrelated app, or a TJXY frontend built for a different shell.
const DEV_PORT = await findAvailablePort();
const DEV_URL = `http://127.0.0.1:${DEV_PORT}/app/`;
console.log(`Desktop frontend: ${adminDir} -> ${DEV_URL}`);
const vite = run(npm, ['run', 'dev', '--', '--port', String(DEV_PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: adminDir,
  env: { ...process.env, VITE_TJXY_SHELL: 'desktop' },
});
vite.on('error', (error) => {
  console.error(error);
  shutdown(1);
});
vite.on('exit', (code) => shutdown(code || 1));

function waitForPort(port, deadline = Date.now() + 60_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolvePromise();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) rejectPromise(new Error(`dev server did not open port ${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

await waitForPort(DEV_PORT);
const app = run(String(electron), ['.'], {
  cwd: desktopDir,
  env: { ...process.env, TJXY_DEV_URL: DEV_URL, TJXY_PLAYER_BIN: playerBin },
});
app.on('exit', (code) => shutdown(code ?? 0));
