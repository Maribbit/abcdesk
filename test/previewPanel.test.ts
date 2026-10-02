import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { PreviewPanelManager } from '../src/extension/previewPanel';
import { parseHostMessage, type HostMessage, type PreviewContext } from '../src/core/messages';

const env = vi.hoisted(() => ({ panels: [] as Panel[], documents: [] as Doc[], editors: [] as Editor[], notices: [] as string[], openEditor: undefined as (() => Promise<Editor>) | undefined }));
function uri(value: string) { return { toString: () => value, path: value.replace('file://', '') }; }
class Doc {
  uri;
  isUntitled = false;
  version = 1;
  abc = 'X:1\nK:C\nCDEF|\n\nX:2\nK:G\nGABc|';
  constructor(name = 'book') { this.uri = uri(`file:///${name}.abc`); }
  getText() { return this.abc; }
  positionAt(offset: number) { return { line: 0, character: offset }; }
  offsetAt(position: { character: number }) { return position.character; }
}
class Editor {
  selection: unknown;
  setDecorations = vi.fn();
  revealRange = vi.fn();
  constructor(readonly document: Doc) {}
}
class Panel {
  visible = true;
  active = false;
  title = '';
  received: (value: unknown) => void = () => {};
  changed = () => {};
  disposed = () => {};
  sent: HostMessage[] = [];
  webview = {
    html: '', cspSource: 'vscode-resource:', asWebviewUri: (value: unknown) => value,
    postMessage: (message: unknown) => {
      const parsed = parseHostMessage(message);
      expect(parsed, '宿主必须发送完整的新协议消息').toBeDefined();
      this.sent.push(parsed!);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (handler: Panel['received']) => { this.received = handler; return { dispose() {} }; },
  };
  reveal = vi.fn(() => { this.visible = true; });
  onDidChangeViewState = (handler: () => void) => { this.changed = handler; };
  onDidDispose = (handler: () => void) => { this.disposed = handler; };
  dispose = () => this.disposed();
}
vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { toString(): string }, ...parts: string[]) => uri(`${base.toString()}/${parts.join('/')}`) },
  ThemeColor: class { constructor(readonly id: string) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Selection: class { constructor(readonly anchor: unknown, readonly active: unknown) {} },
  OverviewRulerLane: { Center: 2 }, ViewColumn: { One: 1, Beside: 2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
  env: { language: 'en' }, l10n: { t: (text: string) => text },
  workspace: { get textDocuments() { return env.documents; } },
  window: {
    get visibleTextEditors() { return env.editors; },
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    createWebviewPanel: () => { const panel = new Panel(); env.panels.push(panel); return panel; },
    showInformationMessage: (text: string) => { env.notices.push(text); return Promise.resolve(); },
    showTextDocument: () => env.openEditor?.(),
  },
}));
let manager: PreviewPanelManager;
let doc: Doc;
const asDocument = (doc: Doc) => doc as unknown as vscode.TextDocument;
function last<T extends HostMessage['type']>(panel: Panel, type: T) {
  return panel.sent.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type).at(-1)!;
}
function applied(panel: Panel, selection = 1, linkable = true): PreviewContext {
  const message = last(panel, 'document');
  const context = { viewId: message.viewId, revision: message.revision, version: message.version, selection };
  panel.received({ type: 'context-invalidated', context });
  panel.received({ type: 'rendered', context, ok: linkable, linkable });
  return context;
}
function open(doc: Doc) {
  manager.createOrShow(asDocument(doc));
  const panel = env.panels.at(-1)!;
  panel.received({ type: 'ready' });
  return panel;
}
beforeEach(() => {
  vi.useFakeTimers();
  env.panels = []; env.documents = []; env.editors = []; env.notices = []; env.openEditor = undefined;
  manager = new PreviewPanelManager(uri('file:///extension') as vscode.Uri);
  doc = new Doc();
  env.documents.push(doc);
});
afterEach(() => { manager.dispose(); vi.useRealTimers(); });

describe('宿主快照、上下文与起播往返', () => {
  it('[SPEC-CMD-07] 首次源码起播意图随初始化发送，保留焦点且不先等待第一首', () => {
    manager.requestPlayFromCursor(asDocument(doc), doc.abc.indexOf('GABc'));
    const panel = env.panels[0];
    expect(panel.reveal).toHaveBeenCalledWith(undefined, true);
    panel.received({ type: 'ready' });
    expect(last(panel, 'document').initialRequest?.offset).toBe(doc.abc.indexOf('GABc'));
    expect(panel.sent.filter((message) => message.type === 'play-from-cursor')).toHaveLength(0);
  });

  it('[SPEC-DOC-04] 选曲刷新覆盖尚在防抖窗口的编辑，响应保留请求编号', () => {
    const panel = open(doc);
    const context = applied(panel);
    doc.version += 1; doc.abc = doc.abc.replace('X:2', 'X:3');
    manager.notifyDocumentChanged(asDocument(doc));
    panel.received({ type: 'select-tune', context, requestId: 9 });
    const response = last(panel, 'selection-snapshot');
    expect(response.requestId).toBe(9);
    expect(response.document.version).toBe(2);
    expect(response.document.abc).toContain('X:3');
    const count = panel.sent.length;
    vi.advanceTimersByTime(300);
    expect(panel.sent).toHaveLength(count);
  });

  it('[SPEC-ENV-04] 旧选择/实例的渲染和越界范围拒绝，错误状态可标记文档已应用', () => {
    const panel = open(doc);
    const old = applied(panel);
    const current = { ...old, selection: 2 };
    panel.received({ type: 'context-invalidated', context: current });
    panel.received({ type: 'rendered', context: old, ok: true, linkable: true });
    const editor = new Editor(doc); env.editors.push(editor);
    panel.received({ type: 'reveal-range', requestId: 1, context: old, start: 8, end: 9 });
    expect(editor.revealRange).not.toHaveBeenCalled();
    panel.received({ type: 'rendered', context: current, ok: false, linkable: false });
    expect(manager.isPreviewStale(doc.uri.toString())).toBe(false);
    panel.received({ type: 'rendered', context: current, ok: true, linkable: true });
    panel.received({ type: 'reveal-range', requestId: 1, context: current, start: 0, end: doc.abc.length + 1 });
    expect(editor.revealRange).not.toHaveBeenCalled();
    panel.received({ type: 'reveal-range', requestId: 1, context: current, start: 8, end: 9 });
    expect(editor.revealRange).toHaveBeenCalledOnce();
    panel.received({ type: 'ready' });
    panel.received({ type: 'reveal-range', requestId: 1, context: current, start: 8, end: 9 });
    expect(editor.revealRange).toHaveBeenCalledOnce();
  });

  it('[SPEC-PLAY-01] 旧快照播放状态仍参与互斥，旧实例不能控制新面板', () => {
    const panel = open(doc);
    const context = applied(panel);
    const otherDoc = new Doc('other'); env.documents.push(otherDoc);
    const other = open(otherDoc); applied(other);
    doc.version += 1; doc.abc += '\n% change';
    manager.notifyDocumentChanged(asDocument(doc));
    vi.advanceTimersByTime(300);
    panel.received({ type: 'playback-state', context, state: 'playing' });
    expect(last(other, 'playback').action).toBe('pause');
    const count = other.sent.length;
    panel.received({ type: 'playback-state', context: { ...context, viewId: 999 }, state: 'playing' });
    expect(other.sent).toHaveLength(count);
  });

  it('[SPEC-PLAY-12] 播放/准备中的未应用更新拒绝源码起播，停止仍能取消', () => {
    const panel = open(doc);
    const context = applied(panel);
    panel.received({ type: 'playback-state', context, state: 'preparing' });
    doc.version += 1; doc.abc += '\n% change';
    manager.notifyDocumentChanged(asDocument(doc));
    manager.requestPlayFromCursor(asDocument(doc), 8);
    expect(env.notices.at(-1)).toContain('unapplied');
    manager.requestStop(asDocument(doc));
    expect(last(panel, 'playback').action).toBe('stop');
  });

  it('[SPEC-ENV-04] 预览本地停止会取消宿主仍在等新版渲染的源码起播', () => {
    const panel = open(doc);
    const old = applied(panel);
    doc.version += 1; doc.abc += '\n% update';
    manager.notifyDocumentChanged(asDocument(doc));
    manager.requestPlayFromCursor(asDocument(doc), 8);
    panel.received({ type: 'context-invalidated', context: { ...old, selection: 2 }, cancelRequests: true });
    applied(panel, 3);
    expect(panel.sent.filter((message) => message.type === 'play-from-cursor')).toHaveLength(0);
  });

  it('[SPEC-ENV-04] 同一上下文的迟到定位不覆盖后请求，目标起播回传原请求编号', async () => {
    const panel = open(doc);
    const context = applied(panel);
    const resolves: Array<(editor: Editor) => void> = [];
    env.openEditor = () => new Promise<Editor>((resolve) => { resolves.push(resolve); });
    panel.received({ type: 'reveal-range', requestId: 1, context, start: 8, end: 9 });
    panel.received({ type: 'reveal-range', requestId: 2, context, start: 9, end: 10 });
    panel.received({ type: 'reveal-range', requestId: 1, context, start: 8, end: 9 });
    expect(resolves).toHaveLength(2);
    const editor = new Editor(doc);
    resolves[1](editor);
    await Promise.resolve();
    const selection = editor.selection;
    resolves[0](editor);
    await Promise.resolve();
    expect(editor.selection).toBe(selection);
    expect(editor.revealRange).toHaveBeenCalledOnce();
    panel.received({ type: 'play-from-selection-request', context, requestId: 7 });
    expect(last(panel, 'play-from-selection').targetRequestId).toBe(7);
    const count = panel.sent.length;
    panel.received({ type: 'play-from-selection-request', context, requestId: 6 });
    expect(panel.sent).toHaveLength(count);
    manager.requestToggle(asDocument(doc));
    expect(last(panel, 'playback')).toMatchObject({ action: 'toggle', context });
  });

  it('[SPEC-ENV-04] 打开源码的异步定位完成前切曲，旧选区不能落到新状态', async () => {
    const panel = open(doc);
    const context = applied(panel);
    let resolve!: (editor: Editor) => void;
    env.openEditor = () => new Promise<Editor>((accept) => { resolve = accept; });
    panel.received({ type: 'reveal-range', requestId: 1, context, start: 8, end: 9 });
    panel.received({ type: 'context-invalidated', context: { ...context, selection: 2 } });
    const editor = new Editor(doc);
    resolve(editor);
    await Promise.resolve();
    expect(editor.selection).toBeUndefined();
    expect(editor.revealRange).not.toHaveBeenCalled();
  });
});
