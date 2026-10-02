/**
 * 导出命令流程（SPEC-EXP-01 ~ 08）：MIDI / SVG 两个公开命令共用，
 * 从命令目标锁定来源快照，经曲目确认与独立准备（progress 可取消）后，
 * 走原生保存对话框；保存对话框返回与开始写入前都重新核验任务有效性（SPEC-EXP-03、PERF-09）。
 *
 * 导出不依赖预览 / 播放：没有预览也可用，已有预览时不改变其状态（SPEC-EXP-04）。
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

/** 导出格式：两个命令分别准备与判断能力，不相互牵连（SPEC-EXP-04）。 */
export type ExportFormat = 'midi' | 'svg';

/** 导出来源：命令启动时锁定（SPEC-EXP-01 / 03），此后焦点变化不改变目标。 */
interface ExportSource {
  uri: vscode.Uri;
  /** 是否从预览发起：该面板关闭后取消任务（SPEC-EXP-03）。 */
  fromPreview: boolean;
}

/** 来源文档内容快照（SPEC-EXP-01）：有打开的编辑器文档时以缓冲区为准，否则读取文件。 */
interface ExportSnapshot {
  text: string;
  /** 是否包含未保存修改（导出前明确提示）。 */
  dirty: boolean;
}

/** 准备结果：区分空内容 / 取消 / 失败，交由流程分别反馈（SPEC-EXP-08）。 */
type PreparedExport =
  | { kind: 'ready'; bytes: Uint8Array }
  | { kind: 'empty' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/** 导出命令入口：MIDI / SVG 共用流程，仅准备阶段与文件类型不同。 */
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
  // SPEC-EXP-01：来源版本落后或含未保存修改时明确提示，不阻止导出
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
    return; // 取消选择无副作用（SPEC-EXP-02）
  }

  const prepared = await prepareExport(tune.abc, format);
  if (prepared.kind === 'cancelled') {
    return; // 准备取消后不得进入保存写入（PERF-09）
  }
  if (prepared.kind === 'empty') {
    void vscode.window.showInformationMessage(vscode.l10n.t('The document has no notes to export.'));
    return;
  }
  if (prepared.kind === 'failed') {
    void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', prepared.message));
    return;
  }

  // 保存流程（SPEC-EXP-07）：原生对话框；建议名可修改，取消不写文件
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

  // 开始写入前的最后校验（SPEC-EXP-03 / PERF-09）：覆盖来源、预览关闭与内容变化都不进入写入
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
    // SPEC-ENV-05：保留完整 URI，由 VS Code 路由到对应文件系统提供者。
    await vscode.workspace.fs.writeFile(saveUri, prepared.bytes);
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', errorMessage(error)));
    return;
  }
  // 仅在写入成功后报告成功（SPEC-EXP-07）：不自动打开导出文件
  void vscode.window.showInformationMessage(vscode.l10n.t('Exported to {0}.', saveUri.fsPath));
}

/**
 * 解析导出来源（SPEC-EXP-01 / 03）：预览在前台时使用其绑定文档（标签关闭不失效），
 * 否则使用调用前的活动 ABC 编辑器；无有效目标时不回退、不弹选择器。
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

/** 读取来源快照（SPEC-EXP-01）：编辑器缓冲区优先（含未保存修改），否则读取文件；不可用时返回 undefined。 */
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

/** 写入前复核来源内容未变化（SPEC-EXP-03）；来源不可用同样视为任务失效，不自动改用新版。 */
async function snapshotUnchanged(source: vscode.Uri, expected: string): Promise<boolean> {
  const current = await readSnapshot(source);
  return current !== undefined && current.text === expected;
}

/**
 * 曲目确认（SPEC-EXP-02）：单曲文件直接准备，不显示选择列表；
 * 多曲目列表含序号、`X:` 与标题，按调用时光标所属曲目预选但仍须确认。
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

/** 曲目列表条目文本：序号、`X:`（有值时）与标题（有值时）。 */
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
 * 预选曲目（SPEC-EXP-02）：活动编辑器属于来源文档时取光标所属曲目；
 * 无可靠对应时为首曲，不代替用户选择（仍须在列表中确认）。
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
 * 准备导出数据（SPEC-EXP-04 / 08）：通知形态进度可取消，无预览也可用；
 * 取消边界：准备开始前与生成完成后各检查一次，取消不进入保存（PERF-09）。
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

/** 按格式生成字节（SPEC-EXP-05 / 06）：MIDI 直接生成二进制；SVG 生成文本后按 UTF-8 编码。 */
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

/** 默认保存位置（SPEC-EXP-07）：已保存文档取源文件同目录；未保存新文档取首个工作区文件夹。 */
function defaultSaveUri(source: vscode.Uri, fileName: string): vscode.Uri | undefined {
  if (source.scheme === 'untitled') {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, fileName);
  }
  return vscode.Uri.joinPath(vscode.Uri.joinPath(source, '..'), fileName);
}

/** 来源文件基本名（不含扩展名），用于默认导出文件名（SPEC-EXP-07）。 */
function documentStem(uri: vscode.Uri): string {
  const base = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
