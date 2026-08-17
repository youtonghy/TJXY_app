const { execFileSync, execSync, spawn } = require('node:child_process');
const { createRequire } = require('node:module');

function packagerHost() {
  try {
    const route = execSync('route -n get default', { encoding: 'utf8' });
    const iface = route.match(/interface:\s+(\S+)/)?.[1];
    if (!iface) return '127.0.0.1';
    const ip = execSync(`ipconfig getifaddr ${iface}`, { encoding: 'utf8' }).trim();
    if (!ip || ip.startsWith('198.18.') || ip.startsWith('198.19.')) return '127.0.0.1';
    return ip;
  } catch {
    return '127.0.0.1';
  }
}

function reverseAndroidServerPort() {
  try {
    const output = execFileSync('adb', ['devices'], { encoding: 'utf8' });
    const devices = output
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(([, state]) => state === 'device')
      .map(([serial]) => serial);

    if (devices.length === 0) {
      console.warn('[TJXY] No authorized adb device found; skipped reverse tcp:8096.');
      return;
    }

    for (const serial of devices) {
      execFileSync('adb', ['-s', serial, 'reverse', 'tcp:8096', 'tcp:8096']);
      console.log(`[TJXY] ${serial}: reverse tcp:8096 -> tcp:8096`);
    }
  } catch (error) {
    console.warn(`[TJXY] Unable to configure adb reverse for port 8096: ${error.message}`);
  }
}

if (process.argv.includes('--android')) reverseAndroidServerPort();

const host = packagerHost();
process.env.REACT_NATIVE_PACKAGER_HOSTNAME = host;
const expoCli = createRequire(require.resolve('expo/package.json')).resolve('expo/bin/cli');
const child = spawn(process.execPath, [expoCli, 'start', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
