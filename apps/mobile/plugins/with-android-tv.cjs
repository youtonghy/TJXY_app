const { withAndroidManifest, withMainActivity } = require('expo/config-plugins');

module.exports = function withAndroidTv(config) {
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest['uses-feature'] ||= [];
    for (const name of ['android.software.leanback', 'android.hardware.touchscreen', 'android.hardware.camera', 'android.hardware.camera.autofocus']) {
      const feature = manifest['uses-feature'].find((entry) => entry.$['android:name'] === name);
      if (feature) feature.$['android:required'] = 'false';
      else manifest['uses-feature'].push({ $: { 'android:name': name, 'android:required': 'false' } });
    }
    const activity = manifest.application[0].activity.find((entry) => entry.$['android:name'] === '.MainActivity');
    const launcher = activity['intent-filter'].find((entry) => entry.action?.some((action) => action.$['android:name'] === 'android.intent.action.MAIN'));
    if (!launcher.category.some((entry) => entry.$['android:name'] === 'android.intent.category.LEANBACK_LAUNCHER')) {
      launcher.category.push({ $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } });
    }
    return mod;
  });
  return withMainActivity(config, (mod) => {
    if (mod.modResults.contents.includes('dispatchTvRemoteKey')) return mod;
    mod.modResults.contents = mod.modResults.contents.replace('class MainActivity : ReactActivity() {', `class MainActivity : ReactActivity() {
  private fun visibleTvWebView(view: android.view.View): android.webkit.WebView? {
    if (!view.isShown) return null
    if (view is android.webkit.WebView) return view
    if (view is android.view.ViewGroup) {
      for (index in 0 until view.childCount) {
        val found = visibleTvWebView(view.getChildAt(index))
        if (found != null) return found
      }
    }
    return null
  }

  private fun dispatchTvRemoteKey(event: android.view.KeyEvent): Boolean {
    val mode = resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_TYPE_MASK
    if (mode != android.content.res.Configuration.UI_MODE_TYPE_TELEVISION) return false
    val key = when (event.keyCode) {
      android.view.KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
      android.view.KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
      android.view.KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
      android.view.KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
      else -> return false
    }
    val web = visibleTvWebView(window.decorView) ?: return false
    val type = if (event.action == android.view.KeyEvent.ACTION_DOWN) "keydown" else "keyup"
    web.evaluateJavascript("document.activeElement.dispatchEvent(new KeyboardEvent('$type',{key:'$key',bubbles:true,cancelable:true}));", null)
    return true
  }

  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (dispatchTvRemoteKey(event)) return true
    return super.dispatchKeyEvent(event)
  }
`);
    return mod;
  });
};
