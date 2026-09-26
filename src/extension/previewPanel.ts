import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseWebviewMessage } from '../core/messages';

/**
 * 音乐预览面板管理（SPEC-CMD-03 / 06、SPEC-ENV-03 / 04 / 05）：
 * - 同一文档复用已有面板，不重复创建（SPEC-CMD-03）；
 * - webview 资源仅经 asWebviewUri 加载，CSP 只放行带 nonce 的自有脚本与扩展资源（SPEC-ENV-03 / 05）；
 * - 不信任 webview 消息，经 parseWebviewMessage 按类型校验（SPEC-ENV-04）；
 * - 文档变化（含未保存修改）推送到对应预览；标题与状态行标明尚未保存的新文档（SPEC-CMD-06）。
 *
 * 播放、键盘与联动等行为由后续批次接入（见 docs/spec/play.md、state.md）。
 */

interface DocumentMessage {
  type: 'document';
  uri: string;
  fileName: string;
  abc: string;
  isUntitled: boolean;
  version: number;
}

export class PreviewPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** 创建或显示给定文档的预览；同文件已有预览时显示并推送最新内容。 */
  createOrShow(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.reveal();
      this.pushDocument(existing, document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'abcdesk.preview',
      panelTitle(document),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // 只允许扩展自有目录作为 webview 资源来源（SPEC-ENV-05）
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'out'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      },
    );
    this.panels.set(key, panel);
    panel.webview.html = this.renderHtml(panel.webview);
    panel.onDidDispose(
      () => {
        // 防止迟到的 dispose 回调误删同文件的新面板
        if (this.panels.get(key) === panel) {
          this.panels.delete(key);
        }
      },
      undefined,
      this.disposables,
    );
    // webview 就绪握手后再推送内容；不信任其消息，只接受已登记类型（SPEC-ENV-04）
    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        if (parseWebviewMessage(message)?.type === 'ready') {
          this.pushDocument(panel, document);
        }
      },
      undefined,
      this.disposables,
    );
  }

  /** 文档内容或保存状态变化时推送到对应预览（无对应预览时忽略）。 */
  notifyDocumentChanged(document: vscode.TextDocument): void {
    const panel = this.panels.get(document.uri.toString());
    if (panel !== undefined) {
      this.pushDocument(panel, document);
    }
  }

  private pushDocument(panel: vscode.WebviewPanel, document: vscode.TextDocument): void {
    panel.title = panelTitle(document);
    const message: DocumentMessage = {
      type: 'document',
      uri: document.uri.toString(),
      fileName: fileNameOf(document),
      abc: document.getText(),
      isUntitled: document.isUntitled,
      version: document.version,
    };
    void panel.webview.postMessage(message);
  }

  /** 生成 webview HTML：CSP 只放行 nonce 自有脚本与扩展资源，不放行远程内容（SPEC-ENV-03）。 */
  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'));
    const nonce = randomBytes(16).toString('hex');
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      "connect-src 'none'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ABC Desk</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #status {
      position: sticky;
      top: 0;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* 谱面按纸张外观呈现，浅色 / 深色主题下均可读 */
    #score { padding: 12px; background: #ffffff; min-height: 120px; }
    #score svg { display: block; }
  </style>
</head>
<body>
  <div id="status"></div>
  <div id="score"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

function fileNameOf(document: vscode.TextDocument): string {
  const segments = document.uri.path.split('/');
  return segments[segments.length - 1] || document.uri.toString();
}

/** 面板标题：未保存新文档标明尚未保存（SPEC-CMD-06）。 */
function panelTitle(document: vscode.TextDocument): string {
  const fileName = fileNameOf(document);
  return document.isUntitled ? vscode.l10n.t('{0} (Unsaved)', fileName) : fileName;
}
