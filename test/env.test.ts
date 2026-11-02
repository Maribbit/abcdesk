import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Bindings in docs/spec/env.md; it.todo marks placeholders for unimplemented items (replaced with real assertions on implementation).

// Checks static / dynamic imports and require alike, covering single / double quotes and subpaths such as fs/promises.
const NODE_FILE_IMPORT = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]/;

interface PackageManifest {
  activationEvents?: string[];
  capabilities?: {
    untrustedWorkspaces?: { supported?: boolean | 'limited' };
    virtualWorkspaces?: { supported?: boolean | 'limited' };
  };
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

/** Read the contents of every .ts file under a source directory (recursive, used for layer boundary scans). */
function sourceFiles(relativeDir: string): string[] {
  const absolute = fileURLToPath(new URL(`../${relativeDir}`, import.meta.url));
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(`${relativeDir}/${entry.name}`));
    } else if (entry.name.endsWith('.ts')) {
      files.push(readFileSync(child, 'utf8'));
    }
  }
  return files;
}

describe('runtime environment and security (SPEC-ENV domain)', () => {
  it('[SPEC-ENV-01] capabilities declare full untrusted-workspace support and do not actively disable virtual workspaces', () => {
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(true);
    expect(manifest.capabilities?.virtualWorkspaces?.supported).not.toBe(false);
  });

  it.each([
    "import { readFile } from 'node:fs/promises';",
    'import { readFile } from "fs/promises";',
    "import * as fs from 'node:fs';",
    'import fs from "fs";',
    "import path from 'node:path';",
    'import path from "path";',
    "import path from 'path/posix';",
    'import path from "node:path/win32";',
    "import 'node:fs/promises';",
    'import("node:fs/promises")',
    "require('fs/promises')",
  ])('file access boundary scan recognizes: %s', (source) => {
    expect(source).toMatch(NODE_FILE_IMPORT);
  });

  it.each([
    "import fs from 'fs-extra';",
    "import fs from './fs';",
    "import * as vscode from 'vscode';",
  ])('file access boundary scan does not misjudge other modules: %s', (source) => {
    expect(source).not.toMatch(NODE_FILE_IMPORT);
  });

  it('[SPEC-ENV-05] the extension side imports no Node fs / path (including subpaths); resources load only via asWebviewUri', () => {
    for (const source of sourceFiles('src/extension')) {
      expect(source).not.toMatch(NODE_FILE_IMPORT);
    }
    // Core code avoids Node-only dependencies (does not actively block vscode.dev, see SPEC-ENV-05)
    for (const source of sourceFiles('src/core')) {
      expect(source).not.toMatch(/from 'node:/);
    }
    // webview resources load only via asWebviewUri, never hand-built file:// or disk paths
    const panel = readFileSync(new URL('../src/extension/previewPanel.ts', import.meta.url), 'utf8');
    expect(panel).toContain('asWebviewUri');
    expect(panel).not.toMatch(/file:\/\//);
  });

  it('[SPEC-ENV-08] the activation event is exactly onLanguage:abc, not workspaceContains / onStartupFinished / * / onCommand', () => {
    const events = manifest.activationEvents ?? [];

    expect(events).toEqual(['onLanguage:abc']);
    expect(events.some((event) => event.startsWith('onCommand:'))).toBe(false);
  });
});
