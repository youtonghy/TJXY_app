// Injected before the bundled /app client runs. Navigations to the web player
// route (/app/play/:id) never reach React Router: the item id and the current
// session are handed to the dedicated native player window instead, and the
// page stays where it was. Session values are read from the storage keys the
// /app client writes (tjxy.api.baseUrl, tjxy.web.token).
(function () {
  if (window.__tjxyPlayerInterceptInstalled) return;
  window.__tjxyPlayerInterceptInstalled = true;

  var PLAY_ROUTE = /^\/app\/play\/([^/?#]+)\/?$/;

  function playTarget(url) {
    var parsed;
    try {
      parsed = new URL(String(url), window.location.href);
    } catch (error) {
      return null;
    }
    if (parsed.origin !== window.location.origin) return null;
    var match = PLAY_ROUTE.exec(parsed.pathname);
    if (!match) return null;
    return { itemId: decodeURIComponent(match[1]), search: parsed.search };
  }

  function openNativePlayer(target) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      window.alert('无法启动播放器：桌面运行时不可用。');
      return;
    }
    var request = {
      serverOrigin: window.localStorage.getItem('tjxy.api.baseUrl') || '',
      accessToken: window.sessionStorage.getItem('tjxy.web.token') || '',
      itemId: target.itemId,
    };
    internals.invoke('desktop_player_open', { request: request }).catch(function (error) {
      window.alert('无法启动播放器：' + (typeof error === 'string' ? error : (error && error.message) || '未知错误'));
    });
  }

  function intercept(method) {
    var original = window.history[method];
    window.history[method] = function (state, title, url) {
      var target = url == null ? null : playTarget(url);
      if (!target) return original.apply(this, arguments);
      openNativePlayer(target);
    };
    return original;
  }

  intercept('pushState');
  var replaceState = intercept('replaceState');

  // A reload while on the player route: fall back to the item page before the
  // app boots, then open the player once the page is ready.
  var initial = playTarget(window.location.href);
  if (initial) {
    var params = new URLSearchParams(initial.search);
    var libraryId = params.get('libraryId');
    replaceState.call(
      window.history,
      window.history.state,
      '',
      '/app/items/' + encodeURIComponent(initial.itemId) + (libraryId ? '?libraryId=' + encodeURIComponent(libraryId) : ''),
    );
    window.addEventListener('DOMContentLoaded', function () { openNativePlayer(initial); }, { once: true });
  }
})();
