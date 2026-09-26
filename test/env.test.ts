import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 绑定见 docs/spec/env.md；it.todo 为待实现条目的占位（实现时替换为真实断言）。

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

/** 读取某源码目录下全部 .ts 文件内容（递归，用于分层边界扫描）。 */
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

describe('运行环境与安全（SPEC-ENV 域）', () => {
  it('[SPEC-ENV-01] capabilities 声明不受信任工作区完整支持，不主动禁用虚拟工作区', () => {
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(true);
    expect(manifest.capabilities?.virtualWorkspaces?.supported).not.toBe(false);
  });

  it('[SPEC-ENV-05] 扩展侧不 import node:fs / node:path，资源仅经 asWebviewUri 加载', () => {
    for (const source of sourceFiles('src/extension')) {
      expect(source).not.toMatch(/from '(node:)?fs'/);
      expect(source).not.toMatch(/from '(node:)?path'/);
    }
    // 核心代码避免 Node 专用依赖（不主动堵死 vscode.dev，见 SPEC-ENV-05）
    for (const source of sourceFiles('src/core')) {
      expect(source).not.toMatch(/from 'node:/);
    }
    // webview 资源仅经 asWebviewUri 加载，不手拼 file:// 或磁盘路径
    const panel = readFileSync(new URL('../src/extension/previewPanel.ts', import.meta.url), 'utf8');
    expect(panel).toContain('asWebviewUri');
    expect(panel).not.toMatch(/file:\/\//);
  });

  it('[SPEC-ENV-08] 激活事件恰为 onLanguage:abc，不用 workspaceContains / onStartupFinished / * / onCommand', () => {
    const events = manifest.activationEvents ?? [];

    expect(events).toEqual(['onLanguage:abc']);
    expect(events.some((event) => event.startsWith('onCommand:'))).toBe(false);
  });
});
