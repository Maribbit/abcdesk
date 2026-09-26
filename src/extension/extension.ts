import * as vscode from 'vscode';

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
  // 骨架阶段：只注册占位实现。任何行为实现前必须先补全对应规格条目并写绑定测试。
  for (const id of COMMAND_IDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        void vscode.window.showInformationMessage(
          `ABC Desk: command "${id}" is not implemented yet (see docs/spec).`,
        );
      }),
    );
  }
}

export function deactivate(): void {
  // 骨架阶段无需清理：命令注册随 context 订阅自动释放。
}
