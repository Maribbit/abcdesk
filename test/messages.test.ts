import { describe, expect, it } from 'vitest';
import { parseHostMessage, parseWebviewMessage } from '../src/core/messages';

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

  it('[SPEC-ENV-04] rendered 消息校验渲染版本与结果：越界 / 非整数版本拒绝，额外字段丢弃', () => {
    expect(parseWebviewMessage({ type: 'rendered', version: 3, ok: true })).toEqual({
      type: 'rendered',
      version: 3,
      ok: true,
    });

    // 版本必须是非负整数，结果必须是布尔值
    expect(parseWebviewMessage({ type: 'rendered', version: -1, ok: true })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'rendered', version: 1.5, ok: true })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'rendered', version: '3', ok: true })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'rendered', version: 3 })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'rendered', version: 3, ok: 'yes' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'rendered', version: 3, ok: true, path: '/etc/passwd' })).toEqual({
      type: 'rendered',
      version: 3,
      ok: true,
    });
  });

  it('[SPEC-ENV-04] playback-state 仅接受四个已登记相位，未知相位拒绝', () => {
    for (const state of ['idle', 'preparing', 'playing', 'paused'] as const) {
      expect(parseWebviewMessage({ type: 'playback-state', state })).toEqual({
        type: 'playback-state',
        state,
      });
    }

    expect(parseWebviewMessage({ type: 'playback-state', state: 'buffering' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'playback-state' })).toBeUndefined();
  });

  it('[SPEC-ENV-04] reveal-source 无载荷请求：额外字段丢失，目标路径不由 webview 指定', () => {
    expect(parseWebviewMessage({ type: 'reveal-source' })).toEqual({ type: 'reveal-source' });
    expect(parseWebviewMessage({ type: 'reveal-source', uri: 'file:///etc/passwd' })).toEqual({
      type: 'reveal-source',
    });
  });

  it('[SPEC-ENV-04] webview 侧同样校验宿主消息：document 形状完整才接受，playback 仅限三个动作', () => {
    const documentMessage = {
      type: 'document',
      uri: 'untitled:Untitled-1',
      fileName: 'Untitled-1',
      abc: 'X:1\nK:C\nC D E F|',
      isUntitled: true,
      version: 0,
    };
    expect(parseHostMessage(documentMessage)).toEqual(documentMessage);
    expect(parseHostMessage({ ...documentMessage, version: -1 })).toBeUndefined();
    expect(parseHostMessage({ ...documentMessage, abc: undefined })).toBeUndefined();
    expect(parseHostMessage({ type: 'document' })).toBeUndefined();

    expect(parseHostMessage({ type: 'playback', action: 'toggle' })).toEqual({
      type: 'playback',
      action: 'toggle',
    });
    expect(parseHostMessage({ type: 'playback', action: 'pause' })).toEqual({
      type: 'playback',
      action: 'pause',
    });
    expect(parseHostMessage({ type: 'playback', action: 'stop' })).toEqual({
      type: 'playback',
      action: 'stop',
    });
    expect(parseHostMessage({ type: 'playback', action: 'seek' })).toBeUndefined();
    expect(parseHostMessage({ type: 'playback' })).toBeUndefined();
    expect(parseHostMessage('playback')).toBeUndefined();
    expect(parseHostMessage({ type: 'playback', action: 'toggle', filePath: '/etc/passwd' })).toEqual({
      type: 'playback',
      action: 'toggle',
    });
  });
});
