// ABC Desk 构建脚本：extension（Node / CJS）与 webview（浏览器）双 bundle。
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // 对齐 engines.vscode 开发基线；最低支持版本终值随 E03 实测调整（见 docs/plan.md）。
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
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching extension + webview');
} else {
  await esbuild.build(extensionConfig);
  await esbuild.build(webviewConfig);
  console.log('[esbuild] build completed -> out/');
}
