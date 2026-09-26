import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 绑定见 docs/spec/env.md；it.todo 为待实现条目的占位（实现时替换为真实断言）。

interface PackageManifest {
  activationEvents?: string[];
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

describe('运行环境与安全（SPEC-ENV 域）', () => {
  it('[SPEC-ENV-08] 激活事件恰为 onLanguage:abc，不用 workspaceContains / onStartupFinished / * / onCommand', () => {
    const events = manifest.activationEvents ?? [];

    expect(events).toEqual(['onLanguage:abc']);
    expect(events.some((event) => event.startsWith('onCommand:'))).toBe(false);
  });

  it.todo('[SPEC-ENV-01] capabilities 声明不受信任工作区支持，且不主动禁用虚拟工作区');
  it.todo('[SPEC-ENV-04] 消息桥输入按类型、范围与文档版本校验，拒绝任意路径');
  it.todo('[SPEC-ENV-05] 扩展侧不 import node:fs，资源仅经 asWebviewUri 加载');
});
