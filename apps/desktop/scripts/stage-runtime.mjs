#!/usr/bin/env node
// Stages the libmpv runtime for a Rust target triple into
// player/runtime/<platform>/lib:
//
//   node scripts/stage-runtime.mjs <target>            # before cargo build
//   node scripts/stage-runtime.mjs <target> --deps <binary>   # after build (linux)
//
// - macos-*: verifies the manually staged dylib set (see player/runtime/
//   README.md; run apps/desktop/scripts/stage-macos-libmpv.sh).
// - windows-*: downloads a libmpv dev build (zhongfly/mpv-winbuild by
//   default; override with TJXY_MPV_WIN_URL / TJXY_MPV_WIN_SHA256) and
//   extracts the import library plus the dlls.
// - linux-*: build-time link uses the system libmpv (apt: libmpv-dev);
//   with --deps it copies the binary's shared-library closure into the
//   runtime dir so AppImage users get a self-contained player.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playerDir = join(desktopDir, 'player');

const RUNTIME_DIRS = {
  'aarch64-apple-darwin': 'macos-aarch64',
  'x86_64-apple-darwin': 'macos-x86_64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
  'aarch64-pc-windows-msvc': 'windows-aarch64',
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
  'aarch64-unknown-linux-gnu': 'linux-aarch64',
};

const [target, ...rest] = process.argv.slice(2);
const depsFlag = rest.indexOf('--deps');
const depsBinary = depsFlag >= 0 ? rest[depsFlag + 1] : null;

if (!target || !RUNTIME_DIRS[target]) {
  console.error(`usage: stage-runtime.mjs <rust-target> [--deps <binary>]`);
  console.error(`targets: ${Object.keys(RUNTIME_DIRS).join(', ')}`);
  process.exit(1);
}

const runtimeDir = RUNTIME_DIRS[target];
const libDir = join(playerDir, 'runtime', runtimeDir, 'lib');

// Libraries that must come from the base system even in an AppImage; bundling
// libc/libpthread breaks hosts with a different glibc.
const LINUX_SYSTEM_LIBS = /^(ld-linux|ld-musl|libc|libm|libdl|libpthread|librt|libresolv|libnsl|libutil|libgcc_s|libstdc\+\+|libatomic)[.-]/;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function warn(message) {
  console.warn(`stage-runtime: warning: ${message}`);
}

async function stageWindows() {
  const marker = join(libDir, 'mpv.lib');
  if (existsSync(marker)) {
    console.log(`stage-runtime: ${runtimeDir} already staged`);
    return;
  }
  let url = process.env.TJXY_MPV_WIN_URL;
  if (!url) {
    const arch = target.includes('aarch64') ? 'aarch64' : 'x86_64';
    const api = 'https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest';
    const response = await fetch(api, {
      headers: { 'user-agent': 'tjxy-desktop', accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`mpv release lookup failed: HTTP ${response.status}`);
    const release = await response.json();
    const asset = (release.assets ?? []).find((a) =>
      a.name.startsWith(`mpv-dev-${arch}-`) && a.name.endsWith('.7z'));
    if (!asset) throw new Error(`no mpv-dev-${arch}-*.7z asset in latest mpv-winbuild release`);
    url = asset.browser_download_url;
  }
  console.log(`stage-runtime: downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`mpv download failed: HTTP ${response.status}`);
  const archive = join(mkdtempSync(join(tmpdir(), 'tjxy-mpv-')), 'mpv.7z');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const expected = process.env.TJXY_MPV_WIN_SHA256;
  if (expected && sha256(archive) !== expected.toLowerCase()) {
    throw new Error('mpv download checksum mismatch');
  }
  const extractDir = join(dirname(archive), 'x');
  mkdirSync(extractDir);
  // bsdtar (bundled with Windows and macOS) reads 7z archives.
  execFileSync('tar', ['-xf', archive, '-C', extractDir], { stdio: 'inherit' });
  mkdirSync(libDir, { recursive: true });
  const copied = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.dll$|\.lib$/i.test(entry.name)) {
        cpSync(path, join(libDir, entry.name));
        copied.push(entry.name);
      }
    }
  };
  walk(extractDir);
  rmSync(dirname(archive), { recursive: true, force: true });
  // MinGW builds ship `mpv.dll.a`; MSVC needs a COFF `mpv.lib`. Generate an
  // import library from the dll's export table (dumpbin + lib are on PATH
  // once a msvc-dev environment is active; CI uses ilammy/msvc-dev-cmd).
  if (!existsSync(marker)) {
    const dll = copied.find((name) => /^mpv.*\.dll$/i.test(name));
    if (!dll) {
      throw new Error(`no mpv dll in the downloaded package (got: ${copied.join(', ') || 'nothing'})`);
    }
    console.log(`stage-runtime: generating mpv.lib from ${dll}`);
    const exports = execFileSync('dumpbin', ['/exports', join(libDir, dll)], { encoding: 'utf8' })
      .split('\n')
      .map((line) => /^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)/.exec(line)?.[1])
      .filter(Boolean);
    if (exports.length === 0) throw new Error(`no exports parsed from ${dll}`);
    const def = join(libDir, 'mpv.def');
    const { writeFileSync: write } = await import('node:fs');
    write(def, `LIBRARY ${dll.replace(/\.dll$/i, '')}\nEXPORTS\n${exports.map((n) => `    ${n}`).join('\n')}\n`);
    const machine = target.includes('aarch64') ? 'ARM64' : 'X64';
    execFileSync('lib', [`/def:${def}`, `/out:${marker}`, `/machine:${machine}`], { stdio: 'inherit' });
    rmSync(def, { force: true });
  }
  console.log(`stage-runtime: staged ${copied.length} files into ${runtimeDir}/lib`);
}

function stageMacos() {
  for (const name of ['libmpv.dylib', 'libmpv.2.dylib']) {
    if (!existsSync(join(libDir, name))) {
      throw new Error(
        `${runtimeDir}/lib/${name} missing — stage the macOS libmpv dylibs ` +
          'first (see player/runtime/README.md).',
      );
    }
  }
  console.log(`stage-runtime: ${runtimeDir} dylibs present`);
}

function stageLinux() {
  const soName = 'libmpv.so.2';
  if (!depsBinary) {
    // Pre-build: the linker needs libmpv.so (dev package). The bundled copy
    // satisfies the link too once staged.
    const bundled = existsSync(join(libDir, soName));
    const system = ['libmpv.so', soName].some((name) => {
      try {
        execSync(`ldconfig -p | grep -q ${name}`, { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    });
    if (!bundled && !system) {
      warn('libmpv not found — install libmpv-dev (deb) before building');
    }
    return;
  }
  if (!existsSync(depsBinary)) throw new Error(`binary not found: ${depsBinary}`);
  const lines = execFileSync('ldd', [depsBinary], { encoding: 'utf8' }).split('\n');
  const seen = new Set();
  let copied = 0;
  for (const line of lines) {
    const match = /=> (\/[^\s]+\.so[^\s]*)/.exec(line) ?? /^\s*(\/[^\s]+\.so[^\s]*)/.exec(line);
    if (!match) continue;
    const source = match[1];
    const name = source.split('/').pop();
    if (LINUX_SYSTEM_LIBS.test(name) || seen.has(name)) continue;
    seen.add(name);
    mkdirSync(libDir, { recursive: true });
    cpSync(source, join(libDir, name));
    copied += 1;
  }
  console.log(`stage-runtime: copied ${copied} shared libraries into ${runtimeDir}/lib`);
}

if (target.includes('windows')) await stageWindows();
else if (target.includes('apple-darwin')) stageMacos();
else stageLinux();
