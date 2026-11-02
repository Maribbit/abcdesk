// ABC Desk build script: dual bundles for extension (Node / CJS) and webview (browser).
import { cp, mkdir } from 'node:fs/promises';
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/**
 * codicon icon font (icon content CC-BY-4.0, see out/codicons/THIRD_PARTY_NOTICES.txt):
 * copied to out/codicons/ at build time and loaded by the webview via asWebviewUri; resources stay inside the extension's own directory (SPEC-ENV-05).
 */
async function copyCodicons() {
  await mkdir('out/codicons', { recursive: true });
  const copies = [
    ['node_modules/@vscode/codicons/dist/codicon.css', 'out/codicons/codicon.css'],
    ['node_modules/@vscode/codicons/dist/codicon.ttf', 'out/codicons/codicon.ttf'],
    ['node_modules/@vscode/codicons/LICENSE', 'out/codicons/LICENSE'],
    ['node_modules/@vscode/codicons/LICENSE-CODE', 'out/codicons/LICENSE-CODE'],
    ['media/codicons/THIRD_PARTY_NOTICES.txt', 'out/codicons/THIRD_PARTY_NOTICES.txt'],
  ];
  for (const [from, to] of copies) {
    await cp(from, to);
  }
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // Aligned with the engines.vscode development baseline; the final minimum version follows the E03 measurement (see docs/plan.md).
  target: 'node16',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  outfile: 'out/webview.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await copyCodicons();
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching extension + webview');
} else {
  await copyCodicons();
  await esbuild.build(extensionConfig);
  await esbuild.build(webviewConfig);
  console.log('[esbuild] build completed -> out/');
}
