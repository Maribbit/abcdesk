import { describe, expect, it } from 'vitest';
import { parseHostMessage, parseWebviewMessage, sameContext } from '../src/core/messages';

const context = { viewId: 2, revision: 4, version: 3, selection: 1 };
const document = { type: 'document', uri: 'untitled:1', fileName: '1', abc: 'X:1\nK:C\nCDEF|', isUntitled: true, version: 3, viewId: 2, revision: 4 };

describe('bidirectional message allowlist', () => {
  it('[SPEC-ENV-04] non-objects, unknown types and the old protocol are all rejected', () => {
    for (const value of [null, undefined, 'ready', [], {}, { type: 'unknown' }]) {
      expect(parseWebviewMessage(value)).toBeUndefined();
      expect(parseHostMessage(value)).toBeUndefined();
    }
    expect(parseWebviewMessage({ type: 'rendered', version: 3, ok: true })).toBeUndefined();
    expect(parseHostMessage({ type: 'playback', action: 'stop' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'ready', uri: 'ignored' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'reveal-source', viewId: 2, uri: 'ignored' })).toEqual({ type: 'reveal-source', viewId: 2 });
  });

  it('[SPEC-ENV-04] all context fields must be safe non-negative integers; extra fields are dropped', () => {
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

  it('[SPEC-ENV-04] the silence action is validated by instance and request number without requiring the latest document version', () => {
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

  it('[SPEC-ENV-04] ranges must be non-empty, forward and safe; arrays hold at most 16 items and extra paths are dropped', () => {
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

  it('[SPEC-ENV-04] linkage explanations accept only registered reasons; target requests cannot smuggle offsets or URIs', () => {
    for (const reason of ['no-mapping', 'no-selection', 'update-pending', 'stale-score', 'choose-tune', 'structure-unreliable']) {
      expect(parseWebviewMessage({ type: 'linkage-unavailable', context, reason })).toEqual({ type: 'linkage-unavailable', context, reason });
    }
    expect(parseWebviewMessage({ type: 'linkage-unavailable', context, reason: 'other' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'play-from-selection-request', requestId: 1, context, offset: 2 })).toEqual({ type: 'play-from-selection-request', requestId: 1, context });
    expect(parseWebviewMessage({ type: 'context-invalidated', context })).toEqual({ type: 'context-invalidated', context });
  });

  it('[SPEC-ENV-04] the document shape is complete and the initial source intent must lie within the snapshot', () => {
    expect(parseHostMessage(document)).toEqual(document);
    for (const key of Object.keys(document)) expect(parseHostMessage({ ...document, [key]: undefined })).toBeUndefined();
    const initialRequest = { requestId: 1, offset: 8 };
    expect(parseHostMessage({ ...document, initialRequest })).toEqual({ ...document, initialRequest });
    for (const offset of [-1, document.abc.length + 1, NaN, 1.5]) expect(parseHostMessage({ ...document, initialRequest: { ...initialRequest, offset } })).toBeUndefined();
  });

  it('[SPEC-ENV-04] tune selection round trips verify request and instance; nested and cyclic structures are rejected immediately', () => {
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

  it('[SPEC-ENV-04] inspection can be cleared; an explicit start must carry a request number', () => {
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

describe('parse diagnostics messages', () => {
  it('[SPEC-STATE-06] diagnostics accept only non-empty reliable ranges and a bounded count; view-problems carries only the instance number', () => {
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

describe('file lifecycle messages', () => {
  it('[SPEC-LIFE-03] [SPEC-LIFE-04] migration marker, source status and target entry shapes are validated', () => {
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

describe('practice settings messages', () => {
  const settings = { speed: 100, loop: false, chordsMuted: false, mutedVoices: [3, 1] };
  const practice = {
    version: 1,
    ui: { keyboardCollapsed: false, keyboardMode: 'tune' },
    tunes: [{ id: '1', signature: 'v1', settings }],
  };

  it('[SPEC-SET-03] [SPEC-SET-04] [SPEC-SET-08] reports are validated and normalized as a whole record', () => {
    expect(parseWebviewMessage({ type: 'practice-state', context, ...practice, ui: practice.ui, tunes: practice.tunes, path: 'ignored' }))
      .toEqual({
        type: 'practice-state',
        context,
        ui: practice.ui,
        tunes: [{ id: '1', signature: 'v1', settings: { ...settings, mutedVoices: [1, 3] } }],
      });
    // When the voice list cannot be confirmed, mutes do not enter the persistent shape
    expect(parseWebviewMessage({ type: 'practice-state', context, ui: practice.ui, tunes: [{ ...practice.tunes[0], signature: null }] }))
      .toMatchObject({ tunes: [{ signature: null, settings: { mutedVoices: [] } }] });
    for (const bad of [
      { ui: { keyboardCollapsed: 'no', keyboardMode: 'tune' }, tunes: [] },
      { ui: practice.ui, tunes: [{ ...practice.tunes[0], settings: { ...settings, speed: 201 } }] },
      { ui: practice.ui, tunes: [{ ...practice.tunes[0], settings: { ...settings, mutedVoices: [0.5] } }] },
      { ui: practice.ui, tunes: [practice.tunes[0], practice.tunes[0]] },
      { ui: practice.ui, tunes: 'x' },
    ]) expect(parseWebviewMessage({ type: 'practice-state', context, ...bad })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'practice-state', ...practice })).toBeUndefined();
  });

  it('[SPEC-SET-07] reset carries only the current context, no paths or records', () => {
    expect(parseWebviewMessage({ type: 'reset-practice', context, uri: 'ignored', tunes: [] }))
      .toEqual({ type: 'reset-practice', context });
    expect(parseWebviewMessage({ type: 'reset-practice' })).toBeUndefined();
  });

  it('[SPEC-SET-02] an invalid document record is ignored without rejecting the whole document', () => {
    expect(parseHostMessage({ ...document, practice })).toEqual({
      ...document,
      practice: { ...practice, tunes: [{ ...practice.tunes[0], settings: { ...settings, mutedVoices: [1, 3] } }] },
    });
    expect(parseHostMessage({ ...document, practice: { ...practice, version: 2 } })).toEqual(document);
    expect(parseHostMessage({ ...document, practice: { ...practice, tunes: [{ ...practice.tunes[0], id: '' }] } })).toEqual(document);
    expect(parseHostMessage({ ...document, practice: 'x' })).toEqual(document);
  });
});
