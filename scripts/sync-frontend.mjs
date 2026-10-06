#!/usr/bin/env node
// Builds the TJXY `admin` /app client for the embedded shells and stages the
// artifacts inside this repository:
//   - desktop shell -> apps/desktop/dist (consumed by the Tauri webview)
//   - mobile shell  -> apps/mobile/assets/web/app.html (single-file bundle
//     loaded by the in-app WebView; only API data is fetched from the server)
//
// The admin workspace defaults to the sibling checkout at ../TJXY/admin and can
// be overridden with TJXY_ADMIN_DIR.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminDir = resolve(process.env.TJXY_ADMIN_DIR ?? join(repoRoot, '..', 'TJXY', 'admin'));
const desktopOut = join(repoRoot, 'apps', 'desktop', 'dist');
const mobileOutDir = join(repoRoot, 'apps', 'mobile', 'assets', 'web');
const mobileBundle = join(mobileOutDir, 'app.html');

if (!existsSync(join(adminDir, 'package.json'))) {
  console.error(`admin workspace not found at ${adminDir}`);
  console.error('Set TJXY_ADMIN_DIR to the admin/ directory of a TJXY checkout.');
  process.exit(1);
}

function viteBuild(shell, outDir) {
  console.log(`\n> building ${shell} shell -> ${outDir}`);
  execFileSync(
    'npx',
    ['vite', 'build', '--outDir', outDir],
    { cwd: adminDir, env: { ...process.env, VITE_TJXY_SHELL: shell }, stdio: 'inherit' },
  );
}

function inlineAsset(assetPath) {
  const source = readFileSync(assetPath, 'utf8');
  const ts = createRequire(join(adminDir, 'package.json'))('typescript');
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    transformers: { before: [(context) => {
      const visit = (node) => {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment('url', ts.factory.createPropertyAccessExpression(
              ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('window'), 'location'), 'href')),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (root) => ts.visitNode(root, visit);
    }] },
  });
  return `(function(exports) {\n${result.outputText}\n})({});`.replace(/<\/script/gi, '<\\/script');
}

function buildSingleFile(distDir) {
  const htmlPath = join(distDir, 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  const scripts = [];

  html = html.replace(/<script\b[^>]*\bsrc="(\.\/[^"]+\.js)"[^>]*><\/script>/g, (match, src) => {
    const content = inlineAsset(join(distDir, src.replace('./', '')));
    scripts.push(`<script>${content}</script>`);
    return '';
  });
  html = html.replace(/<link\b[^>]*\bhref="(\.\/[^"]+\.css)"[^>]*>/g, (match, href) => {
    const content = readFileSync(join(distDir, href.replace('./', '')), 'utf8');
    return `<style>${content}</style>`;
  });
  html = html.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, '');
  html = html.replace(/<link\b[^>]*\bhref="\.\/brand\/[^"]+"[^>]*>/g, '');
  return html.replace('</body>', () => `${scripts.join('\n')}</body>`);
}

viteBuild('desktop', desktopOut);
viteBuild('mobile', mobileOutDir);

const bundled = buildSingleFile(mobileOutDir);
for (const entry of ['assets', 'brand']) {
  rmSync(join(mobileOutDir, entry), { recursive: true, force: true });
}
rmSync(join(mobileOutDir, 'index.html'), { force: true });
writeFileSync(mobileBundle, bundled);
console.log(`\n> wrote ${mobileBundle} (${(bundled.length / 1024 / 1024).toFixed(1)} MB)`);
console.log('done.');
