import { execFileSync } from 'node:child_process';
import { prepareFrontend } from './prepare-frontend.mjs';
const cwd = prepareFrontend();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['run', 'typecheck'], { cwd, stdio: 'inherit' });
execFileSync(npm, ['test', '--', '--run', 'src/client/iptv'], { cwd, stdio: 'inherit' });
