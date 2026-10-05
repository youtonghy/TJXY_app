# TJXY App

Native clients for the TJXY **`/app` media client only**. This repository does not include `/admin` or `/setup`.

Package manager: **pnpm** (see `packageManager` in the root `package.json`).

## Requirements

- A running TJXY server (default `http://127.0.0.1:8096`)
- Node.js 22+ and pnpm 10
- For mobile: an Expo SDK 57-compatible Expo Go, or a local iOS/Android toolchain
- Android release builds require JDK 17 and Android SDK 36
- HeroUI Native Pro credentials via environment (`HEROUI_AUTH_TOKEN` / `HEROUI_KEY`) when installing Pro packages — do not commit keys

## Workspace

- `packages/client-api` — shared fetch client (configurable origin)
- `apps/mobile` — Expo shell around the bundled `/app` web frontend + native player
- `apps/desktop` — Tauri 2 wrapping the same bundled `/app` frontend + native mpv player

Both shells bundle the sibling `../TJXY/admin` `/app` UI locally and only load
runtime data (catalog, account, images, media streams) from the configured
server at runtime. The admin workspace is selected with `TJXY_ADMIN_DIR` and
defaults to `../TJXY/admin`.

From the repo root:

```sh
pnpm install
pnpm sync:frontend
```

`pnpm sync:frontend` builds the frontend twice — `VITE_TJXY_SHELL=desktop` into
`apps/desktop/dist` and `VITE_TJXY_SHELL=mobile` into a single-file
`apps/mobile/assets/web/app.html` — and is required once before the first
mobile run and after every frontend update. Both output directories are
gitignored and never overwrite the server's web assets in `../TJXY/admin/dist`.

## Mobile

```sh
pnpm --filter mobile start
```

Use `pnpm --filter mobile android` when running through Android Studio or an
Android device. Before Expo starts, the command automatically applies the
following mapping to every authorized device:

```sh
adb reverse tcp:8096 tcp:8096
```

The default `http://127.0.0.1:8096` origin therefore reaches the TJXY server on
the development Mac. TV and keyboard navigation show a blue focus outline on
actionable buttons.

The mobile app uses Expo SDK 57 with React Native 0.86. Android builds include
`armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`. If pnpm reports that the Skia
install script was skipped, install its prebuilt native libraries before building:

```sh
pnpm exec install-skia
cd apps/mobile/android
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk NODE_ENV=production ./gradlew app:assembleRelease
```

The release APK is written to
`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

On first launch the bundled web frontend shows its login screen; enter the server origin, then
sign in. All browsing (home, libraries, search, rankings, AI chat, profile) happens inside the
WebView and looks identical to the web `/app` client; only API data, images, and media streams
come from the network. Because the app serves the frontend from a local bundle, API requests are
forwarded through a native fetch bridge (the server sends no CORS headers).

Playback never uses the web player. The injected bridge script intercepts the web client's
navigation to `/app/play/:id` (its `history.pushState`/`replaceState` calls), keeps the WebView on
the current page, and posts the item id plus the signed-in session (read from the web client's
storage) to the native side. The native `expo-video` player then fetches the item, playback info,
and a playback ticket from the server itself, and plays the ticket's stream fullscreen with resume
position, ±10 s and drag seeking, video source switching, embedded audio/subtitle track selection,
progress reporting, and ticket revocation on exit. Returning from playback goes back to the page
that started it.

The Profile → Authorize device action opens a native QR scanner (`expo-camera`): grant camera
access, scan another device's TJXY login code, review its details, and approve it. The QR flow
uses the shared one-time challenge endpoints from `packages/client-api`.

## Desktop

Desktop Release CI is started from GitHub Actions via `Release Desktop` > `Run workflow`.
Enter a SemVer version such as `1.2.3`; the workflow builds Windows x86_64/ARM64,
macOS Apple Silicon, and Linux x86_64/ARM64 AppImage and DEB packages. Release builds
require the `HEROUI_KEY` repository secret from the sibling `TJXY` frontend repository.
The generated installers are currently unsigned.

```sh
cd ../TJXY/admin
pnpm install
cd ../../TJXY_app
pnpm --filter desktop dev
```

Set the server address on the login screen. The address and an optionally remembered username
are stored on the device; passwords are never persisted. Language and light/dark preferences are
device-local and remain selected after a restart.

Playback never uses the web player page. An initialization script intercepts the web client's
navigation to `/app/play/:id`, keeps the main window on the current page, and passes the item id
and signed-in session to the `desktop_player_open` command. A dedicated native window then fetches
the item, playback info and a playback ticket from the server itself and plays the stream with the
bundled libmpv. Controls are mpv's own on-screen controller and default key bindings (space,
arrows, `f`/double-click for fullscreen, `j` for subtitles, `#` for audio, `q` to close). The
player resumes at the saved position, falls back to the next direct-play source when one fails,
loads the server's external subtitles, reports start/progress/stop, marks the item watched and
closes at the end, and revokes its ticket on exit. The native player is currently available on
macOS only.

## Browser `/app`

Unchanged: the web client still uses same-origin `window.location.origin` unless a desktop override is stored.
