#!/usr/bin/env node
/**
 * spec-check: bidirectional check between docs/spec items and their bound references (test code / manual check list).
 *
 * Forward: every spec item must be covered by at least one reference -
 *   auto   items: appear in a test declaration title in src/ or test/ *.test.ts
 *          (first string argument of it / it.todo / it.skip / it.only / describe / test);
 *   manual items: appear in docs/manual-checks.md.
 * Reverse: every [SPEC-...] reference must resolve to a definition in the spec docs (no dangling references).
 * Extra: prints the list of it.todo placeholders still to be promoted (progress visibility, does not affect the exit code).
 *
 * Usage: npm run spec:check; exits with code 1 on violations.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const specDir = join(root, 'docs', 'spec');
const manualChecksPath = join(root, 'docs', 'manual-checks.md');

const ENTRY_PATTERN = /^### (SPEC-[A-Z0-9]+-\d{2})\s+(.+)$/gm;
const REFERENCE_PATTERN = /\[(SPEC-[A-Z0-9]+-\d{2})\]/g;
// Test declarations: only references inside the first string argument (the title) of a declaration call count; `.todo` is a placeholder.
const DECLARATION_PATTERN =
  /(?<![\w.])(?:it|describe|test)(?:\.(todo|skip|only))?\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`)/g;
const VERIFY_PATTERN = /^\s*[-*]\s*验证：\s*(auto|manual)\s*$/m; // spec marker follows the Chinese spec docs (docs/conventions.md)

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
        errors.push(`duplicate definition: ${id} (${file}, first defined in ${items.get(id).file})`);
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
    errors.push(`missing verification mode (needs "- 验证：auto / manual"): ${item.id} (${item.file})`);
  } else if (item.verify === 'auto' && !testRefs.has(item.id)) {
    unbound.push(`${item.id} (${item.file}) needs a test reference`);
  } else if (item.verify === 'manual' && !manualRefs.has(item.id)) {
    unbound.push(`${item.id} (${item.file}) needs an entry in docs/manual-checks.md`);
  }
}

const dangling = [];
for (const ref of new Set([...testRefs, ...manualRefs])) {
  if (!items.has(ref)) dangling.push(ref);
}

console.log('spec-check: bidirectional check of spec items and bound references');
console.log(
  `  spec items ${items.size}; test references ${testRefs.size} (real ${realRefs.size}, placeholder ${todoRefs.size}); manual check references ${manualRefs.size}`,
);
const placeholderOnly = [...todoRefs].filter((id) => !realRefs.has(id)).sort();
if (placeholderOnly.length > 0) {
  console.log(`  ${placeholderOnly.length} placeholder-only item(s) to promote (it.todo):`);
  for (let i = 0; i < placeholderOnly.length; i += 6) {
    console.log(`    ${placeholderOnly.slice(i, i + 6).join(', ')}`);
  }
}
for (const message of errors) console.log(`  [error] ${message}`);
for (const message of unbound) console.log(`  [unbound] ${message}`);
for (const message of dangling) console.log(`  [dangling] ${message}`);

const failures = errors.length + unbound.length + dangling.length;
if (failures === 0) {
  console.log('  passed: every item has a bound reference and there are no dangling references.');
} else {
  console.log(`  failed: ${failures} problem(s).`);
  process.exitCode = 1;
}
