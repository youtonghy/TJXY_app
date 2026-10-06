'use strict';
/**
 * Preload for the main window. Runs in the page world
 * (contextIsolation is off, matching the Tauri init-script model):
 *
 * - replaces window.fetch for http(s) URLs with an IPC bridge into the
 *   main process (`ses.fetch` on the persisted session, so cookies work
 *   exactly like the old tauri-plugin-http jar);
 * - exposes window.tjxyDesktop.playerOpen used by the play-route
 *   interception installed by intercept.js.
 *
 * `require` and `ipcRenderer` stay private to this file — only the two
 * wrappers below are assigned to window.
 */
const { ipcRenderer } = require('electron');

const nativeFetch = window.fetch.bind(window);

// ---------------------------------------------------------------- fetch

let fetchSequence = 0;
const fetchPending = new Map();

ipcRenderer.on('tjxy:fetch-chunk', (_event, id, payload) => {
  const entry = fetchPending.get(id);
  if (!entry) return;
  if (payload.error) {
    entry.error = payload.error;
  } else {
    if (payload.chunk?.byteLength) entry.chunks.push(payload.chunk);
    if (payload.done) entry.done = true;
  }
  drain(entry);
  if ((entry.error || (entry.done && entry.chunks.length === 0)) && entry.controller) {
    fetchPending.delete(id);
  }
});

function drain(entry) {
  const controller = entry.controller;
  if (!controller) return;
  if (entry.error) {
    try {
      controller.error(new Error(entry.error));
    } catch {
      // Stream already closed.
    }
    return;
  }
  while (entry.chunks.length > 0) {
    try {
      controller.enqueue(entry.chunks.shift());
    } catch {
      entry.chunks.length = 0;
      entry.done = true;
      return;
    }
  }
  if (entry.done) {
    try {
      controller.close();
    } catch {
      // Stream already closed.
    }
  }
}

function invokeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  // Strip Electron's "Error invoking remote method 'x': Error:" wrapper.
  return new Error(message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
}

window.fetch = function tjxyDesktopFetch(input, init) {
  let request;
  try {
    request = new Request(input, init);
  } catch {
    return nativeFetch(input, init);
  }
  let parsed;
  try {
    parsed = new URL(request.url);
  } catch {
    return nativeFetch(input, init);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return nativeFetch(input, init);
  }
  const id = `tjxy-fetch-${++fetchSequence}`;
  if (request.signal) {
    request.signal.addEventListener(
      'abort',
      () => ipcRenderer.send('tjxy:fetch-abort', id),
      { once: true },
    );
  }
  return (async () => {
    const body = await request.arrayBuffer();
    const entry = { controller: null, chunks: [], done: false, error: null };
    fetchPending.set(id, entry);
    const stream = new ReadableStream({
      start(controller) {
        entry.controller = controller;
        drain(entry);
        if (entry.done && entry.chunks.length === 0) fetchPending.delete(id);
      },
      cancel() {
        fetchPending.delete(id);
        ipcRenderer.send('tjxy:fetch-abort', id);
      },
    });
    let meta;
    try {
      meta = await ipcRenderer.invoke('tjxy:fetch', {
        id,
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: body.byteLength > 0 ? body : null,
      });
    } catch (error) {
      fetchPending.delete(id);
      throw invokeError(error);
    }
    const bodyless = request.method === 'HEAD' || meta.status === 204 || meta.status === 304;
    return new Response(bodyless ? null : stream, {
      status: meta.status,
      statusText: meta.statusText,
      headers: meta.headers,
    });
  })();
};

// ---------------------------------------------------------------- player

window.tjxyDesktop = {
  playerOpen(request) {
    return ipcRenderer.invoke('tjxy:player-open', request).catch((error) => {
      throw invokeError(error);
    });
  },
};

require('./intercept.js');
