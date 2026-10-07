'use strict';
/**
 * Electron main process for the TJXY desktop client.
 *
 * - Serves the bundled /app frontend over the privileged `tjxy-app` scheme
 *   (dev mode loads the Vite dev server instead).
 * - Bridges every http(s) window.fetch call through Chromium's network stack
 *   on the `persist:tjxy` session, which provides the persisted cookie jar
 *   that tauri-plugin-http used to supply.
 * - Spawns the `tjxy-player` helper binary for native mpv playback.
 */
const { app, BrowserWindow, ipcMain, net, protocol, session } = require('electron');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { dirname, extname, isAbsolute, join, relative, resolve } = require('node:path');
const { playerBinaryPath: findPlayerBinary } = require('./player-path.cjs');

const APP_SCHEME = 'tjxy-app';
const APP_PARTITION = 'persist:tjxy';
const SESSION_COOKIE = 'tjxy_session';
const DEV_URL = process.env.TJXY_DEV_URL || null;
const DESKTOP_DIR = resolve(__dirname, '..');
const DIST_DIR = join(DESKTOP_DIR, 'dist');
const PLAYER_TIMEOUT_MS = 5000;

// Same policy as the Tauri shell's csp (tauri-specific schemes dropped):
// remote API requests cross the IPC bridge rather than page fetch, so
// connect-src only needs the bundled origin and the dev-server loopback.
const CSP = [
  "default-src 'self'",
  "connect-src 'self' http://127.0.0.1:*",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' data: blob: http: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
].join('; ');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

const RUNTIME_TRIPLES = {
  'darwin:arm64': 'macos-aarch64',
  'darwin:x64': 'macos-x86_64',
  'win32:x64': 'windows-x86_64',
  'win32:arm64': 'windows-aarch64',
  'linux:x64': 'linux-x86_64',
  'linux:arm64': 'linux-aarch64',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);

function serveDist(request) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  let target = resolve(DIST_DIR, `.${pathname}`);
  const rel = relative(DIST_DIR, target);
  const escaped = rel.startsWith('..') || isAbsolute(rel);
  const isFile = !escaped && existsSync(target) && statSync(target).isFile();
  if (escaped) return new Response('bad request', { status: 400 });
  if (!isFile) {
    // History-API fallback for /app/... routes; real asset misses get a 404.
    if (extname(pathname)) return new Response('not found', { status: 404 });
    target = join(DIST_DIR, 'index.html');
  }
  let body;
  try {
    body = readFileSync(target);
  } catch {
    return new Response('not found', { status: 404 });
  }
  return new Response(body, {
    headers: {
      'content-type': MIME_TYPES[extname(target)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
    },
  });
}

// ---------------------------------------------------------------- fetch bridge

const fetchControllers = new Map();

/** Headers Chromium refuses or that would corrupt the hop are dropped. */
const BLOCKED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'referer',
]);

function filteredHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!BLOCKED_REQUEST_HEADERS.has(lower)) out[lower] = value;
  }
  return out;
}

function installFetchBridge(ses, webContents) {
  ipcMain.handle('tjxy:fetch', async (event, request) => {
    if (event.sender !== webContents) throw new Error('unknown sender');
    const { id, url, method, headers, body } = request ?? {};
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error('请求地址无效。');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('请求地址不被允许。');
    }
    const controller = new AbortController();
    fetchControllers.set(id, controller);
    let response;
    try {
      response = await ses.fetch(parsed.toString(), {
        method: typeof method === 'string' ? method : 'GET',
        headers: filteredHeaders(headers),
        body: body ? Buffer.from(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      fetchControllers.delete(id);
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    const responseHeaders = {};
    response.headers.forEach((value, name) => {
      // The HttpOnly session cookie must stay out of page JavaScript.
      if (name.toLowerCase() !== 'set-cookie') responseHeaders[name] = value;
    });
    if (response.body) {
      const reader = response.body.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!webContents.isDestroyed()) {
              webContents.send('tjxy:fetch-chunk', id, { chunk: value });
            }
          }
          if (!webContents.isDestroyed()) {
            webContents.send('tjxy:fetch-chunk', id, { done: true });
          }
        } catch (error) {
          if (!webContents.isDestroyed()) {
            webContents.send('tjxy:fetch-chunk', id, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          fetchControllers.delete(id);
        }
      })();
    } else {
      fetchControllers.delete(id);
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      redirected: response.redirected,
      url: parsed.toString(),
    };
  });
  ipcMain.on('tjxy:fetch-abort', (event, id) => {
    if (event.sender !== webContents) return;
    fetchControllers.get(id)?.abort();
  });
}

// ------------------------------------------------------------------ player

let playerChild = null;

function playerBinaryPath() {
  return findPlayerBinary({
    explicitPath: process.env.TJXY_PLAYER_BIN ? resolve(process.env.TJXY_PLAYER_BIN) : undefined,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDir: DESKTOP_DIR,
    platform: process.platform,
    arch: process.arch,
  });
}

/** Directory holding the bundled libmpv runtime for the current platform. */
function playerRuntimeDir() {
  const triple = RUNTIME_TRIPLES[`${process.platform}:${process.arch}`];
  if (!triple) return null;
  const root = app.isPackaged
    ? join(process.resourcesPath, 'player')
    : join(DESKTOP_DIR, 'player');
  const dir = join(root, 'runtime', triple, 'lib');
  return existsSync(dir) ? dir : null;
}

function playerEnv() {
  const env = { ...process.env };
  const libDir = playerRuntimeDir();
  if (!libDir) return env;
  // macOS resolves @rpath at link time; Windows and Linux search these vars.
  if (process.platform === 'win32') {
    env.PATH = `${libDir}${require('node:path').delimiter}${env.PATH ?? ''}`;
  } else if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${libDir}:${env.LD_LIBRARY_PATH}`
      : libDir;
  }
  return env;
}

/**
 * Writes a `shutdown` command and gives the helper a short window to flush
 * its final playback report and revoke the ticket before it is killed.
 */
async function stopPlayer() {
  const child = playerChild;
  playerChild = null;
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  } catch {
    // stdin may already be closed; fall through to the wait/kill.
  }
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((done) => setTimeout(() => done(false), PLAYER_TIMEOUT_MS)),
  ]);
  if (!exited && child.exitCode === null) child.kill('SIGKILL');
}

function installPlayerBridge(ses, webContents) {
  ipcMain.handle('tjxy:player-open', async (event, request) => {
    if (event.sender !== webContents) throw new Error('unknown sender');
    const serverOrigin = String(request?.serverOrigin ?? '');
    const itemId = String(request?.itemId ?? '');
    if (!itemId.trim()) throw new Error('缺少要播放的条目。');
    // A "remember me" session restored after a restart carries no token in
    // web storage; the access token is the value of the session cookie.
    let accessToken = String(request?.accessToken ?? '');
    if (!accessToken.trim()) {
      const cookies = await ses.cookies.get({ url: serverOrigin, name: SESSION_COOKIE });
      accessToken = cookies[0]?.value ?? '';
    }
    const bin = playerBinaryPath();
    if (!bin) throw new Error('当前桌面平台暂不支持内置播放器。');
    await stopPlayer();
    const child = spawn(bin, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: playerEnv(),
    });
    playerChild = child;
    child.on('exit', (code, signal) => {
      if (playerChild === child) playerChild = null;
      if (signal || code) console.log(`player exited (code=${code} signal=${signal})`);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) console.log(`player: ${line.trim()}`);
      }
    });
    child.stdin.write(
      JSON.stringify({ serverOrigin, accessToken, itemId }) + '\n',
    );
    // The helper reports {"type":"ready"} once its window is up, or
    // {"type":"error","message":...} / exits early on a bad request.
    const outcome = await new Promise((resolveOutcome) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        resolveOutcome({ ok: false, message: '播放器启动超时。' });
      }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
      };
      const finish = (value) => {
        cleanup();
        resolveOutcome(value);
      };
      const onData = (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === 'ready') finish({ ok: true });
        else if (event.type === 'error') finish({ ok: false, message: event.message });
      };
      const onExit = () => finish({ ok: false, message: '播放器启动失败。' });
      child.stdout.on('data', onData);
      child.on('exit', onExit);
    });
    if (!outcome.ok) {
      playerChild = null;
      if (child.exitCode === null) child.kill('SIGKILL');
      throw new Error(outcome.message || '播放器启动失败。');
    }
  });
}

// ------------------------------------------------------------------ window

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    title: 'TJXY',
    backgroundColor: '#101014',
    show: false,
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 560,
    icon: join(DESKTOP_DIR, 'icons', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // The preload must patch window.fetch and history in the page world,
      // matching what the Tauri js_init_script did.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      session: session.fromPartition(APP_PARTITION),
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The bundled client never opens windows; external links go nowhere.
    void url;
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL
      ? url.startsWith(new URL(DEV_URL).origin)
      : url.startsWith(`${APP_SCHEME}://`);
    if (!allowed) event.preventDefault();
  });
  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadURL(`${APP_SCHEME}://client/app/`);
  }
  return win;
}

// ---------------------------------------------------------------- lifecycle

let quitting = false;

app.whenReady().then(async () => {
  const ses = session.fromPartition(APP_PARTITION);
  await ses.protocol.handle(APP_SCHEME, serveDist);
  const win = createWindow();
  installFetchBridge(ses, win.webContents);
  installPlayerBridge(ses, win.webContents);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  // The player helper must finish its final report and revoke its ticket,
  // which must not block the quit path the renderer relies on.
  if (quitting || !playerChild || playerChild.exitCode !== null) return;
  quitting = true;
  event.preventDefault();
  void stopPlayer().finally(() => app.exit(0));
});
