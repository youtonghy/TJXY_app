// Injected before the bundled /app client runs. Navigations to the web player
// route (/app/play/:id) never reach React Router: the item id and the current
// session are handed to the dedicated native player window instead, and the
// page stays where it was. Session values are read from the storage keys the
// /app client writes (tjxy.api.baseUrl, tjxy.web.token). The token is empty
// for a "remember me" session restored after a restart; the main process then
// falls back to the persisted session cookie.
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

  function showError(message) {
    console.error('[tjxy-player] ' + message);
    var notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    notice.textContent = '无法启动播放器：' + message;
    notice.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;'
      + 'max-width:min(560px,90vw);padding:12px 16px;border-radius:10px;background:rgba(20,20,20,.92);'
      + 'color:#fff;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);';
    (document.body || document.documentElement).appendChild(notice);
    setTimeout(function () { notice.remove(); }, 6000);
  }

  function openNativePlayer(target) {
    if (!window.tjxyDesktop || typeof window.tjxyDesktop.playerOpen !== 'function') {
      showError('桌面运行时不可用。');
      return;
    }
    var request = {
      serverOrigin: window.localStorage.getItem('tjxy.api.baseUrl') || '',
      accessToken: window.sessionStorage.getItem('tjxy.web.token') || '',
      itemId: target.itemId,
    };
    window.tjxyDesktop.playerOpen(request).catch(function (error) {
      showError(typeof error === 'string' ? error : (error && error.message) || '未知错误');
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
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', function () { openNativePlayer(initial); }, { once: true });
    } else {
      openNativePlayer(initial);
    }
  }
})();
