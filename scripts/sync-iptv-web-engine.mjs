import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/sync-iptv-web-engine.mjs <ysp-engine.js>');
const source = readFileSync(input, 'utf8');
const ts = createRequire(join(root, '..', 'TJXY', 'admin', 'package.json'))('typescript');
const ast = ts.createSourceFile(input, source, ts.ScriptTarget.Latest, true);
const names = new Set(['KEYGEN_B64', 'TICKET_B64', 'KEYGEN_BUF', 'TICKET_BUF', 'KEYGEN_MODULE', 'TICKET_MODULE', 'runKeygen', 'buildTicket', 'randStr', 'base36', 'buildCKey']);
let extracted = '';
for (const node of ast.statements) {
  const name = ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name.getText(ast) : node.name?.getText(ast);
  if (names.has(name)) extracted += node.getText(ast) + '\n\n';
}
extracted = extracted
  .replaceAll("Buffer.from(KEYGEN_B64, 'base64')", 'decodeBase64(KEYGEN_B64)')
  .replaceAll("Buffer.from(TICKET_B64, 'base64')", 'decodeBase64(TICKET_B64)')
  .replaceAll(/Buffer\.from\(u8\.subarray\(ptr, ptr \+ len\)\)\.toString\('utf8'\)/g, 'decodeUtf8(u8.subarray(ptr, ptr + len))')
  .replaceAll("Buffer.from(val, 'utf8')", 'encodeUtf8(val)')
  .replaceAll("Buffer.from(str, 'utf8')", 'encodeUtf8(str)')
  .replaceAll("Buffer.from(memory.buffer, outPtr, outLen).toString('hex')", 'bytesToHex(new Uint8Array(memory.buffer, outPtr, outLen))')
  .replace(/  const cipher = crypto\.createCipheriv[\s\S]*?  return '--01' \+ enc\.toString\('hex'\)\.toUpperCase\(\);/, "  return '--01' + aes128CbcEncryptHex(plain, '48e5918a74ae21c972b90cce8af6c8be', '9a7e7d23610266b1d9fbf98581384d92').toUpperCase();");
if (/\bBuffer\b|\bcrypto\.create/.test(extracted)) throw new Error('Unconverted Node API');
const header = `// Generated from the supplied ysp-engine.js v9.0.0. No listener or Node runtime.\n// Regenerate: node scripts/sync-iptv-web-engine.mjs <ysp-engine.js>\nimport { aes128CbcEncryptHex, bytesToHex } from './iptvDeviceCrypto';\nconst encodeUtf8 = (text) => new TextEncoder().encode(text);\nconst decodeUtf8 = (bytes) => new TextDecoder().decode(bytes);\nconst decodeBase64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));\n`;
writeFileSync(join(root, 'packages/iptv/src/iptvWebWasm.js'), header + extracted + 'export { runKeygen, buildTicket, buildCKey, randStr, base36 };\n');
console.log('Generated client WebAssembly bindings.');
