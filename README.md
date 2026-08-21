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
- `apps/mobile` — Expo + HeroUI Native
- `apps/desktop` — Tauri 2 wrapping the existing TJXY `admin` `/app` UI

The desktop shell points at the sibling `../TJXY/admin` Vite app with `VITE_TJXY_SHELL=desktop`.
Production desktop assets are written to `apps/desktop/dist`; they do not
overwrite the server's web assets in `../TJXY/admin/dist`.

From the repo root:

```sh
pnpm install
```

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

On first launch enter the server origin, then sign in. Tabs include Home, Libraries, Search,
Rankings, AI (when configured), and Profile. Mobile consumes the server's public branding and
`classic`/`cinema` theme settings while keeping the device's light/dark preference local.

The login screen supports password and QR-code modes. A logged-in mobile device can open Profile
→ Scan authorize, grant camera access, scan another device's TJXY login code, review its
client/device details, and approve it. Profile also lists active sessions with last activity and
allows revoking a session; revoking the current session signs the mobile client out. The QR flow
uses the shared one-time challenge endpoints from `packages/client-api`.

AI chat uses the server's finite SSE response. On native Expo, the shared client buffers that
response before parsing it because Expo's native `Response.body` stream is not reliable across
the supported SDK/runtime combination.

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

Playback opens and starts automatically inside the play page. Directly compatible sources use the
WebView player. Other containers are remuxed by FFmpeg into a token-protected localhost HLS stream;
native HLS is used where available and HLS.js is loaded on demand on other platforms. The proxy
starts at the saved resume position, generates media at playback speed, and keeps a bounded rolling
segment window to avoid unbounded CPU and disk growth.

The desktop client uses an existing `ffmpeg` on `PATH` when available. macOS and Windows can
download a build on first use. Linux currently requires FFmpeg on `PATH`.

## Browser `/app`

Unchanged: the web client still uses same-origin `window.location.origin` unless a desktop override is stored.
