import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Build a disposable client-only frontend. The sibling checkout is never edited.
export function prepareFrontend() {
  const source = resolve(process.env.TJXY_ADMIN_DIR ?? join(repoRoot, '..', 'TJXY', 'admin'));
  if (!existsSync(join(source, 'node_modules'))) throw new Error(`Install frontend dependencies in ${source} first.`);
  const staged = join(repoRoot, '.client-frontend');
  mkdirSync(staged, { recursive: true });
  for (const entry of readdirSync(staged)) {
    if (entry !== 'node_modules') rmSync(join(staged, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(source)) {
    if (['node_modules', 'dist', '.git', 'test-results', 'playwright-report'].includes(entry)) continue;
    cpSync(join(source, entry), join(staged, entry), { recursive: true });
  }
  const modules = join(staged, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(source, 'node_modules'), modules, 'junction');
  const iptv = join(staged, 'src', 'client', 'iptv');
  rmSync(iptv, { recursive: true, force: true });
  cpSync(join(repoRoot, 'packages', 'iptv', 'src'), iptv, { recursive: true });
  // The embedded mobile page has a file origin and navigates with hash routes.
  const appSource = join(staged, 'src', 'App.tsx');
  if (!readFileSync(appSource, 'utf8').includes('? HashRouter : BrowserRouter')) patchSource(appSource, [
    ['import { BrowserRouter,', 'import { BrowserRouter, HashRouter,'],
    ['export function App()', "const ShellRouter = import.meta.env.VITE_TJXY_SHELL === 'mobile' ? HashRouter : BrowserRouter;\n\nexport function App()"],
    ['<BrowserRouter>', '<ShellRouter>'],
    ['</BrowserRouter>', '</ShellRouter>'],
  ]);
  patchSource(join(staged, 'src', 'client', 'api', 'apiBase.ts'), [
    ["return import.meta.env.VITE_TJXY_SHELL === 'desktop';", "return import.meta.env.VITE_TJXY_SHELL === 'desktop' || import.meta.env.VITE_TJXY_SHELL === 'mobile';"],
  ]);
  return staged;
}

function patchSource(path, replacements) {
  let source = readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`Embedded shell source changed: ${path}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(prepareFrontend());
