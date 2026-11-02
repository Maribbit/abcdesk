import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  parseWebviewMessage,
  sameContext,
  type PreviewContext,
  type CursorMessage,
  type DocumentMessage,
  type LinkageUnavailableReason,
  type PlaybackMessage,
  type PlayFromCursorMessage,
  type SourceHighlightRange,
  type SourceStateMessage,
  type WebviewDiagnosticsMessage,
  type WebviewPlaybackStateMessage,
  type WebviewPracticeStateMessage,
  type WebviewRenderedMessage,
  type WebviewRevealRangeMessage,
} from '../core/messages';
import { PRACTICE_SCHEMA_VERSION, defaultPracticeUiPreferences, type PracticeRecord } from '../core/practice';
import { createTuneCatalog } from '../core/tunes';
import { PracticeStore, mergePracticeIfChanged } from './practiceStore';

/**
 * Music preview panel management (SPEC-CMD-03 / 06 / 07 / 09 / 10 / 12, SPEC-ENV-03 / 04 / 05, SPEC-PLAY-01 / 02 / 11):
 * - the same document reuses its existing panel instead of creating a new one (SPEC-CMD-03);
 * - webview resources are loaded only via asWebviewUri; the CSP allows only nonce'd own scripts and the extension's own resources (SPEC-ENV-03 / 05);
 * - webview messages are untrusted and validated by type and version through parseWebviewMessage (SPEC-ENV-04);
 * - document changes (including unsaved edits) are pushed to the matching preview with debouncing; the tab title shows the file name and marks unsaved new documents (SPEC-CMD-06);
 * - version switching during playback and its timing are handled by the webview per SPEC-STATE-07; the host only pushes the latest version;
 * - playback commands may reveal the preview on demand while keeping source focus; after the first successful render only still-valid start requests run (SPEC-CMD-07 / 09);
 * - between a document change and the render confirmation of the new version source linkage is suspended: no cursor pushes, no locating, no starting playback, and source highlighting is cleared (SPEC-PLAY-11);
 * - locating source from a clicked score note only sets the selection and scrolls without stealing focus; the editor shows the current target note's source range with a dedicated outline decoration (synced with the target, distinct from both the native selection and same-text highlighting); playback highlighting only decorates visible editors (SPEC-PLAY-11);
 * - hiding the panel is treated as pause and it does not auto-play on restore (SPEC-PLAY-02); only one preview per window may produce sound (SPEC-PLAY-01);
 * - the empty state's "go to source" entry and the goToSource command open the source document and move focus; a closed source tab is reopened by URI (SPEC-STATE-05 / CMD-12).
 *
 * File lifecycle (SPEC-LIFE-02 ~ 08):
 * - a reliable rename / move (an onDidRenameFiles pair) and the first save of an unsaved document (the same TextDocument object with its URI updated in place)
 *   continue the original preview: pause first and cancel pending start requests and uncommitted updates, then re-verify the content - when content and version are unchanged only the identity is updated
 *   (keeping paused position, settings and mapping); on change or on recovery from read-only the usual version push with reset applies;
 * - when the migration target already has a panel the target wins (SPEC-LIFE-04): the source panel is kept as a read-only "file moved" status page
 *   (offering only an entry to the target preview), without opening the target, resuming playback or stealing focus;
 * - the bound file is observed through a dedicated FileSystemWatcher for create / change / delete (SPEC-LIFE-08):
 *   shared debouncing + existence re-check + generation numbers that invalidate stale checks, so brief delete-then-create is not misjudged and out-of-order events do no harm;
 * - delete / discard without a usable editor buffer enters the source-unavailable state (SPEC-LIFE-06): silence, read-only reference,
 *   and a fresh fetch with reset once readable again (SPEC-LIFE-07); with a buffer only the disk state is reported and the preview keeps following the buffer.
 *
 * Parse diagnostics (SPEC-STATE-06):
 * - the webview reports only warning positions that map contiguously to the tune source; unreliable positions stay in the preview details;
 * - the host validates against the latest pushed version and revision; late results never restore old errors; every render replaces the whole set and an empty list clears it;
 * - on a reliable migration the Problems entries follow the new URI; cleared for read-only sources and on panel close; Problems is never opened automatically.
 *
 * Keyboard visualization (SPEC-PLAY-08 / 09) and playback controls (speed / progress / voices, SPEC-PLAY-04 / 05 / 06)
 * are all implemented inside the webview: the host only provides the DOM skeleton and styles, and UI state adds no messages
 * (cross-session restore is left to the settings batch, SPEC-SET-05); the progress bar owns a full row and supports dragging and keyboard positioning.
 * Layout: the top bar (playback controls) sticks to the top of the preview and the keyboard is a separate dock stuck to the bottom (no extra buttons, shape aligned with the tuned chatmusic version);
 * both stay visible and clickable while a long score scrolls; the low-height fallback scrolls the whole content with the keyboard back in document flow (D0 low-height exception, threshold is a provisional measured item).
 */

/** Start request to run once the first render completes (SPEC-CMD-07 / 09). */
type PendingRequest = { kind: 'toggle' } | { kind: 'play-from-cursor'; offset: number; version: number };

/** Panel entry: the panel itself plus the minimal state the host must verify. */
interface PanelEntry {
  panel: vscode.WebviewPanel;
  /** Bound document identity (URI string); the active target for control commands while the preview is in the foreground (SPEC-CMD-04). */
  uri: string;
  /** Most recently pushed / bound document; the latest content is re-pushed from it after the ready handshake. */
  document: vscode.TextDocument;
  /** Most recently pushed document version (baseline for SPEC-ENV-04 version checks; rendered messages are compared against it). */
  version: number;
  /** Most recently pushed document text (SPEC-CMD-12): decides by content diff whether to switch versions when a closed source tab is reopened. */
  lastPushedAbc: string | undefined;
  /** Whether a render result has been received (playback commands use it to decide between forwarding immediately and waiting for the render). */
  renderedOnce: boolean;
  /** Start request to run once the first render completes (SPEC-CMD-07 / 09); dropped on cancel or render failure. */
  pendingRequest: PendingRequest | undefined;
  /** Linkage suspension window (SPEC-PLAY-11): the document changed and the new version is not yet confirmed rendered; no cursor pushes, locating or starting playback meanwhile. */
  suspend: boolean;
  /** Latest cursor offset recorded during the suspension window, re-sent once rendering completes (SPEC-PLAY-11). */
  lastCursorOffset: number | undefined;
  /** Latest document waiting to be pushed during debouncing (SPEC-CMD-06). */
  pendingChange: vscode.TextDocument | undefined;
  /** Source range of the current target note (SPEC-PLAY-11 outline decoration / SPEC-CMD-12 landing point), driven by the webview's target report; cleared when the target is cleared or the content changes, never reusing an old offset. */
  targetRanges: SourceHighlightRange[];
  viewId: number;
  revision: number;
  appliedRevision: number;
  requestId: number;
  lastRevealRequest: number;
  lastSelectionRequest: number;
  lastTargetRequest: number;
  context: PreviewContext | undefined;
  phase: WebviewPlaybackStateMessage['state'];
  /** Source status (SPEC-LIFE-04 / 06): migration status page / source unavailable / missing-on-disk notice; unset means normally bound. */
  sourceState: 'migrated' | 'unavailable' | 'disk-missing' | undefined;
  /** Migration target URI (SPEC-LIFE-04): target of the status page's "open target preview" entry; paths supplied by the webview are not accepted. */
  migratedTo: string | undefined;
  /** Diagnostics published to Problems (SPEC-STATE-06): migrate with the identity, cleared on read-only / close. */
  diagnostics: vscode.Diagnostic[];
  /** Most recently committed practice record for this file (SPEC-SET-02 / 08): saved documents read it from workspace state, unsaved documents keep it in the session only. */
  practiceState: PracticeRecord | undefined;
  /** Dedicated watcher for the bound file (SPEC-LIFE-08): created only for file URIs, rebuilt or disposed on rekey / close. */
  watcher: vscode.FileSystemWatcher | undefined;
}

/** Debounce for document update pushes (ms): continuous typing pushes the latest version only once it settles. */
const UPDATE_DEBOUNCE_MS = 300;

/** Debounce for file event verification (ms, measured for SPEC-LIFE-08): brief delete-then-create / atomic replace collapse into one existence re-check. */
const SOURCE_CHECK_DEBOUNCE_MS = 300;

export class PreviewPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, PanelEntry>();
  private viewSequence = 0;
  private readonly disposables: vscode.Disposable[] = [];
  /** Pending debounce timers per document (keyed by URI). */
  private readonly updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Verification timer and generation number per bound file (SPEC-LIFE-08): stale checks arriving out of order are invalidated by generation. */
  private readonly sourceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sourceGenerations = new Map<string, number>();
  /** Source playback highlight decoration (SPEC-PLAY-11): applied only to visible editors, without scrolling or moving the cursor. */
  private readonly sourceHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
  });
  /**
   * Linkage outline decoration for the current target note (SPEC-PLAY-11): border + overview ruler mark,
   * distinguished from the native selection (rounded fill) and VS Code same-text highlighting (grey box) by both shape and color;
   * driven by each document's current target note range (targetRanges): the latest click / inspection hit wins,
   * cleared when the target is cleared, the content changes or the panel closes.
   */
  private readonly linkedNote = vscode.window.createTextEditorDecorationType({
    border: '1px dashed',
    borderColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  /** Parse diagnostics collection (SPEC-STATE-06): keyed by bound document, replaced wholesale on every render, an empty list clears. */
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('abcdesk');
  /** Practice record storage (SPEC-SET-02 ~ 08): workspace state keyed by file URI. */
  private readonly practiceStore: PracticeStore;

  constructor(private readonly extensionUri: vscode.Uri, workspaceState?: vscode.Memento) {
    this.practiceStore = new PracticeStore(workspaceState);
    // Sync the outline decoration when visible editors change (SPEC-PLAY-11): newly visible editors are redrawn from the current target range
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.syncLinkedDecorations()),
    );
  }

  /** Create or reveal the preview for the given document; an existing preview for the same file is revealed and gets the latest content (reveal only, no playback). */
  createOrShow(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry !== undefined) {
      entry.panel.reveal();
      // Explicit re-preview (SPEC-LIFE-07): clear the read-only source state and restore a playable binding
      this.resumeBinding(entry);
      this.pushDocument(entry, document);
      return;
    }
    this.createPanel(document);
  }

  /** Play / pause command entry (SPEC-CMD-07 / 09): the play branch may create or reveal the preview while keeping source focus. */
  requestToggle(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      // Create on demand: run the still-valid start request once the first render completes (SPEC-CMD-07)
      this.createPanel(document, { kind: 'toggle' });
      return;
    }
    // Read-only source state (SPEC-LIFE-04 / 06): do not play the old binding; the disabled webview buttons are the fallback
    if (this.isReadOnlyEntry(entry)) return;
    if (!entry.panel.visible) {
      // When hidden, starting playback requires revealing the preview first; no background sound from a hidden panel (SPEC-CMD-07)
      entry.panel.reveal(undefined, true);
    }
    if (!entry.renderedOnce) {
      entry.pendingRequest = { kind: 'toggle' };
      return;
    }
    entry.pendingRequest = undefined;
    this.postPlayback(entry, 'toggle');
  }

  /**
   * "Play from cursor" command entry (SPEC-CMD-07 / 08 / PLAY-12): creates or reveals the preview on demand while keeping source focus;
   * pending document updates are pushed before starting so the mapping uses the latest version; with no valid mapping the webview reports the reason.
   */
  requestPlayFromCursor(document: vscode.TextDocument, offset: number): void {
    const entry = this.panels.get(document.uri.toString());
    const request: PendingRequest = { kind: 'play-from-cursor', offset, version: document.version };
    if (entry === undefined) {
      this.createPanel(document, request);
      return;
    }
    // Read-only source state (SPEC-LIFE-04 / 06): do not start the old binding and do not push the old text (which would wrongly lift read-only)
    if (this.isReadOnlyEntry(entry)) return;
    if (!entry.panel.visible) entry.panel.reveal(undefined, true);
    this.flushDocumentUpdate(entry);
    // Content follows the most recent push (entry.version is push bookkeeping; a reopened object may carry a different version number)
    if (entry.lastPushedAbc !== document.getText()) this.pushDocument(entry, document);
    if ((entry.phase === 'playing' || entry.phase === 'preparing') && entry.appliedRevision !== entry.revision) {
      entry.pendingRequest = undefined;
      this.showLinkageUnavailable('update-pending');
      return;
    }
    if (!entry.renderedOnce || entry.appliedRevision !== entry.revision || entry.context === undefined) {
      entry.pendingRequest = request;
      return;
    }
    entry.pendingRequest = undefined;
    const message: PlayFromCursorMessage = { type: 'play-from-cursor', context: entry.context, requestId: ++entry.requestId, offset };
    void entry.panel.webview.postMessage(message);
  }

  /** "Play from selected note" command entry (SPEC-CMD-08 / PLAY-12): uses the current target note in the preview; without a preview it asks to open one first. */
  requestPlayFromSelection(document: vscode.TextDocument, targetRequestId?: number): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open the preview first, then place the cursor on a note or select one on the score.'),
      );
      return;
    }
    this.flushDocumentUpdate(entry);
    if (entry.suspend || entry.context === undefined) {
      this.showLinkageUnavailable(entry.appliedRevision !== entry.revision ? 'update-pending' : 'no-selection');
      return;
    }
    void entry.panel.webview.postMessage({ type: 'play-from-selection', context: entry.context, requestId: ++entry.requestId, ...(targetRequestId === undefined ? {} : { targetRequestId }) });
  }

  /**
   * "Go to source" command (SPEC-CMD-12): opens the source document and explicitly moves focus;
   * without a valid note mapping it only opens the file and does not reuse an old offset; a closed source tab is reopened by URI.
   */
  async requestGoToSource(document: vscode.TextDocument): Promise<void> {
    if (document.isClosed) {
      // Defensive: a closed document object takes the reopen-by-URI path (SPEC-CMD-12)
      await this.requestGoToSourceByUri(document.uri.toString());
      return;
    }
    const entry = this.panels.get(document.uri.toString());
    const range = entry?.suspend === false ? entry.targetRanges[0] : undefined;
    const context = entry?.context;
    try {
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false,
      });
      if (range === undefined || entry === undefined || context === undefined || this.panels.get(entry.uri) !== entry || entry.suspend || !sameContext(entry.context, context) || entry.targetRanges[0] !== range || editor.document.version !== context.version) {
        return;
      }
      const selection = new vscode.Selection(
        document.positionAt(range.start),
        document.positionAt(range.end),
      );
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      this.reportSourceUnavailable(error);
    }
  }

  /**
   * "Go to source" when the source tab is closed (SPEC-CMD-12): a readable file is reopened by URI with focus moved explicitly,
   * and the preview stays bound to that file (SPEC-LIFE-05) - changed disk content is pushed under the usual version switch rules (SPEC-STATE-07),
   * unchanged content is not pushed to avoid a needless reset and to keep the playback position; a deleted / unreadable file is explained, no file is recreated at the same path.
   */
  async requestGoToSourceByUri(uriText: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriText));
      const entry = this.panels.get(uriText);
      if (entry !== undefined) {
        entry.document = document;
        if (entry.lastPushedAbc !== document.getText()) {
          // Disk changes while the tab was closed: suspend the old linkage first, then switch to the latest content (SPEC-PLAY-11 / SPEC-STATE-07)
          entry.suspend = true;
          entry.targetRanges = [];
          this.clearSourceHighlight(entry);
          this.syncLinkedDecorations();
          this.pushDocument(entry, document);
        }
      }
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false,
      });
    } catch (error) {
      this.reportSourceUnavailable(error);
    }
  }

  /** Shared explanation when the source document fails to open (SPEC-CMD-12): no silent failure, no recreating a file at the same path. */
  private reportSourceUnavailable(error: unknown): void {
    console.error('ABC Desk: go to source failed', error);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The source document is unavailable.'),
    );
  }

  /** Stop command entry (SPEC-CMD-10 / 11): never creates a preview; silencing and cancelling a start do not depend on audio readiness. */
  requestStop(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      return;
    }
    entry.pendingRequest = undefined;
    this.postPlayback(entry, 'stop');
  }

  /** Document bound to the foreground preview; the active target for control commands while the preview is in the foreground (SPEC-CMD-04): read-only status pages do not take part. */
  activeDocument(): vscode.TextDocument | undefined {
    for (const entry of this.panels.values()) {
      if (entry.panel.active && !this.isReadOnlyEntry(entry)) {
        return this.findDocument(entry.uri);
      }
    }
    return undefined;
  }

  /** Bound URI of the foreground preview (SPEC-CMD-04 / CMD-12): the binding survives the source tab closing (SPEC-LIFE-05) so "go to source" can reopen by URI; read-only status pages do not take part. */
  activeBoundUri(): string | undefined {
    for (const entry of this.panels.values()) {
      if (entry.panel.active && !this.isReadOnlyEntry(entry)) {
        return entry.uri;
      }
    }
    return undefined;
  }

  /** Whether the preview panel bound to this document is still open (SPEC-EXP-03): exports started from the preview are cancelled once the panel closes. */
  isPreviewOpen(uri: string): boolean {
    return this.panels.has(uri);
  }

  /** Whether the preview lags behind the latest document (SPEC-EXP-01): the document changed and the new version is not yet confirmed rendered. */
  isPreviewStale(uri: string): boolean {
    const entry = this.panels.get(uri);
    return entry !== undefined && (entry.pendingChange !== undefined || entry.appliedRevision !== entry.revision);
  }

  /** Push document content or save-state changes to the matching preview (ignored without one); continuous changes are debounced so only the settled latest version is pushed; read-only status pages accept no updates. */
  notifyDocumentChanged(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const entry = this.panels.get(uri);
    if (entry === undefined || this.isReadOnlyEntry(entry)) {
      return;
    }
    // Suspend source linkage as soon as a content change is seen (SPEC-PLAY-11): clear playback highlighting and drop the old mapping as a locating basis
    entry.suspend = true;
    entry.targetRanges = [];
    this.clearSourceHighlight(entry);
    this.syncLinkedDecorations();
    entry.pendingChange = document;
    const existing = this.updateTimers.get(uri);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.updateTimers.set(
      uri,
      setTimeout(() => {
        this.updateTimers.delete(uri);
        this.flushDocumentUpdate(entry);
      }, UPDATE_DEBOUNCE_MS),
    );
  }

  /**
   * Reliable rename / move (SPEC-LIFE-03 / 04): the old -> new pair from onDidRenameFiles is the only confirmable migration evidence;
   * without a target conflict the original preview continues (pause first, then re-verify the content); on conflict the source stays as a read-only "file moved" status page.
   */
  notifyFilesRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    for (const file of files) {
      const oldKey = file.oldUri.toString();
      const newKey = file.newUri.toString();
      if (oldKey === newKey) continue;
      // The status page's target entry is rekeyed with the target so "open the migrated preview" still points at the actual file
      for (const other of this.panels.values()) {
        if (other.migratedTo === oldKey) other.migratedTo = newKey;
      }
      const entry = this.panels.get(oldKey);
      if (entry === undefined || entry.sourceState === 'migrated') continue;
      void this.continueBinding(entry, file.newUri);
    }
  }

  /** Save event (SPEC-LIFE-02 / 03 / 05): the first save of an unsaved document continues the original preview; save-as of an existing file does not migrate the binding. */
  notifyDocumentSaved(document: vscode.TextDocument): void {
    const newKey = document.uri.toString();
    for (const entry of [...this.panels.values()]) {
      if (entry.document !== document || entry.uri === newKey || entry.sourceState === 'migrated') continue;
      if (entry.uri.startsWith('untitled:')) {
        // First save: the same TextDocument object has its URI updated in place, treated as the same practice continuing (SPEC-LIFE-03)
        void this.continueBinding(entry, document.uri);
      } else {
        // Save as: the original preview stays bound to the original file and does not follow the new path (SPEC-LIFE-05)
        void this.reopenBinding(entry);
      }
    }
  }

  /**
   * Close event (SPEC-LIFE-02 / 06): a truly discarded unsaved document enters source-unavailable (the source document no longer exists);
   * file documents are re-verified against disk - disk content may differ from the last push (which included unsaved edits), and disk wins (SPEC-LIFE-05).
   */
  notifyDocumentClosed(document: vscode.TextDocument): void {
    for (const entry of this.panels.values()) {
      if (entry.document !== document) continue;
      if (document.isUntitled) {
        this.enterUnavailable(entry);
        return;
      }
      this.scheduleSourceCheck(entry.uri);
    }
  }

  /** Source cursor change (SPEC-PLAY-11): when it belongs to a preview's bound document push the inspection marker position; when the cursor belongs to another tune clear every preview's marker. */
  notifySelectionChanged(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();
    const entry = this.panels.get(uri);
    if (entry !== undefined) {
      this.sendCursor(entry, editor.document.offsetAt(editor.selection.active));
      return;
    }
    // No automatic tune switching and no reuse of the current tune's mapping (SPEC-PLAY-11)
    for (const other of this.panels.values()) {
      this.sendCursor(other, null);
    }
  }

  /** Push the inspection marker position (SPEC-PLAY-11): inside the suspension window only record it, and re-send the latest position after rendering; read-only status pages get nothing. */
  private sendCursor(entry: PanelEntry, offset: number | null): void {
    entry.lastCursorOffset = offset ?? undefined;
    if (entry.suspend || !entry.renderedOnce || entry.context === undefined || this.isReadOnlyEntry(entry)) {
      return;
    }
    const message: CursorMessage = { type: 'cursor', context: entry.context, offset };
    void entry.panel.webview.postMessage(message);
  }

  /** Push the pending document update immediately (if any): flushed before start commands so the mapping uses the latest version (SPEC-PLAY-11 / 12). */
  private flushDocumentUpdate(entry: PanelEntry): void {
    const timer = this.updateTimers.get(entry.uri);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.updateTimers.delete(entry.uri);
    }
    const pending = entry.pendingChange;
    entry.pendingChange = undefined;
    if (pending !== undefined && this.panels.get(entry.uri) === entry) {
      this.pushDocument(entry, pending);
    }
  }

  /** Read-only source state (SPEC-LIFE-04 / 06): migration status pages and source-unavailable pages take no part in playback, locating, settings changes or exports. */
  private isReadOnlyEntry(entry: PanelEntry): boolean {
    return entry.sourceState === 'migrated' || entry.sourceState === 'unavailable';
  }

  private clearUpdateTimer(key: string): void {
    const timer = this.updateTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.updateTimers.delete(key);
    }
  }

  /** Explicit re-preview (SPEC-LIFE-07): clears the read-only source state and hands back to the regular push path; the content push is done by the caller. */
  private resumeBinding(entry: PanelEntry): void {
    if (entry.sourceState === undefined) return;
    entry.sourceState = undefined;
    entry.migratedTo = undefined;
    this.scheduleSourceCheck(entry.uri);
  }

  /**
   * Continue the binding (SPEC-LIFE-03 / 04): the host has reliably confirmed the old and new paths are the same file (rename pair / object identity on first save).
   * Pause first and cancel pending starts, uncommitted updates and old async checks, then re-verify the content: unchanged content only updates the identity (keeping paused position,
   * settings and mapping); changed content or recovery from source-unavailable takes the usual version push with reset; when the target already has a panel the target wins (SPEC-LIFE-04).
   */
  private async continueBinding(entry: PanelEntry, newUri: vscode.Uri): Promise<void> {
    const oldKey = entry.uri;
    const newKey = newUri.toString();
    if (newKey === oldKey) return;
    const wasUnavailable = entry.sourceState === 'unavailable';
    entry.pendingRequest = undefined;
    this.clearUpdateTimer(oldKey);
    entry.pendingChange = undefined;
    this.clearSourceCheck(oldKey);
    const conflict = this.panels.get(newKey);
    // When the target already has a preview or a settings record the target wins (SPEC-LIFE-04): the source stays as a read-only migration page
    if (conflict !== undefined || this.practiceStore.read(newKey) !== undefined) {
      this.markMigrated(entry, newKey);
      if (conflict !== undefined) this.refreshTargetBinding(conflict, newUri);
      return;
    }
    entry.suspend = true;
    entry.targetRanges = [];
    this.clearSourceHighlight(entry);
    this.syncLinkedDecorations();
    this.postPlayback(entry, 'pause');
    if (wasUnavailable) {
      entry.sourceState = undefined;
      entry.migratedTo = undefined;
    }
    this.rekeyEntry(entry, newKey);
    // Persistent records migrate with the binding (SPEC-LIFE-03, SET-08): copied when the target has none, the source is not deleted
    this.practiceStore.migrate(entry.practiceState, newKey);
    const document = await this.documentForUri(newUri);
    if (this.panels.get(newKey) !== entry) return;
    if (document === undefined) {
      // Target temporarily unreadable (very rare race): treat as source-unavailable and wait for the file event re-check
      this.enterUnavailable(entry);
      return;
    }
    const abc = document.getText();
    if (!wasUnavailable && entry.renderedOnce && entry.lastPushedAbc === abc) {
      // Same practice, unchanged content: keep paused position, settings and mapping, update only the identity and display path (SPEC-LIFE-03)
      entry.document = document;
      entry.panel.title = panelTitle(document);
      void entry.panel.webview.postMessage(this.continuedMessage(entry, document));
      return;
    }
    this.pushDocument(entry, document, true);
  }

  /**
   * Identity update message (SPEC-LIFE-03): content and version are carried over from the latest push (the webview keeps its position from them),
   * only the source identity and display path are replaced; `continued` marks this push as a reliable migration of the same practice.
   */
  private continuedMessage(entry: PanelEntry, document: vscode.TextDocument): DocumentMessage {
    return {
      type: 'document',
      uri: entry.uri,
      fileName: fileNameOf(document),
      abc: document.getText(),
      isUntitled: document.isUntitled,
      version: entry.version,
      viewId: entry.viewId,
      revision: entry.revision,
      continued: true,
    };
  }

  /** Re-check of the original binding after save-as (SPEC-LIFE-05): the original preview stays bound to the original file; without a buffer or on content change it is re-fetched and pushed under the pending-update rules. */
  private async reopenBinding(entry: PanelEntry): Promise<void> {
    const key = entry.uri;
    const current = this.findDocument(key);
    if (current !== undefined) {
      entry.document = current;
      if (entry.lastPushedAbc !== current.getText()) {
        entry.suspend = true;
        entry.targetRanges = [];
        this.clearSourceHighlight(entry);
        this.syncLinkedDecorations();
        this.pushDocument(entry, current);
      }
      return;
    }
    const opened = await this.documentForUri(vscode.Uri.parse(key));
    if (this.panels.get(key) !== entry) return;
    if (opened === undefined) {
      this.scheduleSourceCheck(key);
      return;
    }
    entry.document = opened;
    if (entry.lastPushedAbc !== opened.getText()) {
      entry.suspend = true;
      entry.targetRanges = [];
      this.clearSourceHighlight(entry);
      this.syncLinkedDecorations();
      this.pushDocument(entry, opened);
    }
  }

  /** Migration conflict (SPEC-LIFE-04): the source panel stays as a read-only "file moved" status page; the old path is no longer watched and playback is not resumed. */
  private markMigrated(entry: PanelEntry, newKey: string): void {
    entry.pendingRequest = undefined;
    this.clearUpdateTimer(entry.uri);
    entry.pendingChange = undefined;
    this.clearSourceCheck(entry.uri);
    entry.suspend = true;
    entry.targetRanges = [];
    this.clearSourceHighlight(entry);
    this.syncLinkedDecorations();
    entry.sourceState = 'migrated';
    entry.migratedTo = newKey;
    entry.watcher?.dispose();
    entry.watcher = undefined;
    // The old binding has ended (SPEC-STATE-06): the source page keeps no old diagnostics that could lead into Problems
    this.clearEntryDiagnostics(entry);
    this.postPlayback(entry, 'pause');
    this.postSourceState(entry, 'migrated');
  }

  /** Re-verification of the target panel on a target conflict (SPEC-LIFE-04): push the latest content from the actual document, without auto-playing or stealing focus. */
  private refreshTargetBinding(entry: PanelEntry, uri: vscode.Uri): void {
    if (this.isReadOnlyEntry(entry)) return;
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    if (document === undefined) return;
    const abc = document.getText();
    if (entry.version === document.version && entry.lastPushedAbc === abc) {
      entry.document = document;
      return;
    }
    entry.suspend = true;
    entry.targetRanges = [];
    this.clearSourceHighlight(entry);
    this.syncLinkedDecorations();
    this.pushDocument(entry, document);
  }

  /**
   * Source unavailable (SPEC-LIFE-06): keep the preview page as a read-only reference, silence it and cancel pending starts and uncommitted updates;
   * the dedicated watcher is kept so the preview recovers once the original path is readable again (SPEC-LIFE-07).
   */
  private enterUnavailable(entry: PanelEntry): void {
    if (entry.sourceState === 'unavailable') return;
    entry.pendingRequest = undefined;
    this.clearUpdateTimer(entry.uri);
    entry.pendingChange = undefined;
    entry.suspend = true;
    entry.targetRanges = [];
    this.clearSourceHighlight(entry);
    this.syncLinkedDecorations();
    entry.sourceState = 'unavailable';
    entry.migratedTo = undefined;
    // The old binding is void (SPEC-STATE-06): clear this document's Problems entries
    this.clearEntryDiagnostics(entry);
    this.postPlayback(entry, 'stop');
    this.postSourceState(entry, 'unavailable');
  }

  /** Source status message (SPEC-LIFE-04 / 06 / 07): carries only the status and display text; file paths never appear in the protocol. */
  private postSourceState(entry: PanelEntry, state: SourceStateMessage['state']): void {
    let detail = '';
    if (state !== 'available') {
      detail = state === 'migrated' && entry.migratedTo !== undefined
        ? fileNameOfUri(vscode.Uri.parse(entry.migratedTo))
        : displayPathOf(vscode.Uri.parse(entry.uri));
    }
    void entry.panel.webview.postMessage({ type: 'source-state', viewId: entry.viewId, state, detail } satisfies SourceStateMessage);
  }

  /**
   * Practice record commit (SPEC-SET-03 ~ 08): accepts only X: tunes that really exist and are unique in the current document;
   * merged with the existing record (unmentioned old tunes are kept), unsaved documents stay in the session only, repeated reports do not trigger writes.
   */
  private applyPracticeState(entry: PanelEntry, message: WebviewPracticeStateMessage): void {
    const catalog = createTuneCatalog(entry.lastPushedAbc ?? '');
    const known = new Set<string>();
    for (const tune of catalog.tunes) {
      if (tune.reliable && tune.id !== null) known.add(tune.id);
    }
    const incoming: PracticeRecord = {
      version: PRACTICE_SCHEMA_VERSION,
      ui: message.ui,
      tunes: message.tunes.filter((tune) => known.has(tune.id)),
    };
    const base = entry.practiceState ?? this.practiceStore.read(entry.uri);
    const defaults = defaultPracticeUiPreferences();
    const hasContent = incoming.tunes.length > 0 ||
      incoming.ui.keyboardCollapsed !== defaults.keyboardCollapsed ||
      incoming.ui.keyboardMode !== defaults.keyboardMode;
    // No record and still all defaults: do not create an empty record (opening a file is not a practice setting)
    if (base === undefined && !hasContent) return;
    const merged = mergePracticeIfChanged(base, incoming);
    entry.practiceState = merged;
    if (merged === base) return;
    // Unsaved new documents keep the record in the session only (SPEC-SET-02): persisted with the binding on first save
    if (entry.document.isUntitled) return;
    this.practiceStore.save(entry.uri, merged);
  }

  /**
   * Publish parse diagnostics (SPEC-STATE-06): accept only reliable positions matching the latest pushed version and revision;
   * late / superseded render results must not restore old errors; an empty list clears in sync with the webview's cleanup.
   */
  private applyDiagnostics(entry: PanelEntry, message: WebviewDiagnosticsMessage): void {
    if (message.context.version !== entry.version || message.context.revision !== entry.revision) return;
    if (this.isReadOnlyEntry(entry)) return;
    const length = entry.lastPushedAbc?.length ?? 0;
    entry.diagnostics = message.items
      .filter((item) => item.end <= length)
      .map((item) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(entry.document.positionAt(item.start), entry.document.positionAt(item.end)),
          vscode.l10n.t('ABC parse warning: {0}', item.message),
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'ABC Desk';
        return diagnostic;
      });
    this.publishDiagnostics(entry);
  }

  /** Diagnostics keyed by document (SPEC-STATE-06): an empty list clears; resolved diagnostics are not kept. */
  private publishDiagnostics(entry: PanelEntry): void {
    const uri = vscode.Uri.parse(entry.uri);
    if (entry.diagnostics.length === 0) this.diagnostics.delete(uri);
    else this.diagnostics.set(uri, entry.diagnostics);
  }

  private clearEntryDiagnostics(entry: PanelEntry): void {
    if (entry.diagnostics.length === 0) return;
    entry.diagnostics = [];
    this.diagnostics.delete(vscode.Uri.parse(entry.uri));
  }

  /** Dedicated watcher for the bound file (SPEC-LIFE-08): created only for file URIs; rebuilt or disposed on rekey / migration / release. */
  private attachWatcher(entry: PanelEntry): void {
    entry.watcher?.dispose();
    entry.watcher = undefined;
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(entry.uri);
    } catch {
      return;
    }
    if (uri.scheme !== 'file') return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), escapeGlobPattern(fileNameOfUri(uri))),
    );
    const schedule = () => this.scheduleSourceCheck(entry.uri);
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    entry.watcher = watcher;
  }

  /** File event debounce (SPEC-LIFE-08): merges the back-to-back notifications of brief delete-then-create and atomic replace; generation numbers invalidate stale checks. */
  private scheduleSourceCheck(key: string): void {
    const generation = (this.sourceGenerations.get(key) ?? 0) + 1;
    this.sourceGenerations.set(key, generation);
    const timer = this.sourceTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.sourceTimers.set(
      key,
      setTimeout(() => {
        this.sourceTimers.delete(key);
        void this.checkSource(key, generation);
      }, SOURCE_CHECK_DEBOUNCE_MS),
    );
  }

  /** Invalidate a key's pending and in-flight checks (called on rekey / migration / close). */
  private clearSourceCheck(key: string): void {
    const timer = this.sourceTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.sourceTimers.delete(key);
    }
    this.sourceGenerations.set(key, (this.sourceGenerations.get(key) ?? 0) + 1);
  }

  /**
   * File event verification (SPEC-LIFE-06 / 07 / 08): re-checks whether the bound target is still readable;
   * unreadable without a usable editor buffer (the extension's cached old text does not count) enters source-unavailable, with a buffer the preview continues and only the disk state is reported;
   * when readable again the content is re-fetched, applied with reset, and not auto-played.
   */
  private async checkSource(key: string, generation: number): Promise<void> {
    if (this.sourceGenerations.get(key) !== generation) return;
    const entry = this.panels.get(key);
    if (entry === undefined || entry.sourceState === 'migrated') return;
    const uri = vscode.Uri.parse(key);
    const readable = await fileReadable(uri);
    if (this.sourceGenerations.get(key) !== generation || this.panels.get(key) !== entry) return;
    if (!readable) {
      if (this.findDocument(key) !== undefined) {
        // The buffer is still usable (SPEC-LIFE-06): keep previewing that document, only report the disk state, do not send twice
        if (entry.sourceState !== 'disk-missing') {
          entry.sourceState = 'disk-missing';
          entry.migratedTo = undefined;
          this.postSourceState(entry, 'disk-missing');
        }
        return;
      }
      this.enterUnavailable(entry);
      return;
    }
    if (entry.sourceState === 'unavailable') {
      // Source recovered (SPEC-LIFE-07): re-fetch and validate the current content, apply with reset, do not restore old start requests or old mappings
      const document = await this.documentForUri(uri);
      if (this.sourceGenerations.get(key) !== generation || this.panels.get(key) !== entry) return;
      if (document === undefined) return; // Read failed: keep the current state and wait for the next event
      entry.sourceState = undefined;
      entry.migratedTo = undefined;
      entry.suspend = true;
      entry.targetRanges = [];
      this.clearSourceHighlight(entry);
      this.syncLinkedDecorations();
      this.pushDocument(entry, document);
      return;
    }
    if (entry.sourceState === 'disk-missing') {
      // Disk recovered: clear the notice (content still follows the editor buffer)
      entry.sourceState = undefined;
      this.postSourceState(entry, 'available');
    }
    if (this.findDocument(key) !== undefined) return; // A buffer exists: content changes arrive via onDidChangeTextDocument
    // No buffer (source tab closed / external atomic replace, SPEC-LIFE-05 / 08): compare with the latest push and push a new version on difference
    const text = await readTextFile(uri);
    if (this.sourceGenerations.get(key) !== generation || this.panels.get(key) !== entry) return;
    if (text === undefined || text === entry.lastPushedAbc) return;
    const document = await this.documentForUri(uri);
    if (this.sourceGenerations.get(key) !== generation || this.panels.get(key) !== entry) return;
    if (document === undefined) return;
    entry.suspend = true;
    entry.targetRanges = [];
    this.clearSourceHighlight(entry);
    this.syncLinkedDecorations();
    this.pushDocument(entry, document);
  }

  /** The migration status page's "open the migrated preview" entry (SPEC-LIFE-04): works only from the host's own recorded target, never from a webview path. */
  private revealMigratedTarget(entry: PanelEntry): void {
    const targetKey = entry.migratedTo;
    if (targetKey === undefined) return;
    const existing = this.panels.get(targetKey);
    if (existing !== undefined) {
      existing.panel.reveal();
      return;
    }
    void this.documentForUri(vscode.Uri.parse(targetKey)).then((document) => {
      if (document === undefined) {
        void vscode.window.showInformationMessage(vscode.l10n.t('The source document is unavailable.'));
        return;
      }
      this.createOrShow(document);
    });
  }

  /** Find the currently open document by URI (including unsaved buffers); returns undefined when none. */
  private findDocument(key: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
  }

  /** Get a document by URI: the current buffer first, otherwise loaded from disk / provider (without showing an editor). */
  private async documentForUri(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const open = this.findDocument(uri.toString());
    if (open !== undefined) return open;
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      return undefined;
    }
  }

  /** Rekey (SPEC-LIFE-03): the panel stays bound to the same practice, only the identity is updated; watcher and diagnostics migrate with the key. */
  private rekeyEntry(entry: PanelEntry, newKey: string): void {
    const oldKey = entry.uri;
    this.panels.delete(entry.uri);
    this.clearUpdateTimer(entry.uri);
    entry.uri = newKey;
    this.panels.set(newKey, entry);
    this.attachWatcher(entry);
    // A reliable migration with unchanged content does not re-render (SPEC-LIFE-03): Problems entries follow the same practice's new identity
    if (entry.diagnostics.length > 0) {
      this.diagnostics.delete(vscode.Uri.parse(oldKey));
      this.publishDiagnostics(entry);
    }
  }

  private createPanel(document: vscode.TextDocument, request?: PendingRequest): void {
    const panel = vscode.window.createWebviewPanel(
      'abcdesk.preview',
      panelTitle(document),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Keep the webview context when hidden: hiding has pause semantics and resumes afterwards without re-preparing audio (SPEC-PLAY-02)
        retainContextWhenHidden: true,
        // Only the extension's own directory may serve webview resources (SPEC-ENV-05)
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'out'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      },
    );
    const entry: PanelEntry = {
      panel,
      uri: document.uri.toString(),
      document,
      version: document.version,
      lastPushedAbc: undefined,
      renderedOnce: false,
      pendingRequest: request,
      // No linkage is applied before the first render completes (SPEC-PLAY-11)
      suspend: true,
      lastCursorOffset: undefined,
      pendingChange: undefined,
      targetRanges: [],
      viewId: 0,
      revision: 0,
      appliedRevision: -1,
      requestId: 0,
      lastRevealRequest: -1,
      lastSelectionRequest: -1,
      lastTargetRequest: -1,
      context: undefined,
      phase: 'idle',
      sourceState: undefined,
      migratedTo: undefined,
      diagnostics: [],
      practiceState: this.practiceStore.read(document.uri.toString()),
      watcher: undefined,
    };
    this.panels.set(entry.uri, entry);
    this.attachWatcher(entry);
    panel.webview.html = this.renderHtml(panel.webview);
    if (request !== undefined) {
      // Playback commands opening the preview on demand do not steal source focus (SPEC-CMD-07)
      panel.reveal(undefined, true);
    }
    panel.onDidDispose(
      () => {
        // Guard against a late dispose callback removing a newer panel for the same file
        if (this.panels.get(entry.uri) === entry) {
          this.panels.delete(entry.uri);
          // Outline decoration and parse diagnostics are cleared together when the panel closes (SPEC-PLAY-11 / STATE-06)
          this.syncLinkedDecorations();
          this.clearEntryDiagnostics(entry);
          this.clearSourceCheck(entry.uri);
        }
        entry.watcher?.dispose();
        entry.watcher = undefined;
        const timer = this.updateTimers.get(entry.uri);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.updateTimers.delete(entry.uri);
        }
      },
      undefined,
      this.disposables,
    );
    panel.onDidChangeViewState(
      () => {
        if (this.panels.get(entry.uri) !== entry || panel.visible) {
          return;
        }
        // Hiding the panel is treated as pause (SPEC-PLAY-02); pending start requests are cancelled on hide (SPEC-CMD-07)
        entry.pendingRequest = undefined;
        this.postPlayback(entry, 'pause');
      },
      undefined,
      this.disposables,
    );
    // Push content after the webview ready handshake; other messages are untrusted and validated by type and version (SPEC-ENV-04)
    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        const parsed = parseWebviewMessage(message);
        if (parsed === undefined || this.panels.get(entry.uri) !== entry) return;
        if (parsed.type === 'ready') {
          entry.viewId = ++this.viewSequence;
          entry.context = undefined;
          entry.lastRevealRequest = -1;
          entry.lastSelectionRequest = -1;
          entry.lastTargetRequest = -1;
          entry.renderedOnce = false;
          entry.appliedRevision = -1;
          entry.phase = 'idle';
          entry.targetRanges = [];
          this.clearSourceHighlight(entry);
          this.syncLinkedDecorations();
          entry.suspend = true;
          const current = this.findDocument(entry.uri) ?? entry.document;
          this.pushDocument(entry, current);
          // Read-only source page: re-send the status marker; the reference score stays displayed on the status page (SPEC-LIFE-04 / 06)
          if (entry.sourceState !== undefined) this.postSourceState(entry, entry.sourceState);
          return;
        }
        if (parsed.type === 'reveal-source') {
          if (parsed.viewId === entry.viewId && !this.isReadOnlyEntry(entry)) this.revealSource(entry);
          return;
        }
        if (parsed.type === 'reveal-target') {
          if (parsed.viewId === entry.viewId) this.revealMigratedTarget(entry);
          return;
        }
        if (parsed.type === 'show-problems') {
                  // "View problems" only opens the host Problems view (SPEC-STATE-06): never automatic, does not change binding or playback
          if (parsed.viewId === entry.viewId && !this.isReadOnlyEntry(entry)) {
            void vscode.commands.executeCommand('workbench.action.problems.focus');
          }
          return;
        }
        const context = parsed.context;
        if (context.viewId !== entry.viewId) return;
        // Practice record commit (SPEC-SET-03 ~ 08): validated against the latest pushed version and revision; late results do not overwrite newer records
        if (parsed.type === 'practice-state' || parsed.type === 'reset-practice') {
          if (context.version !== entry.version || context.revision !== entry.revision) return;
          if (this.isReadOnlyEntry(entry)) return;
          if (parsed.type === 'reset-practice') {
            entry.practiceState = undefined;
            this.practiceStore.clear(entry.uri);
            return;
          }
          this.applyPracticeState(entry, parsed);
          return;
        }
        if (parsed.type === 'context-invalidated') {
          const known = (context.revision === entry.revision && context.version === entry.version) ||
            (context.revision === entry.context?.revision && context.version === entry.context.version);
          if (!known || context.selection <= (entry.context?.selection ?? -1)) return;
          entry.context = context;
          if (parsed.cancelRequests) entry.pendingRequest = undefined;
          entry.suspend = true;
          entry.targetRanges = [];
          this.clearSourceHighlight(entry);
          this.syncLinkedDecorations();
          return;
        }
        if (!sameContext(entry.context, context)) return;
        if (parsed.type === 'select-tune') {
          if (parsed.requestId <= entry.lastSelectionRequest) return;
          entry.lastSelectionRequest = parsed.requestId;
          // Read-only status pages accept no tune switching (SPEC-LIFE-04 / 06)
          if (this.isReadOnlyEntry(entry)) return;
          entry.pendingRequest = undefined;
          this.flushDocumentUpdate(entry);
          const current = vscode.workspace.textDocuments.find((document) => document.uri.toString() === entry.uri) ?? entry.document;
          const document = this.documentMessage(entry, current);
          void entry.panel.webview.postMessage({ type: 'selection-snapshot', viewId: entry.viewId, requestId: parsed.requestId, document });
          return;
        }
        if (parsed.type === 'rendered') {
          this.handleRendered(entry, parsed);
          return;
        }
        if (parsed.type === 'diagnostics') {
          this.applyDiagnostics(entry, parsed);
          return;
        }
        if (parsed.type === 'play-from-selection-request') {
          // "Play from here" in the preview controls (SPEC-PLAY-12): shares the command path (flush pending document updates, then map)
          if (parsed.requestId <= entry.lastTargetRequest) return;
          entry.lastTargetRequest = parsed.requestId;
          // Read-only status pages accept no playback start (SPEC-LIFE-04 / 06)
          if (this.isReadOnlyEntry(entry)) return;
          this.requestPlayFromSelection(entry.document, parsed.requestId);
          return;
        }
        if ((parsed.type === 'reveal-range' || 'ranges' in parsed) &&
            (context.revision !== entry.revision || context.version !== entry.version)) return;
        if ('ranges' in parsed && parsed.ranges.some((range) => range.end > entry.document.getText().length)) return;
        if (parsed.type === 'reveal-range') {
          if (parsed.end > entry.document.getText().length) return;
          if (entry.suspend) {
            // Suspension window: ignore old score -> old source locating (SPEC-PLAY-11)
            return;
          }
          if (parsed.requestId <= entry.lastRevealRequest) return;
          entry.lastRevealRequest = parsed.requestId;
          this.revealRange(entry, parsed);
          return;
        }
        if (parsed.type === 'linkage-unavailable') {
          this.showLinkageUnavailable(parsed.reason);
          return;
        }
        if (parsed.type === 'source-highlight') {
          if (entry.suspend) {
            // Suspension window: highlighting was cleared on change, do not reapply the old mapping here (SPEC-PLAY-11)
            return;
          }
          this.applySourceHighlight(entry, parsed.ranges);
          return;
        }
        if (parsed.type === 'target-ranges') {
          if (entry.suspend) {
            // Suspension window: the outline was cleared on change, do not reapply the old mapping here (SPEC-PLAY-11)
            return;
          }
          entry.targetRanges = parsed.ranges;
          this.syncLinkedDecorations();
          return;
        }
        this.handlePlaybackState(entry, parsed.state);
      },
      undefined,
      this.disposables,
    );
  }

  /**
   * Render result: version mismatches are dropped; lifts the linkage suspension and re-sends the latest cursor recorded meanwhile;
   * a still-valid pending start request runs after the first successful render (SPEC-CMD-07 / 09, PLAY-11).
   */
  private handleRendered(entry: PanelEntry, message: WebviewRenderedMessage): void {
    if (message.context.version !== entry.version || message.context.revision !== entry.revision) return;
    entry.renderedOnce = true;
    entry.appliedRevision = entry.revision;
    // The version baseline is the latest push (entry.version): after reopening by URI following a closed source tab, entry.document may be the reopened object
    entry.suspend = !message.linkable || entry.pendingChange !== undefined || entry.version !== message.context.version || this.isReadOnlyEntry(entry);
    if (entry.lastCursorOffset !== undefined) this.sendCursor(entry, entry.lastCursorOffset);
    const request = entry.pendingRequest;
    entry.pendingRequest = undefined;
    if (request === undefined || !entry.panel.visible) return;
    if (request.kind === 'toggle') {
      if (message.ok && message.linkable) this.postPlayback(entry, 'toggle');
      return;
    }
    // The source target may be another tune and must not be blocked by the current tune's render failure.
    if (request.version !== entry.version) return;
    const playFrom: PlayFromCursorMessage = { type: 'play-from-cursor', context: message.context, requestId: ++entry.requestId, offset: request.offset };
    void entry.panel.webview.postMessage(playFrom);
  }

  /** Only one preview per window may produce sound: starting any panel pauses the others (SPEC-PLAY-01). */
  private handlePlaybackState(entry: PanelEntry, state: WebviewPlaybackStateMessage['state']): void {
    entry.phase = state;
    if (state !== 'playing') {
      return;
    }
    for (const other of this.panels.values()) {
      if (other !== entry) {
        this.postPlayback(other, 'pause');
      }
    }
  }

  private postPlayback(entry: PanelEntry, action: PlaybackMessage['action']): void {
    if (action !== 'toggle') entry.pendingRequest = undefined;
    const base = { type: 'playback' as const, viewId: entry.viewId, requestId: ++entry.requestId };
    if (action === 'toggle') {
      if (entry.context !== undefined) void entry.panel.webview.postMessage({ ...base, action, context: entry.context } satisfies PlaybackMessage);
    } else void entry.panel.webview.postMessage({ ...base, action } satisfies PlaybackMessage);
  }

  /**
   * The status page's "go to source" entry (SPEC-STATE-05 / CMD-12): shares the command's open path
   * (including reopening by URI after the source tab closed); the target is the panel binding, never a webview-supplied path.
   */
  private revealSource(entry: PanelEntry): void {
    void this.requestGoToSource(entry.document);
  }

  /**
   * Locate source from a clicked score note (SPEC-PLAY-11): set the selection and scroll into view, focus stays in the preview and the playback position is unchanged;
   * an invisible source is shown without stealing focus (the outline decoration is driven by the webview's target range report, not from here).
   */
  private revealRange(entry: PanelEntry, message: WebviewRevealRangeMessage): void {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === entry.uri,
    );
    if (document === undefined) {
      return;
    }
    // The active end takes the note start: the cursor offset reported back from the selection change lands on the same note (SPEC-PLAY-11)
    const selection = new vscode.Selection(
      document.positionAt(message.end),
      document.positionAt(message.start),
    );
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === entry.uri,
    );
    if (editor !== undefined) {
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    void vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
      preserveFocus: true, // Clicking the score does not move focus (SPEC-PLAY-11)
    }).then((opened) => {
      if (this.panels.get(entry.uri) !== entry || entry.suspend || entry.lastRevealRequest !== message.requestId || !sameContext(entry.context, message.context) || opened.document.version !== message.context.version) return;
      opened.selection = selection;
      opened.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }, (error: unknown) => this.reportSourceUnavailable(error));
  }

  /** Explanation when linkage is unavailable (SPEC-PLAY-11 / 12): no silent failure, no quietly playing from the beginning. */
  private showLinkageUnavailable(reason: LinkageUnavailableReason): void {
    void vscode.window.showInformationMessage(linkageUnavailableText(reason));
  }

  /** Source playback highlighting (SPEC-PLAY-11): decorates visible editors only, without scrolling, moving the cursor or opening a closed source tab for playback. */
  private applySourceHighlight(entry: PanelEntry, ranges: SourceHighlightRange[]): void {
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === entry.uri,
    );
    if (editor === undefined) {
      return;
    }
    const document = editor.document;
    const decorations = ranges.map((range) => ({
      range: new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)),
    }));
    editor.setDecorations(this.sourceHighlight, decorations);
  }

  /** Clear source playback highlighting (SPEC-PLAY-11): the old mapping's display is suspended immediately on document change or version switch. */
  private clearSourceHighlight(entry: PanelEntry): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === entry.uri) {
        editor.setDecorations(this.sourceHighlight, []);
      }
    }
  }

  /**
   * Sync the outline decoration from each document's current target note range (SPEC-PLAY-11): affects visible editors only,
   * cleared when there is no range (no hit / target cleared / content changed / panel closed).
   */
  private syncLinkedDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = this.panels.get(editor.document.uri.toString())?.targetRanges ?? [];
      const decorations = ranges.map((range) => ({
        range: new vscode.Range(
          editor.document.positionAt(range.start),
          editor.document.positionAt(range.end),
        ),
      }));
      editor.setDecorations(this.linkedNote, decorations);
    }
  }

  private documentMessage(entry: PanelEntry, document: vscode.TextDocument): DocumentMessage {
    const abc = document.getText();
    if (entry.version !== document.version || entry.lastPushedAbc !== abc) {
      entry.revision += 1;
      entry.suspend = true;
      entry.targetRanges = [];
      this.clearSourceHighlight(entry);
      this.syncLinkedDecorations();
    }
    entry.panel.title = panelTitle(document);
    entry.document = document;
    entry.version = document.version;
    entry.lastPushedAbc = abc;
    return { type: 'document', uri: entry.uri, fileName: fileNameOf(document), abc, isUntitled: document.isUntitled, version: document.version, viewId: entry.viewId, revision: entry.revision };
  }

  private pushDocument(entry: PanelEntry, document: vscode.TextDocument, continued = false): void {
    const message = this.documentMessage(entry, document);
    // A saved file's practice record is pushed only with the view's first push (SPEC-SET-02): after restore the webview reports the full record back
    if (!entry.renderedOnce && entry.practiceState !== undefined) message.practice = entry.practiceState;
    const request = entry.pendingRequest;
    if (!entry.renderedOnce && request?.kind === 'play-from-cursor') {
      entry.pendingRequest = undefined;
      if (request.version === document.version) message.initialRequest = { requestId: ++entry.requestId, offset: request.offset };
    }
    // Version push of a reliable migration (SPEC-LIFE-03): marks the same practice's new identity so the webview continues tune selection and settings records
    if (continued) message.continued = true;
    void entry.panel.webview.postMessage(message);
  }

  /** Build the webview HTML: the CSP allows only nonce'd own scripts and extension resources, connections only to the extension's own resources (SPEC-ENV-03). */
  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'));
    // The codicon icon font is handed to the webview via asWebviewUri (copied to out/codicons/ at build time, SPEC-ENV-05): icon button glyphs and the spin animation
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'codicons', 'codicon.css'),
    );
    // The local piano soundfont directory is handed to the webview via asWebviewUri (SPEC-ENV-05 / 07); abcjs's default remote URL must never be hit
    const soundfontUrl = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'soundfonts', 'FluidR3_GM'))
      .toString();
    const nonce = randomBytes(16).toString('hex');
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      // Soundfont files are read via XHR; allow the extension's own resources (connection targets stay within cspSource, SPEC-ENV-03)
      `connect-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ABC Desk</title>
  <link rel="stylesheet" href="${codiconUri}">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      margin: 0;
      /* The preview has no global horizontal scroll: the score scales to the container width and the keyboard scrolls internally; also a guard against overflow from an older wide render */
      overflow-x: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    /* Top bar (SPEC-PLAY-13): playback controls stick to the top of the preview and stay visible and clickable while a long score scrolls; the keyboard sticks to the bottom and the score scrolls between them.
       The file name and "unsaved" marker are not repeated here: the preview tab title already has them (SPEC-CMD-06) */
    #topbar {
      flex: 0 0 auto;
      position: sticky;
      top: 0;
      z-index: 3;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    /* SPEC-DOC-01: the tune list owns a full row; a long list scrolls internally without squeezing the original control groups. */
    #tunes { position: relative; padding: 6px 12px 0; }
    #tunes[hidden], #tune-list[hidden] { display: none; }
    #tunes > button {
      font: inherit; width: 100%; text-align: left; padding: 5px 8px;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 2px; cursor: pointer;
    }
    #tunes > button:focus-visible, #tune-list:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #tune-list {
      position: absolute; top: 100%; left: 12px; right: 12px; z-index: 5;
      max-height: min(320px, 55vh); overflow-y: auto; overscroll-behavior: contain;
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-focusBorder));
      box-shadow: 0 2px 6px var(--vscode-widget-shadow, rgba(0,0,0,.3));
    }
    #tune-list [role='option'] { padding: 6px 8px; overflow-wrap: anywhere; cursor: pointer; }
    #tune-list [aria-selected='true'] { font-weight: bold; }
    #tune-list .candidate { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; background: var(--vscode-list-focusBackground); }
    #tune-list [role='option']:hover { background: var(--vscode-list-hoverBackground); }
    #tune-list [aria-disabled='true'] { color: var(--vscode-disabledForeground); cursor: default; }
    #progress[aria-disabled='true'] { opacity: .5; cursor: default; }
    /* Controls (SPEC-PLAY-13): column spacing goes through per-group margin-right (the icon rhythm needs exact values), only the 8px row gap is kept */
    #controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      row-gap: 8px;
      padding: 6px 12px;
    }
    /* Stable groups (SPEC-PLAY-13): no wrapping inside a group, only between groups; default group spacing 12px */
    .abcdesk-control-group { display: inline-flex; align-items: center; gap: 8px; }
    .abcdesk-control-group:not(:last-child) { margin-right: 12px; }
    /* Icon rhythm (SPEC-PLAY-13): % ⟳ ⟲ ▶ ⏹ with a uniform 18px ink gap - speed group -> transport group 2.4px, loop -> play 1.45px,
       play -> stop 2.2px; the two pairs inside a group differ (glyph ink shrinks differently), hence per-pair margins rather than gap;
       values calibrated by measuring headless Chrome at 4x zoom (all four segments 18.00px); re-measure before changing */
    #speed-group { margin-right: 2.4px; }
    #transport-group { gap: 0; }
    #transport-group #play { margin-left: 1.45px; }
    #transport-group #stop { margin-left: 2.2px; }
    /* Score area: flex stretch pushes the keyboard dock to the bottom edge of the viewport (even for short documents); scrolling still goes through the whole page */
    #score-region {
      flex: 1 1 auto;
    }
    #controls button, #content-status button, #follow-resume {
      font: inherit;
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    #controls button:hover, #content-status button:hover, #follow-resume:hover { background: var(--vscode-button-hoverBackground); }
    /* "Play from here" (SPEC-PLAY-12): the disabled reason is carried by the wrapper element (a disabled button does not trigger its own tooltip) */
    #play-from-here-wrap { display: inline-flex; }
    #controls button:disabled {
      opacity: 0.5;
      cursor: default;
      background: var(--vscode-button-background);
    }
    /* Icon buttons (SPEC-PLAY-01 / 13, A11Y-06): 14px glyph; 20x20 visible hover face with 4px radius, 3px padding - same gauge as the VS Code toolbar (22px box / 16px glyph); measured at 4x zoom the right gap is 4.75 vs 5.00 native;
       the hover background must use background-color: the background shorthand resets background-clip to border-box and the grey face grows to the 26x26 hit area (caused several rounds of "too big" feedback);
       a 3px transparent border + padding-box clipping keeps the hit area at 26x26; semantics are carried by title and the accessible name */
    #controls button.codicon {
      font: normal normal normal 14px/1 codicon;
      padding: 3px;
      border: 3px solid transparent;
      background-color: transparent;
      background-clip: padding-box;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      border-radius: 7px;
    }
    #controls button.codicon:hover { background-color: var(--vscode-toolbar-hoverBackground, rgb(128 128 128 / 25%)); }
    /* Persistent pressed state of the loop toggle (SPEC-PLAY-03): aria-pressed carries the state, the active theme color is preferred with hover color as fallback;
       the rule is placed after hover - with equal specificity the later one wins, so an ON button keeps its pressed background while hovered; :disabled stays after it to keep priority */
    #controls button.codicon[aria-pressed='true'] {
      background-color: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground, rgb(128 128 128 / 25%)));
    }
    #controls button.codicon:disabled { background-color: transparent; }
    /* "Resume following" floating entry (SPEC-PLAY-11): fixed position, bottom edge clears the keyboard dock (height synced through a CSS variable) */
    #follow-resume {
      position: fixed;
      right: 16px;
      bottom: calc(var(--abcdesk-dock-height, 0px) + 16px);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    }
    #follow-resume[hidden] { display: none; }
    /* Status line (SPEC-PLAY-13): key status sits below the controls on its own row; takes no space without text */
    #playback-status {
      display: block;
      padding: 0 12px 6px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    #playback-status[hidden] { display: none; }
    /* Speed control (SPEC-PLAY-04): numeric input + reset to original; the BPM hint is shown only when it can be converted reliably */
    #speed-control { display: inline-flex; align-items: center; gap: 4px; }
    #speed-control input {
      font: inherit;
      width: 4.5em;
      padding: 3px 4px;
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      background: var(--vscode-input-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent));
      border-radius: 2px;
    }
    #speed-control input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #speed-hint { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
    #speed-hint[hidden] { display: none; }
    /* Reset-to-original is a de-emphasized icon: it does not compete visually with play / stop (the disabled background is handled by the generic .codicon:disabled rule);
       margin-left takes part in the "% ⟳ ▶ ⏹" even rhythm: in-group gap 4px + 5.15px = 18px ink gap (measured calibration) */
    #controls #speed-reset { margin-left: 5.15px; color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
    /* The progress bar owns a full row (SPEC-PLAY-05): thin track + round thumb, the full row height keeps it easy to hit */
    #progress-row { display: flex; align-items: center; gap: 8px; padding: 0 12px 6px; }
    #progress { position: relative; flex: 1 1 auto; min-width: 120px; height: 24px; cursor: pointer; touch-action: none; }
    #progress::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      height: 4px;
      transform: translateY(-50%);
      border-radius: 2px;
      background: var(--vscode-panel-border, rgb(128 128 128 / 40%));
    }
    #progress-fill {
      position: absolute;
      left: 0;
      top: 50%;
      height: 4px;
      width: 0;
      transform: translateY(-50%);
      border-radius: 2px;
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
    }
    #progress-thumb {
      position: absolute;
      top: 50%;
      left: 0;
      width: 12px;
      height: 12px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
      pointer-events: none;
    }
    /* While dragging (SPEC-PLAY-05): thicker track and thumb plus a grabbing cursor give immediate feedback that the drag took effect */
    #progress.abcdesk-dragging { cursor: grabbing; }
    #progress.abcdesk-dragging #progress-fill { height: 6px; }
    #progress.abcdesk-dragging #progress-thumb { transform: translate(-50%, -50%) scale(1.4); }
    #progress:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; border-radius: 2px; }
    #progress-time {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    /* Voices menu (SPEC-PLAY-06): native details/summary; the panel is positioned under the trigger without squeezing the control row */
    #voices-menu { position: relative; }
    #voices-menu[hidden] { display: none; }
    #voices-menu summary {
      font: inherit;
      list-style: none;
      padding: 4px 10px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, transparent));
      border-radius: 2px;
      cursor: pointer;
    }
    #voices-menu summary::-webkit-details-marker { display: none; }
    #voices-menu summary::after { content: ' ▾'; }
    #voices-menu[open] summary::after { content: ' ▴'; }
    #voices-panel {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 4;
      min-width: 180px;
      max-width: calc(100vw - 24px);
      max-height: 40vh;
      overflow-y: auto;
      padding: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, transparent));
      border-radius: 4px;
      box-shadow: 0 2px 8px rgb(0 0 0 / 35%);
    }
    /* "Pause to adjust voices" hint while playing (SPEC-PLAY-06): clicking pauses first, only then can voices be changed */
    #voices-pause {
      display: block;
      width: 100%;
      margin-bottom: 4px;
      font: inherit;
      padding: 3px 6px;
      text-align: left;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      background: transparent;
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    #voices-pause:hover { background: rgb(128 128 128 / 25%); }
    #voices-pause[hidden] { display: none; }
    /* More menu (SPEC-SET-07): same style as the voices menu; the reset entry carries an explanation, no new command is added */
    #more-menu { position: relative; }
    #more-menu summary {
      font: inherit;
      list-style: none;
      padding: 4px 10px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, transparent));
      border-radius: 2px;
      cursor: pointer;
    }
    #more-menu summary::-webkit-details-marker { display: none; }
    #more-menu summary::after { content: ' ▾'; }
    #more-menu[open] summary::after { content: ' ▴'; }
    #more-panel {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 4;
      width: 240px;
      max-width: calc(100vw - 24px);
      padding: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, transparent));
      border-radius: 4px;
      box-shadow: 0 2px 8px rgb(0 0 0 / 35%);
    }
    #reset-practice {
      display: block;
      width: 100%;
      font: inherit;
      padding: 6px;
      text-align: left;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: transparent;
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    #reset-practice:hover { background: rgb(128 128 128 / 25%); }
    #reset-practice-note {
      margin: 6px 4px 2px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      white-space: normal;
    }
    .abcdesk-voice-row { padding: 3px 4px; white-space: nowrap; }
    .abcdesk-voice-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    /* Content status area (SPEC-STATE-08): old score reference / empty state / pending update notice, below the controls */
    #content-status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    #content-status[hidden] { display: none; }
    /* Parse diagnostics (SPEC-STATE-06): the summary stays in the status area and raw details can be expanded; unreliable positions show no line numbers */
    #view-problems[hidden], #diagnostics-details[hidden] { display: none; }
    #diagnostics-details { flex-basis: 100%; }
    #diagnostics-summary { cursor: pointer; width: fit-content; }
    #diagnostics-list { margin: 4px 0 0; padding-left: 18px; }
    #diagnostics-list li { margin: 2px 0; }
    .abcdesk-diagnostic-detail { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); white-space: pre-wrap; }
    /* The score is rendered with a paper look (SPEC-A11Y-09): fixed foreground color so abcjs's currentColor does not inherit light staff lines in dark themes;
       box-sizing must be border-box: abcjs responsive writes an inline width:100% to the container, and with content-box the padding would overflow and widen it */
    #score { padding: 12px; background: #ffffff; color: #000000; min-height: 120px; position: relative; box-sizing: border-box; }
    /*
     * The score width always follows the container (overriding abcjs's inline width/height): the viewBox scales proportionally,
     * so a narrowing container (scrollbar appearing after render / panel changes) no longer overflows into a global horizontal scroll, and the dock stays as wide as the score.
     */
    #score > svg { display: block; width: 100% !important; height: auto !important; }
    /*
     * Score linkage marks (SPEC-PLAY-11): distinguished by both shape and color -
     * the current target note (shared by click and inspection) is a fill + a dashed box around the note (an overlay that stays out of the SVG and does not block click hits), playback highlighting recolors the note fill; both marks may coexist.
     * CSS class rules win over the presentation attributes abcjs writes; but attributes rewritten by native click selection are not restored when the class is removed,
     * so the webview restores them from the render snapshot when clearing marks (see snapshotNativePaint / clearTargetMarks in main.ts).
     */
    #score .abcdesk-reading-box {
      position: absolute;
      box-sizing: border-box;
      border: 1.5px dashed #1a73e8;
      border-radius: 3px;
      pointer-events: none;
    }
    /* Target fill (SPEC-PLAY-11 / 12): the current target shared by click and inspection; abcjs's native selected class gets the same color as a fallback to avoid flashing native bright red; playback highlighting rules stay after this (later wins at equal priority) */
    #score .abcjs-note_selected,
    #score .abcdesk-target { fill: #8ab4f8; }
    #score .abcdesk-playing { fill: #d84315; }
    /*
     * Keyboard visualization (SPEC-PLAY-08 / 09): a separate dock stuck to the bottom of the preview, shaped simply like a keyboard -
     * no box border or extra buttons; the dock bar keeps only the description / status and the de-emphasized range / collapse controls;
     * narrow windows scroll horizontally instead of compressing key widths.
     */
    #keyboard {
      flex: 0 0 auto;
      position: sticky;
      bottom: 0;
      z-index: 2;
      border-top: 1px solid var(--vscode-panel-border, transparent);
      background: #f1f3f5;
    }
    @media (prefers-color-scheme: dark) {
      #keyboard { background: #262a31; }
    }
    #keyboard[hidden] { display: none; }
    /* Dock bar: description and status on the left, controls on the right; one font size below body text so it does not compete with the keyboard */
    #keyboard-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 2px 8px;
      font-size: calc(var(--vscode-font-size, 13px) - 2px);
    }
    #keyboard-meta-spacer { flex: 1 1 auto; }
    #keyboard-caption, #keyboard-note {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    #keyboard-range-label { display: inline-flex; align-items: center; gap: 4px; }
    #keyboard-range-label[hidden] { display: none; }
    #keyboard-range {
      font: inherit;
      padding: 1px 4px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, transparent));
      border-radius: 2px;
    }
    /* Collapse / expand is a de-emphasized button: transparent background that appears on hover, keeping the dock bar quiet */
    #keyboard-collapse {
      font: inherit;
      padding: 1px 6px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      background: transparent;
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    #keyboard-collapse:hover { background: rgb(128 128 128 / 25%); }
    #keyboard-note[hidden] { display: none; }
    #keyboard-viewport { position: relative; }
    #keyboard-scroll {
      overflow-x: auto;
      padding: 0 8px 8px;
    }
    #keyboard-scroll[hidden] { display: none; }
    /* The keyboard scroll area is keyboard-accessible, but the 88 keys are not added to the Tab order (SPEC-A11Y-13) */
    #keyboard-scroll:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #keyboard-keys { display: flex; align-items: flex-start; gap: 0; min-height: 52px; }
    .abcdesk-key { position: relative; box-sizing: border-box; flex: 0 0 auto; border-radius: 0 0 3px 3px; }
    .abcdesk-key-white {
      z-index: 1;
      width: var(--abcdesk-white-key-width, 20px);
      height: var(--abcdesk-white-key-height, 52px);
      border: 1px solid #5a5a5a;
      border-left-width: 0;
      background: #ffffff;
    }
    .abcdesk-key-white:first-child { border-left-width: 1px; }
    .abcdesk-key-black {
      z-index: 2;
      width: var(--abcdesk-black-key-width, 12px);
      height: var(--abcdesk-black-key-height, 32px);
      margin: 0 var(--abcdesk-black-key-offset, -6px);
      background: #2b2b2b;
      box-shadow: inset 0 0 0 1px rgb(255 255 255 / 18%);
    }
    /* Octave labels on each C (SPEC-PLAY-08): bottom-right of the white key, middle C is C4 */
    .abcdesk-key-white[data-note^='C']::after {
      content: attr(data-note);
      position: absolute;
      right: 2px;
      bottom: 3px;
      font-size: 8px;
      line-height: 1;
      color: #5a5a5a;
    }
    /* Inspection / click reflection (SPEC-PLAY-15): same color family as the inspection dashed box; playback highlighting rules stay after this (playback color wins when both hit the same key) */
    .abcdesk-key-pointed { background: #1a73e8; }
    .abcdesk-key-pointed::after { color: #ffffff; }
    /* Playback highlighting (SPEC-PLAY-09): same color as the score highlight; a lit key does not mean a real key press or guaranteed sound */
    .abcdesk-key-active { background: #d84315; }
    .abcdesk-key-active::after { color: #ffffff; }
    /* Direction hints (SPEC-PLAY-08): shown when a sounding note is outside the viewport; they only hint at the direction and never pull the scroll position back */
    .abcdesk-keyboard-arrow {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      padding: 2px 4px;
      font-size: 10px;
      line-height: 1;
      color: #ffffff;
      background: rgb(0 0 0 / 45%);
      border-radius: 3px;
      pointer-events: none;
    }
    #keyboard-hint-left { left: 4px; }
    #keyboard-hint-right { right: 4px; }
    .abcdesk-keyboard-arrow[hidden] { display: none; }
    /* Uniform focus visibility (SPEC-A11Y-07): buttons / menu triggers / selects / voice checkboxes all show the theme focus ring */
    button:focus-visible, summary:focus-visible, select:focus-visible, .abcdesk-voice-row input:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    /* Low-height exception (D0): do not sandwich the score between two fixed areas; the keyboard returns to document flow and scrolls with the content; threshold is a provisional measured item */
    @media (max-height: 400px) {
      #keyboard { position: static; }
      /* Low-height top bar compression (SPEC-PLAY-13): keep at least play / pause and stop plus the key status summary */
      #controls { padding: 4px 12px; }
      #progress-row { padding: 0 12px 4px; }
      #playback-status { padding: 0 12px 4px; }
    }
  </style>
</head>
<body>
  <div id="topbar">
    <div id="tunes" hidden></div>
    <div id="controls">
      <!-- Speed group (SPEC-PLAY-13): leftmost - the practice flow is adjust speed first, then play -->
      <span class="abcdesk-control-group" id="speed-group">
        <span id="speed-control">
          <label id="speed-label" for="speed-input"></label>
          <input id="speed-input" type="number" min="25" max="200" step="5" inputmode="numeric">
          <span aria-hidden="true">%</span>
          <button id="speed-reset" type="button" class="codicon codicon-refresh"></button>
          <span id="speed-hint" hidden></span>
        </span>
      </span>
      <!-- Loop, play / pause and stop share a group (SPEC-PLAY-13 / 03): in a very narrow panel the whole group wraps down instead of being hidden along with the speed group;
           loop is a persistent toggle button (off by default) whose state is shown through aria-pressed -->
      <span class="abcdesk-control-group" id="transport-group">
        <button id="loop" type="button" class="codicon codicon-sync" aria-pressed="false"></button>
        <button id="play" type="button" class="codicon codicon-play"></button>
        <button id="stop" type="button" class="codicon codicon-debug-stop"></button>
      </span>
      <span class="abcdesk-control-group">
        <details id="voices-menu">
          <summary id="voices-summary"></summary>
          <div id="voices-panel">
            <button id="voices-pause" type="button" hidden></button>
            <div id="voices-list"></div>
          </div>
        </details>
      </span>
      <span class="abcdesk-control-group">
        <span id="play-from-here-wrap"><button id="play-from-here" type="button" disabled></button></span>
        <!-- More menu (SPEC-SET-07): resets this file's practice settings; does not modify the ABC and adds no public command -->
        <details id="more-menu">
          <summary id="more-summary"></summary>
          <div id="more-panel">
            <button id="reset-practice" type="button"></button>
            <p id="reset-practice-note"></p>
          </div>
        </details>
      </span>
    </div>
    <div id="progress-row">
      <div id="progress" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div id="progress-fill"></div>
        <div id="progress-thumb"></div>
      </div>
      <span id="progress-time"></span>
    </div>
    <span id="playback-status" role="status" aria-live="polite" hidden></span>
  </div>
  <div id="score-region">
    <div id="content-status" role="status" aria-live="polite" hidden>
      <span id="content-status-text"></span>
      <button id="view-problems" type="button" hidden></button>
      <!-- Parse diagnostics details (SPEC-STATE-06): warnings with unreliable positions are shown only here, without inventing line numbers -->
      <details id="diagnostics-details" hidden>
        <summary id="diagnostics-summary"></summary>
        <ul id="diagnostics-list"></ul>
      </details>
      <button id="confirm-tune" type="button" hidden></button>
      <button id="reveal-source" type="button" hidden></button>
      <!-- Migration status page entry (SPEC-LIFE-04): opens the target preview, never automatically and without stealing focus -->
      <button id="reveal-target" type="button" hidden></button>
    </div>
    <div id="score" tabindex="-1"></div>
  </div>
  <section id="keyboard" hidden>
    <div id="keyboard-meta">
      <span id="keyboard-caption"></span>
      <span id="keyboard-note" hidden></span>
      <span id="keyboard-meta-spacer"></span>
      <label id="keyboard-range-label"><span></span><select id="keyboard-range"><option value="tune" selected></option><option value="full"></option></select></label>
      <button id="keyboard-collapse" type="button"></button>
    </div>
    <div id="keyboard-viewport">
      <div id="keyboard-scroll" tabindex="0" role="group">
        <div id="keyboard-keys"></div>
      </div>
      <span id="keyboard-hint-left" class="abcdesk-keyboard-arrow" aria-hidden="true" hidden>◀</span>
      <span id="keyboard-hint-right" class="abcdesk-keyboard-arrow" aria-hidden="true" hidden>▶</span>
    </div>
  </section>
  <button id="follow-resume" type="button" hidden></button>
  <script nonce="${nonce}">window.__abcdesk = { soundfontUrl: ${JSON.stringify(soundfontUrl)} };</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const entry of this.panels.values()) {
      entry.panel.dispose();
    }
    this.panels.clear();
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    for (const timer of this.sourceTimers.values()) {
      clearTimeout(timer);
    }
    this.sourceTimers.clear();
    this.sourceGenerations.clear();
    this.sourceHighlight.dispose();
    this.linkedNote.dispose();
    this.diagnostics.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

function fileNameOf(document: vscode.TextDocument): string {
  return fileNameOfUri(document.uri);
}

/** File name of a URI (last path segment); falls back to the full URI text when there is no path segment. */
function fileNameOfUri(uri: vscode.Uri): string {
  const segments = uri.path.split('/');
  return segments[segments.length - 1] || uri.toString();
}

/** Display text of a source identity (SPEC-LIFE-06): the full path for ordinary files, the label for unsaved documents. */
function displayPathOf(uri: vscode.Uri): string {
  return uri.scheme === 'untitled' ? uri.path : uri.fsPath;
}

/** Escape a file name as a literal glob (SPEC-LIFE-08): watch the single bound file without treating wildcard characters in the name as a pattern. */
function escapeGlobPattern(name: string): string {
  return name.replace(/[?*[\]{}]/g, (char) => `[${char}]`);
}

/** Whether the target is still readable from the file system (SPEC-LIFE-08 existence re-check): a single delete event is not a permanent-loss verdict. */
async function fileReadable(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Read file text (compared with the latest push when there is no buffer); returns undefined on failure so the current state is kept until the next event. */
async function readTextFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Panel title: unsaved new documents are marked as not yet saved (SPEC-CMD-06). */
function panelTitle(document: vscode.TextDocument): string {
  const fileName = fileNameOf(document);
  return document.isUntitled ? vscode.l10n.t('{0} (Unsaved)', fileName) : fileName;
}

/** User-visible text for the reason linkage is unavailable (SPEC-PLAY-11 / 12). */
function linkageUnavailableText(reason: LinkageUnavailableReason): string {
  switch (reason) {
    case 'choose-tune':
      return vscode.l10n.t('Please select a tune again.');
    case 'structure-unreliable':
      return vscode.l10n.t('Some tune boundaries could not be identified. Check the ABC source.');
    case 'no-mapping':
      return vscode.l10n.t('No note matches the current position.');
    case 'no-selection':
      return vscode.l10n.t('Place the cursor on a note, or select one on the score.');
    case 'update-pending':
      return vscode.l10n.t('The file has unapplied changes; pause first to apply them.');
    case 'stale-score':
      return vscode.l10n.t('The preview shows an older version of the score, so it cannot be used.');
  }
}
