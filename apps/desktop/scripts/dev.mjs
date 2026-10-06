#!/usr/bin/env node
// Starts the admin /app dev server (desktop shell build) and launches the
// Electron window once the port answers. Mirrors the old `tauri dev`
// beforeDevCommand/devUrl pair; the admin workspace defaults to the sibling
// checkout at ../TJXY/admin and can be overridden with TJXY_ADMIN_DIR.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const adminDir = resolve(process.env.TJXY_ADMIN_DIR ?? join(repoRoot, '..', 'TJXY', 'admin'));
const DEV_PORT = 5174;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}/app/`;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(join(adminDir, 'package.json'))) {
  console.error(`admin workspace not found at ${adminDir}`);
  console.error('Set TJXY_ADMIN_DIR to the admin/ directory of a TJXY checkout.');
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

function portIsOpen(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.end(); resolvePort(true); });
    socket.once('error', () => { socket.destroy(); resolvePort(false); });
  });
}

let vite;
if (!(await portIsOpen(DEV_PORT))) {
  vite = run(npm, ['run', 'dev', '--', '--port', String(DEV_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: adminDir,
    env: { ...process.env, VITE_TJXY_SHELL: 'desktop' },
  });
  vite.on('exit', (code) => {
    if (code && code !== 0) shutdown(code);
  });
}

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
  env: { ...process.env, TJXY_DEV_URL: DEV_URL },
});
app.on('exit', (code) => shutdown(code ?? 0));
