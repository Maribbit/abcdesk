import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { PreviewPanelManager } from '../src/extension/previewPanel';
import { parseHostMessage, type HostMessage, type PreviewContext } from '../src/core/messages';
import { PRACTICE_SCHEMA_VERSION, practiceStorageKey, type PracticeRecord } from '../src/core/practice';

const env = vi.hoisted(() => ({
  panels: [] as Panel[], documents: [] as Doc[], editors: [] as Editor[], notices: [] as string[],
  openEditor: undefined as (() => Promise<Editor>) | undefined,
  files: new Map<string, string>(), statCalls: 0,
  watchers: [] as Array<{ create: () => void; change: () => void; delete: () => void; dispose: () => void }>,
  diagnosticCalls: [] as Array<{ kind: string; uri: string; values: unknown[] }>,
  commands: [] as string[],
  remember: true,
  folders: [{}] as unknown[],
  storage: new Map<string, unknown>(),
}));
function uri(value: string): vscode.Uri {
  const scheme = value.slice(0, value.indexOf(':'));
  const rest = value.slice(scheme.length + 1);
  const path = rest.startsWith('//') ? rest.slice(2) : rest;
  return { scheme, path, fsPath: path, toString: () => value } as unknown as vscode.Uri;
}
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
  Uri: {
    parse: (value: string) => uri(value),
    joinPath: (base: { toString(): string }, ...parts: string[]) => uri(`${base.toString()}/${parts.join('/')}`),
  },
  RelativePattern: class { constructor(readonly base: unknown, readonly pattern: string) {} },
  ThemeColor: class { constructor(readonly id: string) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Selection: class { constructor(readonly anchor: unknown, readonly active: unknown) {} },
  Diagnostic: class { source?: string; constructor(readonly range: unknown, readonly message: string, readonly severity: unknown) {} },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  OverviewRulerLane: { Center: 2 }, ViewColumn: { One: 1, Beside: 2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
  env: { language: 'en' },
  l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])) },
  commands: { executeCommand: (id: string) => { env.commands.push(id); return Promise.resolve(); } },
  languages: {
    createDiagnosticCollection: () => ({
      set: (target: { toString(): string }, values: unknown[]) => env.diagnosticCalls.push({ kind: 'set', uri: target.toString(), values }),
      delete: (target: { toString(): string }) => env.diagnosticCalls.push({ kind: 'delete', uri: target.toString(), values: [] }),
      clear: () => env.diagnosticCalls.push({ kind: 'clear', uri: '', values: [] }),
      dispose: () => env.diagnosticCalls.push({ kind: 'dispose', uri: '', values: [] }),
    }),
  },
  workspace: {
    get textDocuments() { return env.documents; },
    get workspaceFolders() { return env.folders; },
    getConfiguration: () => ({ get: () => env.remember }),
    createFileSystemWatcher: () => {
      const watcher = {
        create: () => {}, change: () => {}, delete: () => {}, dispose: () => {},
        onDidCreate: (handler: () => void) => { watcher.create = handler; return { dispose() {} }; },
        onDidChange: (handler: () => void) => { watcher.change = handler; return { dispose() {} }; },
        onDidDelete: (handler: () => void) => { watcher.delete = handler; return { dispose() {} }; },
      };
      env.watchers.push(watcher);
      return watcher;
    },
    fs: {
      stat: async (value: { toString(): string }) => {
        env.statCalls += 1;
        if (!env.files.has(value.toString())) throw new Error('missing');
      },
      readFile: async (value: { toString(): string }) => {
        const text = env.files.get(value.toString());
        if (text === undefined) throw new Error('missing');
        return new TextEncoder().encode(text);
      },
    },
    openTextDocument: async (value: { toString(): string }) => {
      const found = env.documents.find((document) => document.uri.toString() === value.toString());
      if (found === undefined) throw new Error('missing');
      return found;
    },
  },
  window: {
    get visibleTextEditors() { return env.editors; },
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    createWebviewPanel: () => { const panel = new Panel(); env.panels.push(panel); return panel; },
    showInformationMessage: (text: string) => { env.notices.push(text); return Promise.resolve(); },
    showTextDocument: () => env.openEditor?.(),
  },
}));
class MemoryState {
  get<T>(key: string, fallback?: T): T | undefined {
    return (env.storage.has(key) ? env.storage.get(key) : fallback) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) env.storage.delete(key);
    else env.storage.set(key, value);
    return Promise.resolve();
  }
  keys(): readonly string[] { return [...env.storage.keys()]; }
}
let manager: PreviewPanelManager;
let doc: Doc;
const asDocument = (doc: Doc) => doc as unknown as vscode.TextDocument;
function createManager(): PreviewPanelManager {
  return new PreviewPanelManager(uri('file:///extension') as vscode.Uri, new MemoryState() as unknown as vscode.Memento);
}
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
const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers();
  env.panels = []; env.documents = []; env.editors = []; env.notices = []; env.openEditor = undefined;
  env.files = new Map(); env.statCalls = 0; env.watchers = [];
  env.diagnosticCalls = []; env.commands = [];
  env.remember = true; env.folders = [{}]; env.storage = new Map();
  manager = createManager();
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

describe('文件生命周期与来源状态', () => {
  it('[SPEC-LIFE-03] 未保存文档首次保存接续身份，版本与暂停位置沿用最近推送', async () => {
    const unsaved = new Doc();
    unsaved.isUntitled = true;
    unsaved.uri = uri('untitled:1');
    env.documents.push(unsaved);
    const panel = open(unsaved);
    applied(panel);
    const pushed = last(panel, 'document');
    // 保存：同一 TextDocument 对象的 URI 原地更新为文件路径
    unsaved.uri = uri('file:///saved.abc');
    env.files.set('file:///saved.abc', unsaved.abc);
    manager.notifyDocumentSaved(asDocument(unsaved));
    await flush();
    expect(last(panel, 'playback').action).toBe('pause');
    expect(last(panel, 'document')).toMatchObject({
      uri: 'file:///saved.abc', fileName: 'saved.abc', continued: true,
      version: pushed.version, revision: pushed.revision,
    });
    // 换键后常规变更仍能找到该预览（绑定已迁移到新键）
    unsaved.version += 1;
    unsaved.abc += '\n% edit';
    manager.notifyDocumentChanged(asDocument(unsaved));
    await vi.advanceTimersByTimeAsync(300);
    expect(last(panel, 'document')).toMatchObject({ uri: 'file:///saved.abc', version: 2 });
  });

  it('[SPEC-LIFE-03] 重命名携带编辑：换版推送并标记 continued，不当作新文档', async () => {
    const panel = open(doc);
    applied(panel);
    const pushed = last(panel, 'document');
    doc.version += 1;
    doc.abc += '\n% edit';
    doc.uri = uri('file:///moved.abc');
    env.files.set('file:///moved.abc', doc.abc);
    manager.notifyFilesRenamed([{ oldUri: uri('file:///book.abc'), newUri: uri('file:///moved.abc') }]);
    await flush();
    const message = last(panel, 'document');
    expect(message).toMatchObject({ uri: 'file:///moved.abc', continued: true, version: 2 });
    expect(message.revision).toBe(pushed.revision + 1);
    expect(message.abc).toContain('% edit');
  });

  it('[SPEC-LIFE-04] 迁移到已绑定路径进入只读迁移页，目标入口按实例指向现有面板', async () => {
    const other = new Doc('target');
    env.documents.push(other);
    const panel = open(doc);
    applied(panel);
    const target = open(other);
    applied(target);
    manager.notifyFilesRenamed([{ oldUri: uri('file:///book.abc'), newUri: other.uri }]);
    await flush();
    expect(last(panel, 'source-state')).toMatchObject({ state: 'migrated', detail: 'target.abc' });
    expect(last(panel, 'playback').action).toBe('pause');
    expect(target.sent.filter((message) => message.type === 'playback')).toHaveLength(0);
    // 只读迁移页不再接受文档变化推送，也不执行旧绑定的播放 / 起播
    const count = panel.sent.length;
    doc.version += 1;
    doc.abc += '\n% orphan';
    manager.notifyDocumentChanged(asDocument(doc));
    manager.requestToggle(asDocument(doc));
    manager.requestPlayFromCursor(asDocument(doc), 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(panel.sent).toHaveLength(count);
    // "打开迁移后的预览"指向实际存在目标面板
    panel.received({ type: 'reveal-target', viewId: last(panel, 'document').viewId });
    expect(target.reveal).toHaveBeenCalled();
  });

  it('[SPEC-LIFE-06] [SPEC-LIFE-07] 无缓冲区删除进入不可用，重现后自动恢复推送归零', async () => {
    const panel = open(doc);
    applied(panel);
    const watcher = env.watchers.at(-1)!;
    env.documents = env.documents.filter((entry) => entry !== doc);
    env.files.delete('file:///book.abc');
    watcher.delete();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'source-state')).toMatchObject({ state: 'unavailable', detail: '/book.abc' });
    expect(last(panel, 'playback').action).toBe('stop');
    // 文件重现：重新获取并校验内容后归零推送，不自动播放
    env.documents.push(doc);
    env.files.set('file:///book.abc', doc.abc);
    watcher.create();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'document')).toMatchObject({ uri: 'file:///book.abc', version: 1 });
    // 恢复后回到常规推送路径
    doc.version += 1;
    doc.abc += '\n% resumed';
    manager.notifyDocumentChanged(asDocument(doc));
    await vi.advanceTimersByTimeAsync(300);
    expect(last(panel, 'document').version).toBe(2);
  });

  it('[SPEC-LIFE-06] 有缓冲区时磁盘缺失只提示不锁定，磁盘恢复清除提示', async () => {
    const panel = open(doc);
    applied(panel);
    const watcher = env.watchers.at(-1)!;
    env.files.delete('file:///book.abc');
    watcher.delete();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'source-state')).toMatchObject({ state: 'disk-missing', detail: '/book.abc' });
    // 不停音、不进入只读：缓冲区继续作为预览来源
    expect(panel.sent.filter((message) => message.type === 'playback')).toHaveLength(0);
    env.files.set('file:///book.abc', doc.abc);
    watcher.change();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'source-state')).toMatchObject({ state: 'available' });
    expect(last(panel, 'document').version).toBe(1);
  });

  it('[SPEC-LIFE-08] 连续文件事件合并为一次存在性核验，短暂删除不误判丢失', async () => {
    const panel = open(doc);
    applied(panel);
    const watcher = env.watchers.at(-1)!;
    env.documents = [];
    env.statCalls = 0;
    // 原子替换：短暂删除后立即重建，全部在防抖窗口内
    watcher.delete();
    watcher.create();
    env.files.set('file:///book.abc', doc.abc);
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(env.statCalls).toBe(1);
    expect(panel.sent.filter((message) => message.type === 'source-state')).toHaveLength(0);
  });

  it('[SPEC-LIFE-05] 文件另存为不迁移绑定，原预览按原文件内容更新', async () => {
    const panel = open(doc);
    applied(panel);
    const pushed = last(panel, 'document');
    doc.uri = uri('file:///copy.abc');
    env.files.set('file:///copy.abc', doc.abc);
    const original = new Doc();
    original.version = 2;
    original.abc += '\n% disk';
    env.documents.push(original);
    manager.notifyDocumentSaved(asDocument(doc));
    await flush();
    const message = last(panel, 'document');
    expect(message).toMatchObject({ uri: 'file:///book.abc', version: 2 });
    expect(message.continued).toBeUndefined();
    expect(message.revision).toBe(pushed.revision + 1);
  });

  it('[SPEC-LIFE-06] 未保存文档真正关闭进入来源不可用（来源对象已不存在）', () => {
    const unsaved = new Doc();
    unsaved.isUntitled = true;
    unsaved.uri = uri('untitled:1');
    env.documents.push(unsaved);
    const panel = open(unsaved);
    applied(panel);
    manager.notifyDocumentClosed(asDocument(unsaved));
    expect(last(panel, 'source-state')).toMatchObject({ state: 'unavailable', detail: '1' });
    expect(last(panel, 'playback').action).toBe('stop');
  });

  it('[SPEC-LIFE-07] 不可用后重新打开预览解除只读并按当前内容推送', async () => {
    const panel = open(doc);
    applied(panel);
    env.documents = [];
    env.files.delete('file:///book.abc');
    env.watchers.at(-1)!.delete();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'source-state').state).toBe('unavailable');
    env.documents.push(doc);
    env.files.set('file:///book.abc', doc.abc);
    manager.createOrShow(asDocument(doc));
    await flush();
    expect(panel.reveal).toHaveBeenCalled();
    expect(last(panel, 'document')).toMatchObject({ uri: 'file:///book.abc' });
    // 恢复后可继续接受常规更新
    doc.version += 1;
    doc.abc += '\n% again';
    manager.notifyDocumentChanged(asDocument(doc));
    await vi.advanceTimersByTimeAsync(300);
    expect(last(panel, 'document').version).toBe(2);
  });
});

describe('解析诊断与问题入口', () => {
  const item = { message: 'Unknown character ignored', start: 1, end: 2 };

  it('[SPEC-STATE-06] 诊断按文档与版本发布，空列表与越界位置不保留', () => {
    const panel = open(doc);
    const context = applied(panel);
    panel.received({ type: 'diagnostics', context, items: [item] });
    const published = env.diagnosticCalls.at(-1)!;
    expect(published).toMatchObject({ kind: 'set', uri: 'file:///book.abc' });
    expect(published.values[0]).toMatchObject({
      message: 'ABC parse warning: Unknown character ignored',
      severity: 1,
      source: 'ABC Desk',
    });
    // 过期 / 旧修订的晚到结果不覆盖当前诊断（SPEC-STATE-02 / 06）
    panel.received({ type: 'diagnostics', context: { ...context, version: 99 }, items: [] });
    expect(env.diagnosticCalls.at(-1)).toBe(published);
    panel.received({ type: 'diagnostics', context: { ...context, revision: 9 }, items: [] });
    expect(env.diagnosticCalls.at(-1)).toBe(published);
    // 越界位置视为无效；全空即清除
    panel.received({ type: 'diagnostics', context, items: [{ ...item, end: 9999 }] });
    expect(env.diagnosticCalls.at(-1)).toMatchObject({ kind: 'delete', uri: 'file:///book.abc' });
    panel.received({ type: 'diagnostics', context, items: [] });
    expect(env.diagnosticCalls.at(-1)).toMatchObject({ kind: 'delete', uri: 'file:///book.abc' });
  });

  it('[SPEC-STATE-06] 内容未变的可靠迁移让 Problems 条目跟随新身份', async () => {
    const panel = open(doc);
    const context = applied(panel);
    panel.received({ type: 'diagnostics', context, items: [item] });
    const oldUri = doc.uri;
    doc.uri = uri('file:///moved.abc');
    manager.notifyFilesRenamed([{ oldUri, newUri: doc.uri }]);
    await flush();
    expect(env.diagnosticCalls.filter((call) => call.kind === 'delete').at(-1)?.uri).toBe('file:///book.abc');
    expect(env.diagnosticCalls.filter((call) => call.kind === 'set').at(-1)?.uri).toBe('file:///moved.abc');
    expect(last(panel, 'document').continued).toBe(true);
  });

  it('[SPEC-STATE-06] 迁移冲突转只读后清除并拒收旧绑定诊断', async () => {
    const panel = open(doc);
    const context = applied(panel);
    panel.received({ type: 'diagnostics', context, items: [item] });
    const target = new Doc('target');
    env.documents.push(target);
    const targetPanel = open(target);
    const count = env.diagnosticCalls.length;
    manager.notifyFilesRenamed([{ oldUri: doc.uri, newUri: target.uri }]);
    await flush();
    expect(last(panel, 'source-state').state).toBe('migrated');
    expect(env.diagnosticCalls.slice(count)[0]).toMatchObject({ kind: 'delete', uri: 'file:///book.abc' });
    // 旧绑定的晚到诊断不重新进入 Problems，也不影响目标面板
    const after = env.diagnosticCalls.length;
    panel.received({ type: 'diagnostics', context, items: [item] });
    expect(env.diagnosticCalls).toHaveLength(after);
    expect(last(targetPanel, 'document').uri).toBe('file:///target.abc');
  });

  it('[SPEC-STATE-06] 面板关闭清除诊断，“查看问题”只执行宿主命令', () => {
    const panel = open(doc);
    const context = applied(panel);
    panel.received({ type: 'diagnostics', context, items: [item] });
    const viewId = context.viewId;
    panel.received({ type: 'show-problems', viewId });
    expect(env.commands).toEqual(['workbench.action.problems.focus']);
    panel.received({ type: 'show-problems', viewId: viewId + 1 });
    expect(env.commands).toEqual(['workbench.action.problems.focus']);
    panel.dispose();
    expect(env.diagnosticCalls.at(-1)).toMatchObject({ kind: 'delete', uri: 'file:///book.abc' });
  });
});

describe('练习记录持久化', () => {
  const key = (uriText = 'file:///book.abc') => practiceStorageKey(uriText);
  const record = (speed = 70, keyboardCollapsed = true): PracticeRecord => ({
    version: PRACTICE_SCHEMA_VERSION,
    ui: { keyboardCollapsed, keyboardMode: 'full' },
    tunes: [{ id: '1', signature: 'sig-1', settings: { speed, loop: true, chordsMuted: true, mutedVoices: [0] } }],
  });
  const settings = (speed: number) => ({ speed, loop: true, chordsMuted: false, mutedVoices: [] });
  const report = (context: PreviewContext, tunes: PracticeRecord['tunes']) => ({
    type: 'practice-state' as const, context, ui: { keyboardCollapsed: false, keyboardMode: 'tune' as const }, tunes,
  });
  /** 用已知的工作区状态重建管理器：记录在建面板时读取。 */
  function reopen(): void {
    manager.dispose();
    manager = createManager();
  }

  it('[SPEC-SET-02] 记录只随视图首次推送，后续换版不再附带', async () => {
    env.storage.set(key(), record());
    reopen();
    const panel = open(doc);
    expect(last(panel, 'document').practice).toMatchObject({
      ui: { keyboardCollapsed: true, keyboardMode: 'full' },
      tunes: [{ id: '1', signature: 'sig-1' }],
    });
    applied(panel);
    doc.version += 1;
    doc.abc += '\n% edit';
    manager.notifyDocumentChanged(asDocument(doc));
    await vi.advanceTimersByTimeAsync(300);
    const message = last(panel, 'document');
    expect(message.version).toBe(2);
    expect(message.practice).toBeUndefined();
  });

  it('[SPEC-SET-08] 无效记录安全回退默认值，且不删除原始存储', () => {
    const invalid = { version: 2, ui: {}, tunes: 'x' };
    env.storage.set(key(), invalid);
    reopen();
    const panel = open(doc);
    expect(last(panel, 'document').practice).toBeUndefined();
    expect(env.storage.get(key())).toBe(invalid);
  });

  it('[SPEC-SET-06] 关闭记忆开关不读不写，当前会话仍可继续上报', () => {
    const stored = record();
    env.storage.set(key(), stored);
    env.remember = false;
    reopen();
    const panel = open(doc);
    expect(last(panel, 'document').practice).toBeUndefined();
    panel.received(report(applied(panel), [{ id: '1', signature: 'sig-1', settings: settings(55) }]));
    expect(env.storage.get(key())).toBe(stored);
  });

  it('[SPEC-SET-03] [SPEC-SET-08] 上报只合并当前可靠曲目，未变化与过期修订不重写', () => {
    const panel = open(doc);
    const context = applied(panel);
    // 当前文档不存在的曲目（X:9）不进入持久记录
    panel.received(report(context, [
      { id: '2', signature: 'sig-2', settings: { speed: 90, loop: false, chordsMuted: true, mutedVoices: [1] } },
      { id: '9', signature: null, settings: settings(80) },
    ]));
    const first = env.storage.get(key()) as PracticeRecord;
    expect(first.tunes.map((tune) => tune.id)).toEqual(['2']);
    // 未提及的旧曲目保留，同一曲目以新记录覆盖
    panel.received(report(context, [{ id: '1', signature: 'sig-1', settings: settings(60) }]));
    const merged = env.storage.get(key()) as PracticeRecord;
    expect(merged.tunes.map((tune) => tune.id)).toEqual(['1', '2']);
    // 相同状态重复上报不触发写入
    panel.received(report(context, merged.tunes));
    expect(env.storage.get(key())).toBe(merged);
    // 过期修订（内容已换版）不覆盖当前记录
    panel.received(report({ ...context, revision: context.revision + 1 }, [{ id: '1', signature: null, settings: settings(25) }]));
    expect(env.storage.get(key())).toBe(merged);
  });

  it('[SPEC-SET-07] 重置删除当前文件记录，重新就绪不再恢复', () => {
    env.storage.set(key(), record());
    reopen();
    const panel = open(doc);
    const context = applied(panel);
    panel.received({ type: 'reset-practice', context });
    expect(env.storage.has(key())).toBe(false);
    panel.received({ type: 'ready' });
    expect(last(panel, 'document').practice).toBeUndefined();
  });

  it('[SPEC-SET-02] 未保存文档只留会话内，首次保存后随绑定迁移落盘', async () => {
    const unsaved = new Doc();
    unsaved.isUntitled = true;
    unsaved.uri = uri('untitled:1');
    env.documents.push(unsaved);
    const panel = open(unsaved);
    const context = applied(panel);
    panel.received(report(context, [{ id: '1', signature: 'sig-1', settings: settings(55) }]));
    expect(env.storage.size).toBe(0);
    unsaved.uri = uri('file:///saved.abc');
    env.files.set('file:///saved.abc', unsaved.abc);
    manager.notifyDocumentSaved(asDocument(unsaved));
    await flush();
    expect(env.storage.get(key('file:///saved.abc'))).toMatchObject({
      tunes: [{ id: '1', signature: 'sig-1', settings: settings(55) }],
    });
    expect(last(panel, 'document')).toMatchObject({ uri: 'file:///saved.abc', continued: true });
  });

  it('[SPEC-LIFE-04] [SPEC-SET-08] 迁移目标已有记录时目标优先，不覆盖不删除来源', async () => {
    const source = record();
    const target = record(40, false);
    env.storage.set(key(), source);
    env.storage.set(key('file:///moved.abc'), target);
    reopen();
    const panel = open(doc);
    const context = applied(panel);
    doc.uri = uri('file:///moved.abc');
    manager.notifyFilesRenamed([{ oldUri: uri('file:///book.abc'), newUri: doc.uri }]);
    await flush();
    expect(last(panel, 'source-state').state).toBe('migrated');
    expect(env.storage.get(key('file:///moved.abc'))).toBe(target);
    expect(env.storage.get(key())).toBe(source);
    // 只读迁移页的迟到上报不写入
    panel.received(report(context, [{ id: '1', signature: 'sig-1', settings: settings(25) }]));
    expect(env.storage.get(key())).toBe(source);
  });

  it('[SPEC-SET-08] 无工作区不落盘', () => {
    env.folders = [];
    const panel = open(doc);
    panel.received(report(applied(panel), [{ id: '1', signature: 'sig-1', settings: settings(55) }]));
    expect(env.storage.size).toBe(0);
  });
});
