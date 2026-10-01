// ABC Desk 构建脚本：extension（Node / CJS）与 webview（浏览器）双 bundle。
import { cp, mkdir } from 'node:fs/promises';
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/**
 * codicon 图标字体（图标内容 CC-BY-4.0，见 out/codicons/THIRD_PARTY_NOTICES.txt）：
 * 随构建拷贝到 out/codicons/，webview 经 asWebviewUri 加载；资源仍限扩展自有目录（SPEC-ENV-05）。
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
