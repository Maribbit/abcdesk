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
      expect(parsed, 'the host must send complete new-protocol messages').toBeDefined();
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

describe('host snapshots, context and start round trips', () => {
  it('[SPEC-CMD-07] the initial source start intent is sent with initialization, keeps focus and does not wait for the first tune first', () => {
    manager.requestPlayFromCursor(asDocument(doc), doc.abc.indexOf('GABc'));
    const panel = env.panels[0];
    expect(panel.reveal).toHaveBeenCalledWith(undefined, true);
    panel.received({ type: 'ready' });
    expect(last(panel, 'document').initialRequest?.offset).toBe(doc.abc.indexOf('GABc'));
    expect(panel.sent.filter((message) => message.type === 'play-from-cursor')).toHaveLength(0);
  });

  it('[SPEC-DOC-04] a tune selection refresh overrides edits still in the debounce window and the response keeps the request number', () => {
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

  it('[SPEC-ENV-04] renders from old selections/instances and out-of-range ranges are rejected; an error state can still mark the document applied', () => {
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

  it('[SPEC-PLAY-01] the playback state of an old snapshot still takes part in mutual exclusion; an old instance cannot control the new panel', () => {
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

  it('[SPEC-PLAY-12] an unapplied update while playing/preparing rejects source starts; stop can still cancel', () => {
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

  it('[SPEC-ENV-04] a local stop in the preview cancels a source start the host is still waiting on for the new render', () => {
    const panel = open(doc);
    const old = applied(panel);
    doc.version += 1; doc.abc += '\n% update';
    manager.notifyDocumentChanged(asDocument(doc));
    manager.requestPlayFromCursor(asDocument(doc), 8);
    panel.received({ type: 'context-invalidated', context: { ...old, selection: 2 }, cancelRequests: true });
    applied(panel, 3);
    expect(panel.sent.filter((message) => message.type === 'play-from-cursor')).toHaveLength(0);
  });

  it('[SPEC-ENV-04] a late locate in the same context does not override a later request; the target start reports the original request number', async () => {
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

  it('[SPEC-ENV-04] switching tunes before the async locate of go-to-source completes keeps the old selection off the new state', async () => {
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

describe('file lifecycle and source status', () => {
  it('[SPEC-LIFE-03] the first save of an unsaved document continues its identity; version and paused position follow the latest push', async () => {
    const unsaved = new Doc();
    unsaved.isUntitled = true;
    unsaved.uri = uri('untitled:1');
    env.documents.push(unsaved);
    const panel = open(unsaved);
    applied(panel);
    const pushed = last(panel, 'document');
    // Save: the same TextDocument object has its URI updated in place to the file path
    unsaved.uri = uri('file:///saved.abc');
    env.files.set('file:///saved.abc', unsaved.abc);
    manager.notifyDocumentSaved(asDocument(unsaved));
    await flush();
    expect(last(panel, 'playback').action).toBe('pause');
    expect(last(panel, 'document')).toMatchObject({
      uri: 'file:///saved.abc', fileName: 'saved.abc', continued: true,
      version: pushed.version, revision: pushed.revision,
    });
    // After rekeying, regular changes still find the preview (the binding has migrated to the new key)
    unsaved.version += 1;
    unsaved.abc += '\n% edit';
    manager.notifyDocumentChanged(asDocument(unsaved));
    await vi.advanceTimersByTimeAsync(300);
    expect(last(panel, 'document')).toMatchObject({ uri: 'file:///saved.abc', version: 2 });
  });

  it('[SPEC-LIFE-03] a rename carrying edits pushes a version switch marked continued, not treated as a new document', async () => {
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

  it('[SPEC-LIFE-04] migrating onto an already bound path enters the read-only migration page; the target entry points to the existing panel by instance', async () => {
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
    // The read-only migration page no longer accepts document change pushes and does not play / start the old binding
    const count = panel.sent.length;
    doc.version += 1;
    doc.abc += '\n% orphan';
    manager.notifyDocumentChanged(asDocument(doc));
    manager.requestToggle(asDocument(doc));
    manager.requestPlayFromCursor(asDocument(doc), 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(panel.sent).toHaveLength(count);
    // "Open the migrated preview" points at the actually existing target panel
    panel.received({ type: 'reveal-target', viewId: last(panel, 'document').viewId });
    expect(target.reveal).toHaveBeenCalled();
  });

  it('[SPEC-LIFE-06] [SPEC-LIFE-07] deletion without a buffer enters unavailable; reappearance recovers automatically with a reset push', async () => {
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
    // File reappears: content is re-fetched and validated, then pushed with reset, no auto-play
    env.documents.push(doc);
    env.files.set('file:///book.abc', doc.abc);
    watcher.create();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'document')).toMatchObject({ uri: 'file:///book.abc', version: 1 });
    // After recovery the regular push path applies again
    doc.version += 1;
    doc.abc += '\n% resumed';
    manager.notifyDocumentChanged(asDocument(doc));
    await vi.advanceTimersByTimeAsync(300);
    expect(last(panel, 'document').version).toBe(2);
  });

  it('[SPEC-LIFE-06] with a buffer a missing file only notifies without locking; disk recovery clears the notice', async () => {
    const panel = open(doc);
    applied(panel);
    const watcher = env.watchers.at(-1)!;
    env.files.delete('file:///book.abc');
    watcher.delete();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'source-state')).toMatchObject({ state: 'disk-missing', detail: '/book.abc' });
    // No silence, no read-only: the buffer remains the preview source
    expect(panel.sent.filter((message) => message.type === 'playback')).toHaveLength(0);
    env.files.set('file:///book.abc', doc.abc);
    watcher.change();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(last(panel, 'source-state')).toMatchObject({ state: 'available' });
    expect(last(panel, 'document').version).toBe(1);
  });

  it('[SPEC-LIFE-08] back-to-back file events merge into one existence check; a brief deletion is not misjudged as loss', async () => {
    const panel = open(doc);
    applied(panel);
    const watcher = env.watchers.at(-1)!;
    env.documents = [];
    env.statCalls = 0;
    // Atomic replace: brief deletion followed immediately by recreation, all inside the debounce window
    watcher.delete();
    watcher.create();
    env.files.set('file:///book.abc', doc.abc);
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(env.statCalls).toBe(1);
    expect(panel.sent.filter((message) => message.type === 'source-state')).toHaveLength(0);
  });

  it('[SPEC-LIFE-05] save-as does not migrate the binding; the original preview updates from the original file content', async () => {
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

  it('[SPEC-LIFE-06] truly closing an unsaved document enters source-unavailable (the source object no longer exists)', () => {
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

  it('[SPEC-LIFE-07] reopening the preview after unavailable lifts read-only and pushes the current content', async () => {
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
    // After recovery regular updates are accepted again
    doc.version += 1;
    doc.abc += '\n% again';
    manager.notifyDocumentChanged(asDocument(doc));
    await vi.advanceTimersByTimeAsync(300);
    expect(last(panel, 'document').version).toBe(2);
  });
});

describe('parse diagnostics and the problems entry', () => {
  const item = { message: 'Unknown character ignored', start: 1, end: 2 };

  it('[SPEC-STATE-06] diagnostics are published per document and version; empty lists and out-of-range positions are not kept', () => {
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
    // Late results from stale / old revisions do not override the current diagnostics (SPEC-STATE-02 / 06)
    panel.received({ type: 'diagnostics', context: { ...context, version: 99 }, items: [] });
    expect(env.diagnosticCalls.at(-1)).toBe(published);
    panel.received({ type: 'diagnostics', context: { ...context, revision: 9 }, items: [] });
    expect(env.diagnosticCalls.at(-1)).toBe(published);
    // Out-of-range positions are invalid; all-empty clears
    panel.received({ type: 'diagnostics', context, items: [{ ...item, end: 9999 }] });
    expect(env.diagnosticCalls.at(-1)).toMatchObject({ kind: 'delete', uri: 'file:///book.abc' });
    panel.received({ type: 'diagnostics', context, items: [] });
    expect(env.diagnosticCalls.at(-1)).toMatchObject({ kind: 'delete', uri: 'file:///book.abc' });
  });

  it('[SPEC-STATE-06] a reliable migration with unchanged content moves the Problems entries to the new identity', async () => {
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

  it('[SPEC-STATE-06] after a migration conflict turns read-only, old-binding diagnostics are cleared and rejected', async () => {
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
    // Late diagnostics from the old binding do not re-enter Problems and do not affect the target panel
    const after = env.diagnosticCalls.length;
    panel.received({ type: 'diagnostics', context, items: [item] });
    expect(env.diagnosticCalls).toHaveLength(after);
    expect(last(targetPanel, 'document').uri).toBe('file:///target.abc');
  });

  it('[SPEC-STATE-06] closing the panel clears diagnostics; "view problems" only runs the host command', () => {
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

describe('practice record persistence', () => {
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
  /** Rebuild the manager with known workspace state: records are read when the panel is created. */
  function reopen(): void {
    manager.dispose();
    manager = createManager();
  }

  it('[SPEC-SET-02] the record is sent only with the view\'s first push and not attached to later version switches', async () => {
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

  it('[SPEC-SET-08] an invalid record falls back safely to defaults without deleting the original storage', () => {
    const invalid = { version: 2, ui: {}, tunes: 'x' };
    env.storage.set(key(), invalid);
    reopen();
    const panel = open(doc);
    expect(last(panel, 'document').practice).toBeUndefined();
    expect(env.storage.get(key())).toBe(invalid);
  });

  it('[SPEC-SET-06] with the remember setting off nothing is read or written; the current session can still report', () => {
    const stored = record();
    env.storage.set(key(), stored);
    env.remember = false;
    reopen();
    const panel = open(doc);
    expect(last(panel, 'document').practice).toBeUndefined();
    panel.received(report(applied(panel), [{ id: '1', signature: 'sig-1', settings: settings(55) }]));
    expect(env.storage.get(key())).toBe(stored);
  });

  it('[SPEC-SET-03] [SPEC-SET-08] reports merge only currently reliable tunes; unchanged state and stale revisions do not rewrite', () => {
    const panel = open(doc);
    const context = applied(panel);
    // A tune absent from the current document (X:9) does not enter the persistent record
    panel.received(report(context, [
      { id: '2', signature: 'sig-2', settings: { speed: 90, loop: false, chordsMuted: true, mutedVoices: [1] } },
      { id: '9', signature: null, settings: settings(80) },
    ]));
    const first = env.storage.get(key()) as PracticeRecord;
    expect(first.tunes.map((tune) => tune.id)).toEqual(['2']);
    // Unmentioned old tunes are kept; the same tune is overwritten by the new record
    panel.received(report(context, [{ id: '1', signature: 'sig-1', settings: settings(60) }]));
    const merged = env.storage.get(key()) as PracticeRecord;
    expect(merged.tunes.map((tune) => tune.id)).toEqual(['1', '2']);
    // Repeating the same state does not trigger a write
    panel.received(report(context, merged.tunes));
    expect(env.storage.get(key())).toBe(merged);
    // A stale revision (content already switched) does not override the current record
    panel.received(report({ ...context, revision: context.revision + 1 }, [{ id: '1', signature: null, settings: settings(25) }]));
    expect(env.storage.get(key())).toBe(merged);
  });

  it('[SPEC-SET-07] reset deletes the current file\'s record and a new ready does not restore it', () => {
    env.storage.set(key(), record());
    reopen();
    const panel = open(doc);
    const context = applied(panel);
    panel.received({ type: 'reset-practice', context });
    expect(env.storage.has(key())).toBe(false);
    panel.received({ type: 'ready' });
    expect(last(panel, 'document').practice).toBeUndefined();
  });

  it('[SPEC-SET-02] an unsaved document keeps its record in the session only; after the first save it is persisted with the migrated binding', async () => {
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

  it('[SPEC-LIFE-04] [SPEC-SET-08] when the migration target already has a record the target wins; the source is neither overwritten nor deleted', async () => {
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
    // A late report from the read-only migration page is not written
    panel.received(report(context, [{ id: '1', signature: 'sig-1', settings: settings(25) }]));
    expect(env.storage.get(key())).toBe(source);
  });

  it('[SPEC-SET-08] nothing is persisted without a workspace', () => {
    env.folders = [];
    const panel = open(doc);
    panel.received(report(applied(panel), [{ id: '1', signature: 'sig-1', settings: settings(55) }]));
    expect(env.storage.size).toBe(0);
  });
});
