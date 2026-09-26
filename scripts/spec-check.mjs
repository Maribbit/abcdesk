#!/usr/bin/env node
/**
 * spec-check：docs/spec 规格条目与绑定引用（测试代码 / 人工验证清单）的双向校验。
 *
 * 正向：每个规格条目必须至少被一处引用覆盖——
 *   auto   条目：出现在 src/ 或 test/ 的 *.test.ts 中（it() 与 it.todo 均可）；
 *   manual 条目：出现在 docs/manual-checks.md 中。
 * 反向：所有 [SPEC-...] 引用必须能在规格文档中找到定义（无悬空引用）。
 *
 * 用法：npm run spec:check；违规时退出码为 1。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const specDir = join(root, 'docs', 'spec');
const manualChecksPath = join(root, 'docs', 'manual-checks.md');

const ENTRY_PATTERN = /^### (SPEC-[A-Z0-9]+-\d{2})\s+(.+)$/gm;
const REFERENCE_PATTERN = /\[(SPEC-[A-Z0-9]+-\d{2})\]/g;
const VERIFY_PATTERN = /^\s*[-*]\s*验证：\s*(auto|manual)\s*$/m;

function readText(path) {
  return readFileSync(path, 'utf8');
}

function collectSpecItems() {
  const items = new Map();
  const errors = [];
  const files = existsSync(specDir)
    ? readdirSync(specDir)
        .filter((name) => name.endsWith('.md') && name !== '00-index.md')
        .sort()
    : [];
  for (const file of files) {
    const text = readText(join(specDir, file));
    const matches = [...text.matchAll(ENTRY_PATTERN)];
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i];
      const id = match[1];
      const title = match[2].trim();
      const blockEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const block = text.slice(match.index, blockEnd);
      const verify = block.match(VERIFY_PATTERN);
      if (items.has(id)) {
        errors.push(`重复定义：${id}（${file}，首次定义见 ${items.get(id).file}）`);
        continue;
      }
      items.set(id, { id, title, file, verify: verify ? verify[1] : null });
    }
  }
  return { items, errors };
}

function collectTestReferences(dir, into) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { recursive: true })) {
    if (!name.endsWith('.test.ts')) continue;
    const text = readText(join(dir, name));
    for (const match of text.matchAll(REFERENCE_PATTERN)) {
      into.add(match[1]);
    }
  }
}

function collectManualReferences() {
  const refs = new Set();
  if (!existsSync(manualChecksPath)) return refs;
  const text = readText(manualChecksPath);
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    refs.add(match[1]);
  }
  return refs;
}

const { items, errors } = collectSpecItems();
const testRefs = new Set();
collectTestReferences(join(root, 'src'), testRefs);
collectTestReferences(join(root, 'test'), testRefs);
const manualRefs = collectManualReferences();

const unbound = [];
for (const item of items.values()) {
  if (!item.verify) {
    errors.push(`缺少验证方式（需要 "- 验证：auto / manual"）：${item.id}（${item.file}）`);
  } else if (item.verify === 'auto' && !testRefs.has(item.id)) {
    unbound.push(`${item.id}（${item.file}）需要测试引用`);
  } else if (item.verify === 'manual' && !manualRefs.has(item.id)) {
    unbound.push(`${item.id}（${item.file}）需要在 docs/manual-checks.md 登记`);
  }
}

const dangling = [];
for (const ref of new Set([...testRefs, ...manualRefs])) {
  if (!items.has(ref)) dangling.push(ref);
}

console.log('spec-check：规格条目与绑定引用双向校验');
console.log(
  `  规格条目 ${items.size}；测试引用 ${testRefs.size}；人工验证引用 ${manualRefs.size}`,
);
for (const message of errors) console.log(`  [错误] ${message}`);
for (const message of unbound) console.log(`  [未绑定] ${message}`);
for (const message of dangling) console.log(`  [悬空引用] ${message}`);

const failures = errors.length + unbound.length + dangling.length;
if (failures === 0) {
  console.log('  通过：全部条目均有绑定引用，无悬空引用。');
} else {
  console.log(`  失败：${failures} 个问题。`);
  process.exitCode = 1;
}
