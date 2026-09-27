import * as vscode from 'vscode';
import { choosePreviewTarget, isAbcTarget, type TargetCandidate } from '../core/target';
import { PreviewPanelManager } from './previewPanel';

/**
 * 公开命令 ID：必须与 package.json、docs/spec/cmd.md（SPEC-CMD-01）逐字一致。
 * 数量与 ID 集合由 test/manifest.test.ts 的绑定测试守住。
 */
const COMMAND_IDS = [
  'abcdesk.openPreviewToSide',
  'abcdesk.togglePlayback',
  'abcdesk.stop',
  'abcdesk.playFromCursor',
  'abcdesk.playFromSelectedNote',
  'abcdesk.goToSource',
  'abcdesk.exportMidi',
  'abcdesk.exportSvg',
] as const;

export function activate(context: vscode.ExtensionContext): void {
  const previews = new PreviewPanelManager(context.extensionUri);
  context.subscriptions.push(previews);

  context.subscriptions.push(
    vscode.commands.registerCommand('abcdesk.openPreviewToSide', (resource?: unknown) =>
      openPreviewToSide(previews, resource),
    ),
    // 播放主干（M0）：播放 / 暂停与停止（SPEC-CMD-07 / 09 / 10 / 11）。
    vscode.commands.registerCommand('abcdesk.togglePlayback', () => togglePlaybackCommand(previews)),
    vscode.commands.registerCommand('abcdesk.stop', () => stopPlaybackCommand(previews)),
    // 源码联动（M0）：从光标播放 / 从所选音符播放 / 转到源码编辑（SPEC-CMD-07 / 08 / 12）。
    vscode.commands.registerCommand('abcdesk.playFromCursor', () => playFromCursorCommand(previews)),
    vscode.commands.registerCommand('abcdesk.playFromSelectedNote', () =>
      playFromSelectedNoteCommand(previews),
    ),
    vscode.commands.registerCommand('abcdesk.goToSource', () => goToSourceCommand(previews)),
  );

  // 其余命令为骨架占位：实现前必须先补全对应规格条目并写绑定测试。
  const implemented = new Set<string>([
    'abcdesk.openPreviewToSide',
    'abcdesk.togglePlayback',
    'abcdesk.stop',
    'abcdesk.playFromCursor',
    'abcdesk.playFromSelectedNote',
    'abcdesk.goToSource',
  ]);
  for (const id of COMMAND_IDS) {
    if (implemented.has(id)) {
      continue;
    }
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        void vscode.window.showInformationMessage(vscode.l10n.t('Command {0} is not implemented yet.', id));
      }),
    );
  }

  // 非播放期间的文档变化（含未保存修改与外部写入重载）推送到对应预览；
  // 播放中的待更新 / 换版规则由后续批次实现（见 docs/spec/state.md）。
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      previews.notifyDocumentChanged(event.document);
    }),
    // 源码光标移动推送到对应预览（SPEC-PLAY-11）：停止 / 暂停时突出映射音符并滚动，
    // 播放中只更新查阅标记；光标离开绑定文档时清除各预览的标记。
    vscode.window.onDidChangeTextEditorSelection((event) => {
      previews.notifySelectionChanged(event.textEditor);
    }),
  );
}

export function deactivate(): void {
  // 命令注册与面板随 context 订阅自动释放。
}

/**
 * 打开预览命令（SPEC-CMD-03 / 04 / 05 / 06）：
 * - 菜单传入的明确目标优先，无明确目标时用调用前的活动编辑器上下文；
 * - 目标无效时不回退到其他文件，也不弹选择器；
 * - 无任何目标时（命令面板）允许选择一个文件，取消不创建预览；
 * - 资源管理器入口不要求先打开源码；只显示预览，不起播。
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
 * 播放 / 暂停命令（SPEC-CMD-07 / 09 / 11）：控制当前曲目，不跟随光标切曲；
 * 无有效目标时不回退、不弹选择器，说明缺少目标（SPEC-CMD-05）。
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
 * 停止命令（SPEC-CMD-10 / 11）：不新建预览；
 * 无有效目标时说明缺少目标，无副作用（SPEC-CMD-05）。
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
 * "从光标播放"命令（SPEC-CMD-07 / 08）：只取当前 ABC 源码编辑器的光标；
 * 可靠确定曲目与音符时显式跨曲起播，按需打开对应预览并保留源码焦点；
 * 无有效源码目标时不回退、不弹选择器（SPEC-CMD-05）。
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
 * "从所选音符播放"命令（SPEC-CMD-08）：取预览内的当前目标音符（谱面点选或源码光标
 * 命中维护的同一目标）与起播映射；无预览 / 无目标时由预览面板回原因说明（SPEC-PLAY-12）。
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
 * "转到源码编辑"命令（SPEC-CMD-12）：目标为当前预览的来源文档并显式转移焦点；
 * 无有效音符映射时只打开来源文件、不套用旧偏移；来源标签已关闭时按 URI 重新打开，
 * 文件不可读取时才说明原因。
 */
function goToSourceCommand(previews: PreviewPanelManager): void {
  const document = resolveControlTarget(previews);
  if (document !== undefined) {
    void previews.requestGoToSource(document);
    return;
  }
  // 前台预览的来源标签已关闭（SPEC-LIFE-05）：绑定仍在，按 URI 重新打开（SPEC-CMD-12）
  const boundUri = previews.activeBoundUri();
  if (boundUri !== undefined) {
    void previews.requestGoToSourceByUri(boundUri);
    return;
  }
  void vscode.window.showInformationMessage(vscode.l10n.t('No ABC target is available.'));
}

/**
 * 控制命令的目标解析（SPEC-CMD-04 / 05）：预览在前台时使用其绑定文档，
 * 否则使用调用前的活动编辑器上下文；无目标时返回 undefined，不回退到其他文件。
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
