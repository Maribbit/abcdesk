import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from '../src/core/messages';

// 绑定见 docs/spec/env.md（ENV-04）；标题以 [SPEC-域-序号] 前置，由 scripts/spec-check.mjs 双向校验。

describe('消息桥校验（SPEC-ENV-04）', () => {
  it('[SPEC-ENV-04] webview 消息按类型校验：ready 通过，未知 / 缺类型 / 非对象拒绝', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });

    // 缺类型、未知类型、非对象一律拒绝
    expect(parseWebviewMessage({})).toBeUndefined();
    expect(parseWebviewMessage({ type: 'play' })).toBeUndefined();
    expect(parseWebviewMessage('ready')).toBeUndefined();
    expect(parseWebviewMessage(null)).toBeUndefined();
    expect(parseWebviewMessage(undefined)).toBeUndefined();

    // 额外字段被丢弃，不经消息桥传递
    expect(parseWebviewMessage({ type: 'ready', filePath: '/etc/passwd' })).toEqual({ type: 'ready' });
  });
});
