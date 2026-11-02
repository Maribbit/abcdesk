/**
 * Export command flow (SPEC-EXP-01 ~ 08): shared by the MIDI / SVG public commands.
 * The source snapshot is locked from the command target; after tune confirmation and independent preparation (cancellable progress)
 * the native save dialog is shown; task validity is re-checked both when the dialog returns and before writing (SPEC-EXP-03, PERF-09).
 *
 * Export does not depend on preview / playback: it works without a preview and leaves an existing preview's state untouched (SPEC-EXP-04).
 */
import * as vscode from 'vscode';
import { suggestExportFileName } from '../core/exports/filename';
import { generateMidiBytes } from '../core/exports/midi';
import { generateSvgText } from '../core/exports/svg';
import {
  listTunes,
  type ExportTune,
} from '../core/exports/tunes';
import { choosePreviewTarget } from '../core/target';
import { PreviewPanelManager } from './previewPanel';

/** Export format: the two commands prepare and judge capability separately, without affecting each other (SPEC-EXP-04). */
export type ExportFormat = 'midi' | 'svg';

/** Export source: locked when the command starts (SPEC-EXP-01 / 03); later focus changes do not alter the target. */
interface ExportSource {
  uri: vscode.Uri;
  /** Whether started from a preview: the task is cancelled when that panel closes (SPEC-EXP-03). */
  fromPreview: boolean;
}

/** Snapshot of the source document (SPEC-EXP-01): the buffer wins when an editor document is open, otherwise the file is read. */
interface ExportSnapshot {
  text: string;
  /** Whether unsaved changes are included (stated explicitly before export). */
  dirty: boolean;
}

/** Preparation result: distinguishes empty content / cancelled / failed so the flow can report each separately (SPEC-EXP-08). */
type PreparedExport =
  | { kind: 'ready'; bytes: Uint8Array }
  | { kind: 'empty' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/** Export command entry: shared MIDI / SVG flow; only the preparation step and file type differ. */
export async function runExportCommand(
  previews: PreviewPanelManager,
  format: ExportFormat,
): Promise<void> {
  const source = resolveExportSource(previews);
  if (source === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No ABC target is available.'));
    return;
  }

  const snapshot = await readSnapshot(source.uri);
  if (snapshot === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('The source document is unavailable.'));
    return;
  }
  // SPEC-EXP-01: when the source version is behind or has unsaved changes, say so explicitly without blocking the export
  if (source.fromPreview && previews.isPreviewStale(source.uri.toString())) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Exporting the current document, not the version shown in the preview.'),
    );
  }
  if (snapshot.dirty) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The document has unsaved changes; they are included in the export.'),
    );
  }

  const tunes = await listTunes(snapshot.text);
  if (tunes.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('The document has no notes to export.'));
    return;
  }
  const tune = await pickTune(tunes, source.uri);
  if (tune === undefined) {
    return; // Cancelling the selection has no side effects (SPEC-EXP-02)
  }

  const prepared = await prepareExport(tune.abc, format);
  if (prepared.kind === 'cancelled') {
    return; // After a cancelled preparation the save / write step must not run (PERF-09)
  }
  if (prepared.kind === 'empty') {
    void vscode.window.showInformationMessage(vscode.l10n.t('The document has no notes to export.'));
    return;
  }
  if (prepared.kind === 'failed') {
    void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', prepared.message));
    return;
  }

  // Save flow (SPEC-EXP-07): native dialog; the suggested name is editable and cancelling writes nothing
  const fileName = suggestExportFileName({
    documentStem: source.uri.scheme === 'untitled' ? undefined : documentStem(source.uri),
    tuneTitle: tune.title,
    tuneCount: tunes.length,
    tuneSequence: tune.sequence,
    extension: format === 'midi' ? 'mid' : 'svg',
  });
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: defaultSaveUri(source.uri, fileName),
    filters: format === 'midi' ? { MIDI: ['mid'] } : { SVG: ['svg'] },
    title:
      format === 'midi'
        ? vscode.l10n.t('Export MIDI — ABC tempo and voices as written (no player practice settings)')
        : vscode.l10n.t('Export SVG'),
  });
  if (saveUri === undefined) {
    return;
  }

  // Final check before writing (SPEC-EXP-03 / PERF-09): overwriting the source, a closed preview or changed content all skip the write
  if (saveUri.toString() === source.uri.toString()) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The export cannot overwrite the source ABC file.'),
    );
    return;
  }
  if (source.fromPreview && !previews.isPreviewOpen(source.uri.toString())) {
    return;
  }
  if (!(await snapshotUnchanged(source.uri, snapshot.text))) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The document changed; export canceled. Run the export again.'),
    );
    return;
  }

  try {
    // SPEC-ENV-05: keep the full URI so VS Code routes it to the matching file system provider.
    await vscode.workspace.fs.writeFile(saveUri, prepared.bytes);
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', errorMessage(error)));
    return;
  }
  // Report success only after the write succeeded (SPEC-EXP-07): the exported file is not opened automatically
  void vscode.window.showInformationMessage(vscode.l10n.t('Exported to {0}.', saveUri.fsPath));
}

/**
 * Resolve the export source (SPEC-EXP-01 / 03): a foreground preview uses its bound document (still valid when the tab is closed),
 * otherwise the active ABC editor before the invocation; without a valid target there is no fallback and no picker.
 */
function resolveExportSource(previews: PreviewPanelManager): ExportSource | undefined {
  const bound = previews.activeBoundUri();
  if (bound !== undefined) {
    return { uri: vscode.Uri.parse(bound), fromPreview: true };
  }
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return undefined;
  }
  const target = choosePreviewTarget(undefined, {
    uri: editor.document.uri.toString(),
    languageId: editor.document.languageId,
    isUntitled: editor.document.isUntitled,
  });
  return target === undefined ? undefined : { uri: editor.document.uri, fromPreview: false };
}

/** Read the source snapshot (SPEC-EXP-01): editor buffer first (including unsaved changes), otherwise the file; undefined when unavailable. */
async function readSnapshot(uri: vscode.Uri): Promise<ExportSnapshot | undefined> {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );
  if (open !== undefined) {
    return { text: open.getText(), dirty: open.isDirty };
  }
  try {
    return { text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), dirty: false };
  } catch {
    return undefined;
  }
}

/** Re-check before writing that the source content is unchanged (SPEC-EXP-03); an unavailable source also invalidates the task instead of switching to a new version. */
async function snapshotUnchanged(source: vscode.Uri, expected: string): Promise<boolean> {
  const current = await readSnapshot(source);
  return current !== undefined && current.text === expected;
}

/**
 * Tune confirmation (SPEC-EXP-02): a single-tune file is prepared directly without a list;
 * a multi-tune list shows index, `X:` and title, preselects the tune under the cursor at invocation but still requires confirmation.
 */
async function pickTune(tunes: ExportTune[], sourceUri: vscode.Uri): Promise<ExportTune | undefined> {
  if (tunes.length <= 1) {
    return tunes[0];
  }
  const preselect = preselectTuneIndex(tunes, sourceUri);
  const items = tunes.map((tune) => ({
    label: tuneLabel(tune),
    index: tune.sequence - 1,
    picked: tune.sequence - 1 === preselect,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select a tune to export'),
  });
  if (picked === undefined) {
    return undefined;
  }
  return tunes[picked.index];
}

/** Tune list item text: index, `X:` (when present) and title (when present). */
function tuneLabel(tune: ExportTune): string {
  const parts = [`${tune.sequence}.`];
  if (tune.id !== '') {
    parts.push(`X:${tune.id}`);
  }
  const title = tune.title.trim();
  if (title !== '') {
    parts.push(title);
  }
  return parts.join(' ');
}

/**
 * Preselected tune (SPEC-EXP-02): when the active editor is the source document, the tune under the cursor;
 * the first tune when there is no reliable match - it never replaces the user's choice (confirmation in the list is still required).
 */
function preselectTuneIndex(tunes: ExportTune[], sourceUri: vscode.Uri): number {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.toString() !== sourceUri.toString()) {
    return 0;
  }
  const offset = editor.document.offsetAt(editor.selection.active);
  for (let index = tunes.length - 1; index >= 0; index -= 1) {
    if (tunes[index].startPos <= offset) {
      return index;
    }
  }
  return 0;
}

/**
 * Prepare export data (SPEC-EXP-04 / 08): notification-style cancellable progress, works without a preview;
 * cancellation boundaries: checked once before preparation starts and once after generation; cancelled tasks never reach save (PERF-09).
 */
async function prepareExport(abcText: string, format: ExportFormat): Promise<PreparedExport> {
  const title = format === 'midi' ? 'Exporting MIDI…' : 'Exporting SVG…';
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t(title), cancellable: true },
    async (_progress, token): Promise<PreparedExport> => {
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = await buildExportBytes(abcText, format);
      } catch (error) {
        return { kind: 'failed', message: errorMessage(error) };
      }
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }
      return bytes === undefined ? { kind: 'empty' } : { kind: 'ready', bytes };
    },
  );
}

/** Generate bytes per format (SPEC-EXP-05 / 06): MIDI is produced as binary directly; SVG text is encoded as UTF-8. */
async function buildExportBytes(
  abcText: string,
  format: ExportFormat,
): Promise<Uint8Array | undefined> {
  if (format === 'midi') {
    return generateMidiBytes(abcText);
  }
  const svgText = await generateSvgText(abcText);
  return svgText === undefined ? undefined : new TextEncoder().encode(svgText);
}

/** Default save location (SPEC-EXP-07): the source file's directory for saved documents; the first workspace folder for unsaved ones. */
function defaultSaveUri(source: vscode.Uri, fileName: string): vscode.Uri | undefined {
  if (source.scheme === 'untitled') {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, fileName);
  }
  return vscode.Uri.joinPath(vscode.Uri.joinPath(source, '..'), fileName);
}

/** Source file base name (without extension) used for the default export file name (SPEC-EXP-07). */
function documentStem(uri: vscode.Uri): string {
  const base = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
