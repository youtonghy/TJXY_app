#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="$root_dir/runtime/macos-aarch64"
lib_dir="$runtime_dir/lib"
mpv_prefix="${TJXY_MPV_PREFIX:-$(brew --prefix mpv)}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This staging script currently supports macOS ARM64 only." >&2
  exit 1
fi

source_lib="$mpv_prefix/lib/libmpv.2.dylib"
if [[ ! -f "$source_lib" ]]; then
  echo "libmpv was not found at $source_lib" >&2
  exit 1
fi

mkdir -p "$lib_dir"
find "$lib_dir" -type f -delete

queue=("$source_lib")
seen="|"
while ((${#queue[@]})); do
  current="${queue[0]}"
  queue=("${queue[@]:1}")
  [[ "$seen" == *"|$current|"* ]] && continue
  seen="$seen$current|"

  target="$lib_dir/$(basename "$current")"
  cp -L "$current" "$target"
  chmod u+w "$target"

  while IFS= read -r dependency; do
    case "$dependency" in
      /opt/homebrew/*|/usr/local/*) queue+=("$dependency") ;;
    esac
  done < <(otool -L "$current" | tail -n +2 | awk '{print $1}')
done

for dylib in "$lib_dir"/*.dylib; do
  install_name_tool -id "@rpath/$(basename "$dylib")" "$dylib"
  while IFS= read -r dependency; do
    case "$dependency" in
      /opt/homebrew/*|/usr/local/*)
        install_name_tool -change "$dependency" "@loader_path/$(basename "$dependency")" "$dylib"
        ;;
    esac
  done < <(otool -L "$dylib" | tail -n +2 | awk '{print $1}')
  codesign --force --sign - "$dylib" >/dev/null
done

ln -sfn libmpv.2.dylib "$lib_dir/libmpv.dylib"

(
  cd "$runtime_dir"
  shasum -a 256 lib/*.dylib > manifest.sha256
)

echo "Staged $(find "$lib_dir" -type f | wc -l | tr -d ' ') libraries in $lib_dir"
