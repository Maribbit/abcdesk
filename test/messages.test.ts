import { describe, expect, it } from 'vitest';
import { parseHostMessage, parseWebviewMessage, sameContext } from '../src/core/messages';

const context = { viewId: 2, revision: 4, version: 3, selection: 1 };
const document = { type: 'document', uri: 'untitled:1', fileName: '1', abc: 'X:1\nK:C\nCDEF|', isUntitled: true, version: 3, viewId: 2, revision: 4 };

describe('双向消息白名单', () => {
  it('[SPEC-ENV-04] 非对象、未知类型和旧协议一律拒绝', () => {
    for (const value of [null, undefined, 'ready', [], {}, { type: 'unknown' }]) {
      expect(parseWebviewMessage(value)).toBeUndefined();
      expect(parseHostMessage(value)).toBeUndefined();
    }
    expect(parseWebviewMessage({ type: 'rendered', version: 3, ok: true })).toBeUndefined();
    expect(parseHostMessage({ type: 'playback', action: 'stop' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'ready', uri: 'ignored' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'reveal-source', viewId: 2, uri: 'ignored' })).toEqual({ type: 'reveal-source', viewId: 2 });
  });

  it('[SPEC-ENV-04] 所有上下文字段必须是安全非负整数，额外字段丢弃', () => {
    const rendered = { type: 'rendered', context, ok: true, linkable: true };
    expect(parseWebviewMessage({ ...rendered, context: { ...context, uri: 'ignored' }, path: 'ignored' })).toEqual(rendered);
    for (const key of Object.keys(context)) {
      for (const value of [undefined, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(parseWebviewMessage({ ...rendered, context: { ...context, [key]: value } })).toBeUndefined();
        expect(parseHostMessage({ type: 'cursor', context: { ...context, [key]: value }, offset: 0 })).toBeUndefined();
      }
    }
    expect(parseWebviewMessage({ ...rendered, ok: 'yes' })).toBeUndefined();
    expect(parseWebviewMessage({ ...rendered, linkable: undefined })).toBeUndefined();
    expect(sameContext(context, { ...context })).toBe(true);
    for (const key of Object.keys(context)) expect(sameContext(context, { ...context, [key]: 100 })).toBe(false);
    expect(sameContext(undefined, context)).toBe(false);
  });

  it('[SPEC-ENV-04] 停音动作按实例与请求编号校验，不强制匹配最新文档版本', () => {
    for (const action of ['toggle', 'pause', 'stop']) {
      const message = { type: 'playback', viewId: 2, requestId: 5, action, ...(action === 'toggle' ? { context } : {}) };
      expect(parseHostMessage({ ...message, uri: 'ignored' })).toEqual(message);
    }
    for (const state of ['idle', 'preparing', 'playing', 'paused']) {
      expect(parseWebviewMessage({ type: 'playback-state', context, state })).toEqual({ type: 'playback-state', context, state });
    }
    expect(parseWebviewMessage({ type: 'playback-state', context, state: 'unknown' })).toBeUndefined();
    expect(parseHostMessage({ type: 'playback', viewId: 2, requestId: 5, action: 'seek' })).toBeUndefined();
  });

  it('[SPEC-ENV-04] 范围必须非空正向且安全；数组最多16项，额外路径丢弃', () => {
    const ranges = [{ start: 1, end: 2 }];
    for (const type of ['source-highlight', 'target-ranges']) {
      expect(parseWebviewMessage({ type, context, ranges: [] })).toEqual({ type, context, ranges: [] });
      expect(parseWebviewMessage({ type, context, ranges: [{ ...ranges[0], uri: 'ignored' }] })).toEqual({ type, context, ranges });
      expect(parseWebviewMessage({ type, context, ranges: Array.from({ length: 17 }, () => ranges[0]) })).toBeUndefined();
      expect(parseWebviewMessage({ type, context, ranges: 'x' })).toBeUndefined();
    }
    for (const range of [{ start: 0, end: 0 }, { start: 8, end: 7 }, { start: -1, end: 1 }, { start: 0.5, end: 1 }, { start: 0, end: Infinity }, { start: 1 }]) {
      expect(parseWebviewMessage({ type: 'reveal-range', requestId: 1, context, ...range })).toBeUndefined();
      expect(parseWebviewMessage({ type: 'target-ranges', context, ranges: [range] })).toBeUndefined();
    }
    expect(parseWebviewMessage({ type: 'reveal-range', requestId: 1, context, start: 1, end: 2 })).toEqual({ type: 'reveal-range', requestId: 1, context, start: 1, end: 2 });
  });

  it('[SPEC-ENV-04] 联动说明仅接受登记原因，目标请求不能夹带偏移或 URI', () => {
    for (const reason of ['no-mapping', 'no-selection', 'update-pending', 'stale-score', 'choose-tune', 'structure-unreliable']) {
      expect(parseWebviewMessage({ type: 'linkage-unavailable', context, reason })).toEqual({ type: 'linkage-unavailable', context, reason });
    }
    expect(parseWebviewMessage({ type: 'linkage-unavailable', context, reason: 'other' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'play-from-selection-request', requestId: 1, context, offset: 2 })).toEqual({ type: 'play-from-selection-request', requestId: 1, context });
    expect(parseWebviewMessage({ type: 'context-invalidated', context })).toEqual({ type: 'context-invalidated', context });
  });

  it('[SPEC-ENV-04] 文档形状完整，首次源码意图必须在快照范围内', () => {
    expect(parseHostMessage(document)).toEqual(document);
    for (const key of Object.keys(document)) expect(parseHostMessage({ ...document, [key]: undefined })).toBeUndefined();
    const initialRequest = { requestId: 1, offset: 8 };
    expect(parseHostMessage({ ...document, initialRequest })).toEqual({ ...document, initialRequest });
    for (const offset of [-1, document.abc.length + 1, NaN, 1.5]) expect(parseHostMessage({ ...document, initialRequest: { ...initialRequest, offset } })).toBeUndefined();
  });

  it('[SPEC-ENV-04] 选曲往返核验请求与实例，嵌套和循环结构立即拒绝', () => {
    const request = { type: 'select-tune', context, requestId: 3 };
    expect(parseWebviewMessage(request)).toEqual(request);
    expect(parseWebviewMessage({ ...request, requestId: undefined })).toBeUndefined();
    const response = { type: 'selection-snapshot', viewId: 2, requestId: 3, document };
    expect(parseHostMessage(response)).toEqual(response);
    expect(parseHostMessage({ ...response, viewId: 4 })).toBeUndefined();
    expect(parseHostMessage({ ...response, document: response })).toBeUndefined();
    const cycle: Record<string, unknown> = { ...response };
    cycle.document = cycle;
    expect(parseHostMessage(cycle)).toBeUndefined();
  });

  it('[SPEC-ENV-04] 查阅可清除，显式起播必须带请求编号', () => {
    for (const offset of [0, 12, null]) expect(parseHostMessage({ type: 'cursor', context, offset })).toEqual({ type: 'cursor', context, offset });
    for (const offset of [-1, 1.5, undefined]) expect(parseHostMessage({ type: 'cursor', context, offset })).toBeUndefined();
    const source = { type: 'play-from-cursor', context, requestId: 5, offset: 3 };
    expect(parseHostMessage({ ...source, uri: 'ignored' })).toEqual(source);
    expect(parseHostMessage({ ...source, requestId: undefined })).toBeUndefined();
    const target = { type: 'play-from-selection', context, requestId: 6 };
    expect(parseHostMessage({ ...target, offset: 5 })).toEqual(target);
    expect(parseHostMessage({ ...target, targetRequestId: 8 })).toEqual({ ...target, targetRequestId: 8 });
    for (const requestId of [undefined, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseWebviewMessage({ type: 'reveal-range', context, requestId, start: 1, end: 2 })).toBeUndefined();
      expect(parseWebviewMessage({ type: 'play-from-selection-request', context, requestId })).toBeUndefined();
      if (requestId !== undefined) expect(parseHostMessage({ ...target, targetRequestId: requestId })).toBeUndefined();
    }
    expect(parseHostMessage({ type: 'playback', viewId: 2, requestId: 1, action: 'toggle' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'context-invalidated', context, cancelRequests: true })).toEqual({ type: 'context-invalidated', context, cancelRequests: true });
    expect(parseWebviewMessage({ type: 'context-invalidated', context, cancelRequests: 'true' })).toBeUndefined();
  });
});

describe('解析诊断消息', () => {
  it('[SPEC-STATE-06] 诊断只接受非空可靠区间与有限条数，查看问题只带实例编号', () => {
    const item = { message: 'Unknown character ignored', start: 1, end: 2 };
    expect(parseWebviewMessage({ type: 'diagnostics', context, items: [item] }))
      .toEqual({ type: 'diagnostics', context, items: [item] });
    expect(parseWebviewMessage({ type: 'diagnostics', context, items: [] }))
      .toEqual({ type: 'diagnostics', context, items: [] });
    expect(parseWebviewMessage({ type: 'diagnostics', context, items: [{ ...item, uri: 'ignored' }] }))
      .toEqual({ type: 'diagnostics', context, items: [item] });
    for (const bad of [
      { ...item, message: '' },
      { ...item, message: 3 },
      { ...item, start: -1 },
      { ...item, start: 2, end: 2 },
      { ...item, end: 1.5 },
    ]) expect(parseWebviewMessage({ type: 'diagnostics', context, items: [bad] })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'diagnostics', context, items: Array.from({ length: 33 }, () => item) })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'diagnostics', context, items: 'x' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'diagnostics', items: [item] })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'show-problems', viewId: 2, path: 'ignored' })).toEqual({ type: 'show-problems', viewId: 2 });
    expect(parseWebviewMessage({ type: 'show-problems', viewId: -1 })).toBeUndefined();
  });
});

describe('文件生命周期消息', () => {
  it('[SPEC-LIFE-03] [SPEC-LIFE-04] 迁移标记、来源状态与目标入口形状校验', () => {
    expect(parseHostMessage({ ...document, continued: true })).toEqual({ ...document, continued: true });
    expect(parseHostMessage({ ...document, continued: 'yes' })).toBeUndefined();
    for (const state of ['migrated', 'unavailable', 'disk-missing', 'available']) {
      expect(parseHostMessage({ type: 'source-state', viewId: 2, state, detail: 'x' }))
        .toEqual({ type: 'source-state', viewId: 2, state, detail: 'x' });
    }
    expect(parseHostMessage({ type: 'source-state', viewId: 2, state: 'gone', detail: '' })).toBeUndefined();
    expect(parseHostMessage({ type: 'source-state', viewId: 2, state: 'available', detail: 3 })).toBeUndefined();
    expect(parseHostMessage({ type: 'source-state', state: 'available', detail: '' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'reveal-target', viewId: 2, uri: 'ignored' })).toEqual({ type: 'reveal-target', viewId: 2 });
    expect(parseWebviewMessage({ type: 'reveal-target' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'reveal-target', viewId: -1 })).toBeUndefined();
  });
});
