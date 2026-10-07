// Injected into the bundled /app web bundle before any page script runs.
// - routes http(s) fetch() through React Native networking (the page runs from
//   a local bundle origin; the TJXY server sends no CORS headers)
// - fetch responses arrive back as window/document 'message' events posted by
//   the native side via WebView.postMessage
// - app-level messages (tjxy-*) pass through untouched for the web bundle's own
//   nativeBridge listener
// - navigation to /app/play/:id never reaches the web PlayerPage: it is posted
//   to native as tjxy-native-play and the native player does the rest
export const BRIDGE_SCRIPT = String.raw`
(function () {
  // Android TV uses a 960x540 WebView viewport on the 4K emulator. Keep the
  // existing responsive web client usable with a remote without changing its
  // phone/tablet layout.
  if (window.__TJXY_TV_MODE__ && document.readyState !== 'loading' && !window.__tjxyTvInstalled) {
  window.__tjxyTvInstalled = true;
  var tvStyle = document.createElement('style');
  tvStyle.textContent = [
    ':root[data-tjxy-tv="true"] * { scroll-margin-block: 12vh; }',
    ':root[data-tjxy-tv="true"] :focus { outline: 3px solid #62a8ff !important; outline-offset: 4px !important; box-shadow: 0 0 0 7px rgba(98,168,255,.28) !important; }',
    ':root[data-tjxy-tv="true"] #root > div:has(> main > section input[name="server"]) { padding: 20px !important; }',
    ':root[data-tjxy-tv="true"] main:has(> section input[name="server"]) { max-width: 900px !important; min-height: calc(100vh - 40px) !important; align-items: flex-start !important; }',
    ':root[data-tjxy-tv="true"] section:has(input[name="server"]) { padding: 24px !important; display: grid; grid-template-columns: 1fr 1fr; column-gap: 40px; }',
    ':root[data-tjxy-tv="true"] section:has(input[name="server"]) > div.mb-8 { margin-bottom: 8px !important; grid-column: 1; }',
    ':root[data-tjxy-tv="true"] section:has(input[name="server"]) > h1, :root[data-tjxy-tv="true"] section:has(input[name="server"]) > p { grid-column: 1; }',
    ':root[data-tjxy-tv="true"] section:has(input[name="server"]) > .mt-5 { grid-column: 1; margin-top: 14px !important; }',
    ':root[data-tjxy-tv="true"] section:has(input[name="server"]) > .tabs { grid-column: 2; grid-row: 1 / span 6; margin-top: 48px !important; }',
    ':root[data-tjxy-tv="true"] input:not([type="checkbox"]), :root[data-tjxy-tv="true"] button, :root[data-tjxy-tv="true"] [role="tab"], :root[data-tjxy-tv="true"] [role="option"] { min-height: 44px; }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(tvStyle);
  if (window.__TJXY_TV_MODE__) document.documentElement.dataset.tjxyTv = 'true';
  function focusTvStart() {
    if (!tvStyle.isConnected) (document.head || document.documentElement).appendChild(tvStyle);
    if (window.__TJXY_TV_MODE__) document.documentElement.dataset.tjxyTv = 'true';
    if (!window.__TJXY_TV_MODE__ || document.activeElement !== document.body) return;
    var first = document.querySelector('input[name="server"], button[type="submit"], input, button');
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
  }
  document.addEventListener('DOMContentLoaded', function () { window.setTimeout(focusTvStart, 250); }, { once: true });
  window.setTimeout(focusTvStart, 250);
  window.setTimeout(function () {
    if (window.__TJXY_TV_MODE__) document.documentElement.dataset.tjxyTv = 'true';
  }, 0);
  var focusObserver = new MutationObserver(function () {
    if (document.querySelector('input[name="server"], a[href]')) {
      focusTvStart();
      focusObserver.disconnect();
    }
  });
  focusObserver.observe(document.documentElement, { childList: true, subtree: true });
  var tvNavigationStarted = false;
  document.addEventListener('keydown', function (event) {
    if (!tvStyle.isConnected) (document.head || document.documentElement).appendChild(tvStyle);
    document.documentElement.dataset.tjxyTv = 'true';
    if (!/^Arrow(Up|Down|Left|Right)$/.test(event.key)) return;
    if (!tvNavigationStarted && document.querySelector('input[name="server"]')) {
      tvNavigationStarted = true;
      document.querySelector('input[name="server"]').focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    var current = document.activeElement;
    if (!current || current === document.body) { focusTvStart(); event.preventDefault(); return; }
    // React Aria owns arrows inside menus and roving-tabindex controls.
    if (current && current.closest('[role="listbox"], [role="menu"]')) return;
    if (current && current.closest('[role="tablist"]') && /Arrow(Left|Right)/.test(event.key)) return;
    var candidates = Array.from(document.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')).filter(function (element) {
      var rect = element.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8 && !element.closest('[aria-hidden="true"], [inert]') && getComputedStyle(element).visibility !== 'hidden';
    });
    var origin = current && current !== document.body ? current.getBoundingClientRect() : null;
    if (!origin) { focusTvStart(); event.preventDefault(); return; }
    var horizontal = /Arrow(Left|Right)/.test(event.key);
    var sign = /Arrow(Right|Down)/.test(event.key) ? 1 : -1;
    var best = null;
    var bestScore = Infinity;
    candidates.forEach(function (element) {
      if (element === current) return;
      var rect = element.getBoundingClientRect();
      var dx = (rect.left + rect.right - origin.left - origin.right) / 2;
      var dy = (rect.top + rect.bottom - origin.top - origin.bottom) / 2;
      var forward = (horizontal ? dx : dy) * sign;
      if (forward < 4) return;
      var cross = Math.abs(horizontal ? dy : dx);
      var score = forward + cross * 3;
      if (score < bestScore) { best = element; bestScore = score; }
    });
    if (best) {
      event.preventDefault();
      event.stopPropagation();
      best.focus();
    }
  }, true);
  document.addEventListener('focusin', function (event) {
    if (window.__TJXY_TV_MODE__ && event.target instanceof HTMLElement) {
      event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
  }
  if (window.__tjxyBridgeInstalled) return;
  window.__tjxyBridgeInstalled = true;
  if (window.location.protocol === 'file:' && !window.location.hash) {
    window.location.hash = '/app/';
  }

  var pending = new Map();
  var sequence = 0;

  function emit(message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  window.addEventListener('error', function (event) {
    if (!event.error) return;
    emit({ kind: 'tjxy-web-error', message: String(event.error && (event.error.stack || event.error.message) || event.message || 'Page script failed.') });
  });

  window.addEventListener('load', function () {
    window.setTimeout(function () {
      var root = document.getElementById('root');
      if (!root || !root.hasChildNodes()) {
        emit({ kind: 'tjxy-web-error', message: 'Application did not render.' });
      }
    }, 15000);
  }, { once: true });

  function onMessage(event) {
    var data = event && event.data;
    if (typeof data !== 'string') return;
    var message;
    try { message = JSON.parse(data); } catch (error) { return; }
    if (!message || message.kind !== 'tjxy-fetch') return;
    var entry = pending.get(message.id);
    if (!entry) return;
    if (message.phase === 'headers') {
      var init = {
        status: message.status,
        statusText: message.statusText || '',
        headers: new Headers(message.headers || {}),
      };
      if (message.status === 101 || message.status === 204 || message.status === 205 || message.status === 304) {
        entry.resolve(new Response(null, init));
        pending.delete(message.id);
        return;
      }
      entry.resolve(new Response(new ReadableStream({
        start: function (controller) { entry.controller = controller; },
        cancel: function () { emit({ kind: 'tjxy-fetch-abort', id: message.id }); },
      }), init));
    } else if (message.phase === 'chunk' && entry.controller) {
      var binary = atob(message.data);
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      entry.controller.enqueue(bytes);
    } else if (message.phase === 'end') {
      if (entry.controller) entry.controller.close();
      pending.delete(message.id);
    } else if (message.phase === 'error') {
      var failure = new Error(message.message || 'Request failed.');
      if (entry.controller) entry.controller.error(failure);
      else entry.reject(failure);
      pending.delete(message.id);
    }
  }

  window.addEventListener('message', onMessage);
  document.addEventListener('message', onMessage);

  function toBase64(bytes) {
    var binary = '';
    for (var offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  // Binary request bodies cannot cross the postMessage bridge as JSON, so
  // they are base64-encoded and decoded back to bytes on the native side.
  function encodeBody(body, done) {
    if (body === undefined || body === null || typeof body === 'string') {
      done({ body: body == null ? null : body });
      return;
    }
    var bytes = null;
    if (body instanceof ArrayBuffer) {
      bytes = new Uint8Array(body);
    } else if (ArrayBuffer.isView(body)) {
      bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (bytes) {
      done({ bodyBase64: toBase64(bytes) });
      return;
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      body.arrayBuffer().then(function (buffer) {
        done({ bodyBase64: toBase64(new Uint8Array(buffer)) });
      }, function () {
        done({ body: null });
      });
      return;
    }
    try { done({ body: String(body) }); } catch (error) { done({ body: null }); }
  }

  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url;
    try {
      url = new URL(typeof input === 'string' ? input : input.url, window.location.href).href;
    } catch (error) {
      return originalFetch(input, init);
    }
    if (!/^https?:/i.test(url)) return originalFetch(input, init);
    init = init || {};
    var headers = {};
    var merged = new Headers(init.headers || (typeof input === 'object' && input && input.headers ? input.headers : undefined) || {});
    merged.forEach(function (value, key) { headers[key] = value; });
    var id = 'tjxy-fetch-' + String(++sequence);
    if (init.signal) {
      init.signal.addEventListener('abort', function () {
        emit({ kind: 'tjxy-fetch-abort', id: id });
      }, { once: true });
    }
    return new Promise(function (resolve, reject) {
      encodeBody(init.body, function (payload) {
        pending.set(id, { resolve: resolve, reject: reject, controller: null });
        emit({
          kind: 'tjxy-fetch',
          id: id,
          url: url,
          method: init.method || 'GET',
          headers: headers,
          body: payload.body == null ? null : payload.body,
          bodyBase64: payload.bodyBase64,
        });
      });
    });
  };

  // Playback is native-only. BrowserRouter re-reads window.location after it
  // calls pushState/replaceState, so swallowing a /app/play/:id navigation keeps
  // the page on its current route and PlayerPage never mounts. The session is
  // read from the web client's own storage keys, so these must stay in sync
  // with the web bundle: localStorage 'tjxy.api.baseUrl' (server origin),
  // sessionStorage 'tjxy.web.token' (access token) and localStorage
  // 'tjxy.web.deviceId' (device id).
  var PLAY_PATH = /^\/app\/play\/([^\/?#]+)\/?$/;

  function readStorage(storage, key) {
    try { return storage.getItem(key) || undefined; } catch (error) { return undefined; }
  }

  function matchPlay(target) {
    if (target === undefined || target === null) return null;
    var url;
    try { url = new URL(String(target), window.location.href); } catch (error) { return null; }
    if (url.protocol === 'file:' && url.hash.startsWith('#/')) {
      url = new URL(url.hash.slice(1), 'http://tjxy.app');
    }
    var match = PLAY_PATH.exec(url.pathname);
    if (!match) return null;
    var itemId;
    try { itemId = decodeURIComponent(match[1]); } catch (error) { itemId = match[1]; }
    return { itemId: itemId, libraryId: url.searchParams.get('libraryId') || undefined };
  }

  function requestNativePlay(play) {
    emit({
      type: 'tjxy-native-play',
      payload: {
        itemId: play.itemId,
        libraryId: play.libraryId,
        session: {
          serverOrigin: readStorage(window.localStorage, 'tjxy.api.baseUrl'),
          accessToken: readStorage(window.sessionStorage, 'tjxy.web.token'),
          deviceId: readStorage(window.localStorage, 'tjxy.web.deviceId'),
        },
      },
    });
  }

  var originalPushState = window.history.pushState;
  var originalReplaceState = window.history.replaceState;

  window.history.pushState = function (state, title, url) {
    var play = matchPlay(url);
    if (play) {
      requestNativePlay(play);
      return;
    }
    return originalPushState.apply(window.history, arguments);
  };

  window.history.replaceState = function (state, title, url) {
    var play = matchPlay(url);
    if (play) {
      requestNativePlay(play);
      return;
    }
    return originalReplaceState.apply(window.history, arguments);
  };

  var initialPlay = matchPlay(window.location.href);
  if (initialPlay) {
    var itemPath = '/app/items/' + encodeURIComponent(initialPlay.itemId)
      + (initialPlay.libraryId ? '?libraryId=' + encodeURIComponent(initialPlay.libraryId) : '');
    originalReplaceState.call(window.history, window.history.state, '', window.location.protocol === 'file:' ? '#' + itemPath : itemPath);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { requestNativePlay(initialPlay); }, { once: true });
    } else {
      requestNativePlay(initialPlay);
    }
  }
})();
`;
