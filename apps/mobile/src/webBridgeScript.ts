// Injected into the bundled /app web bundle before any page script runs.
// - routes http(s) fetch() through React Native networking (the page runs from
//   a local bundle origin; the TJXY server sends no CORS headers)
// - fetch responses arrive back as window/document 'message' events posted by
//   the native side via WebView.postMessage
// - app-level messages (tjxy-*) pass through untouched for the web bundle's own
//   nativeBridge listener
export const BRIDGE_SCRIPT = String.raw`
(function () {
  if (window.__tjxyBridgeInstalled) return;
  window.__tjxyBridgeInstalled = true;

  var pending = new Map();
  var sequence = 0;

  function emit(message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

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
})();
`;
