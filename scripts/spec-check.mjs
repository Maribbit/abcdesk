#!/usr/bin/env node
/**
 * spec-check：docs/spec 规格条目与绑定引用（测试代码 / 人工验证清单）的双向校验。
 *
 * 正向：每个规格条目必须至少被一处引用覆盖——
 *   auto   条目：出现在 src/ 或 test/ 的 *.test.ts 的测试声明标题中
 *          （it / it.todo / it.skip / it.only / describe / test 的首个字符串参数）；
 *   manual 条目：出现在 docs/manual-checks.md 中。
 * 反向：所有 [SPEC-...] 引用必须能在规格文档中找到定义（无悬空引用）。
 * 附带：输出 it.todo 占位待转正清单（进度可见性，不影响退出码）。
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
// 测试声明：只承认声明调用首个字符串参数（标题）内的引用；`.todo` 视为占位。
const DECLARATION_PATTERN =
  /(?<![\w.])(?:it|describe|test)(?:\.(todo|skip|only))?\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`)/g;
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

function collectTestReferences(dir, realRefs, todoRefs) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { recursive: true })) {
    if (!name.endsWith('.test.ts')) continue;
    const text = readText(join(dir, name));
    for (const match of text.matchAll(DECLARATION_PATTERN)) {
      const [, modifier, single, double, backtick] = match;
      const title = single ?? double ?? backtick ?? '';
      const target = modifier === 'todo' ? todoRefs : realRefs;
      for (const ref of title.matchAll(REFERENCE_PATTERN)) {
        target.add(ref[1]);
      }
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
const realRefs = new Set();
const todoRefs = new Set();
collectTestReferences(join(root, 'src'), realRefs, todoRefs);
collectTestReferences(join(root, 'test'), realRefs, todoRefs);
const testRefs = new Set([...realRefs, ...todoRefs]);
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
  `  规格条目 ${items.size}；测试引用 ${testRefs.size}（真实 ${realRefs.size}、占位 ${todoRefs.size}）；人工验证引用 ${manualRefs.size}`,
);
const placeholderOnly = [...todoRefs].filter((id) => !realRefs.has(id)).sort();
if (placeholderOnly.length > 0) {
  console.log(`  占位待转正 ${placeholderOnly.length} 条（it.todo）：`);
  for (let i = 0; i < placeholderOnly.length; i += 6) {
    console.log(`    ${placeholderOnly.slice(i, i + 6).join(', ')}`);
  }
}
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
