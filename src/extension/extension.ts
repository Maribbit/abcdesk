import * as vscode from 'vscode';
import { choosePreviewTarget, isAbcTarget, type TargetCandidate } from '../core/target';
import { runExportCommand } from './exports';
import { PreviewPanelManager } from './previewPanel';

// Exactly eight public commands (SPEC-CMD-01): ids must match package.json and docs/spec/cmd.md verbatim;
// the count and id set are guarded by the binding test in test/manifest.test.ts; command registration is centralized in activate.

export function activate(context: vscode.ExtensionContext): void {
  // Practice records live in the extension's workspace state (SPEC-SET-02 / 08, decision P04)
  const previews = new PreviewPanelManager(context.extensionUri, context.workspaceState);
  context.subscriptions.push(previews);

  context.subscriptions.push(
    vscode.commands.registerCommand('abcdesk.openPreviewToSide', (resource?: unknown) =>
      openPreviewToSide(previews, resource),
    ),
    // Playback core (M0): play / pause and stop (SPEC-CMD-07 / 09 / 10 / 11).
    vscode.commands.registerCommand('abcdesk.togglePlayback', () => togglePlaybackCommand(previews)),
    vscode.commands.registerCommand('abcdesk.stop', () => stopPlaybackCommand(previews)),
    // Source linkage (M0): play from cursor / play from selected note / go to source (SPEC-CMD-07 / 08 / 12).
    vscode.commands.registerCommand('abcdesk.playFromCursor', () => playFromCursorCommand(previews)),
    vscode.commands.registerCommand('abcdesk.playFromSelectedNote', () =>
      playFromSelectedNoteCommand(previews),
    ),
    vscode.commands.registerCommand('abcdesk.goToSource', () => goToSourceCommand(previews)),
    // Export (M0): MIDI / SVG independent preparation and save flow (SPEC-EXP-01 ~ 08).
    vscode.commands.registerCommand('abcdesk.exportMidi', () => runExportCommand(previews, 'midi')),
    vscode.commands.registerCommand('abcdesk.exportSvg', () => runExportCommand(previews, 'svg')),
  );

  // Document changes outside playback (unsaved edits and reloads from external writes) are pushed to the matching preview;
  // pending-update / version-switch rules during playback belong to a later batch (see docs/spec/state.md).
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      previews.notifyDocumentChanged(event.document);
    }),
    // File lifecycle (SPEC-LIFE-03 / 05 / 06): rename / move migrates the binding on reliable old-new pairs;
    // first save and save-as are told apart for continuation; after a tab closes the source state is re-checked against disk.
    vscode.workspace.onDidRenameFiles((event) => {
      previews.notifyFilesRenamed(event.files);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      previews.notifyDocumentSaved(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      previews.notifyDocumentClosed(document);
    }),
    // Source cursor moves are pushed to the matching preview (SPEC-PLAY-11): when stopped / paused the mapped note is highlighted and scrolled into view,
    // during playback only the inspection marker is updated; when the cursor leaves the bound document each preview's marker is cleared.
    vscode.window.onDidChangeTextEditorSelection((event) => {
      previews.notifySelectionChanged(event.textEditor);
    }),
  );
}

export function deactivate(): void {
  // Command registrations and panels are released automatically via context subscriptions.
}

/**
 * Open preview command (SPEC-CMD-03 / 04 / 05 / 06):
 * - an explicit target from a menu wins; without one the active editor context before the invocation is used;
 * - an invalid target neither falls back to another file nor shows a picker;
 * - with no target at all (command palette) a file may be picked; cancelling creates no preview;
 * - the explorer entry does not require the source to be open; it only shows the preview and does not start playback.
 */
async function openPreviewToSide(previews: PreviewPanelManager, resource: unknown): Promise<void> {
  const explicit = resource instanceof vscode.Uri ? candidateFromUri(resource) : undefined;
  const target = choosePreviewTarget(explicit, activeCandidate());

  if (target === undefined) {
    if (explicit !== undefined) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { ABC: ['abc'] },
    });
    const pickedUri = picked?.[0];
    if (pickedUri === undefined) {
      return;
    }
    previews.createOrShow(await vscode.workspace.openTextDocument(pickedUri));
    return;
  }

  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === target.uri);
  previews.createOrShow(open ?? (await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri))));
}

/**
 * Play / pause command (SPEC-CMD-07 / 09 / 11): controls the current tune and does not follow the cursor to another tune;
 * without a valid target there is no fallback and no picker, only a missing-target message (SPEC-CMD-05).
 */
function togglePlaybackCommand(previews: PreviewPanelManager): void {
  const document = resolveControlTarget(previews);
  if (document === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No ABC target is available.'));
    return;
  }
  previews.requestToggle(document);
}

/**
 * Stop command (SPEC-CMD-10 / 11): never creates a preview;
 * without a valid target it reports the missing target with no side effects (SPEC-CMD-05).
 */
function stopPlaybackCommand(previews: PreviewPanelManager): void {
  const document = resolveControlTarget(previews);
  if (document === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No ABC target is available.'));
    return;
  }
  previews.requestStop(document);
}

/**
 * "Play from cursor" command (SPEC-CMD-07 / 08): takes only the cursor of the current ABC source editor;
 * when tune and note are reliably determined it explicitly starts playback across tunes, opening the preview as needed while keeping source focus;
 * without a valid source target there is no fallback and no picker (SPEC-CMD-05).
 */
function playFromCursorCommand(previews: PreviewPanelManager): void {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || !isAbcTarget(candidateFromDocument(editor.document))) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No ABC target is available.'));
    return;
  }
  const offset = editor.document.offsetAt(editor.selection.active);
  previews.requestPlayFromCursor(editor.document, offset);
}

/**
 * "Play from selected note" command (SPEC-CMD-08): takes the preview's current target note (the single target maintained by
 * score clicks or source cursor hits) and its start mapping; with no preview / no target the panel reports the reason (SPEC-PLAY-12).
 */
function playFromSelectedNoteCommand(previews: PreviewPanelManager): void {
  const document = resolveControlTarget(previews);
  if (document === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No ABC target is available.'));
    return;
  }
  previews.requestPlayFromSelection(document);
}

/**
 * "Go to source" command (SPEC-CMD-12): targets the current preview's source document and explicitly moves focus;
 * without a valid note mapping it only opens the source file without applying a stale offset; a closed source tab is reopened by URI,
 * and the reason is reported only when the file cannot be read.
 */
function goToSourceCommand(previews: PreviewPanelManager): void {
  const document = resolveControlTarget(previews);
  if (document !== undefined) {
    void previews.requestGoToSource(document);
    return;
  }
  // The foreground preview's source tab is closed (SPEC-LIFE-05): the binding remains, reopen by URI (SPEC-CMD-12)
  const boundUri = previews.activeBoundUri();
  if (boundUri !== undefined) {
    void previews.requestGoToSourceByUri(boundUri);
    return;
  }
  void vscode.window.showInformationMessage(vscode.l10n.t('No ABC target is available.'));
}

/**
 * Target resolution for control commands (SPEC-CMD-04 / 05): a foreground preview uses its bound document,
 * otherwise the active editor context before the invocation; undefined when there is no target, never another file.
 */
function resolveControlTarget(previews: PreviewPanelManager): vscode.TextDocument | undefined {
  const fromPreview = previews.activeDocument();
  if (fromPreview !== undefined) {
    return fromPreview;
  }
  const target = choosePreviewTarget(undefined, activeCandidate());
  if (target === undefined) {
    return undefined;
  }
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === target.uri);
}

function candidateFromUri(uri: vscode.Uri): TargetCandidate {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  return {
    uri: uri.toString(),
    languageId: open?.languageId ?? '',
    isUntitled: open?.isUntitled ?? uri.scheme === 'untitled',
  };
}

function candidateFromDocument(document: vscode.TextDocument): TargetCandidate {
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    isUntitled: document.isUntitled,
  };
}

function activeCandidate(): TargetCandidate | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return undefined;
  }
  return candidateFromDocument(editor.document);
}
