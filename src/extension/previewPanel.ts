import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  parseWebviewMessage,
  type DocumentMessage,
  type PlaybackMessage,
  type WebviewPlaybackStateMessage,
  type WebviewRenderedMessage,
} from '../core/messages';

/**
 * 音乐预览面板管理（SPEC-CMD-03 / 06 / 07 / 09 / 10、SPEC-ENV-03 / 04 / 05、SPEC-PLAY-01 / 02）：
 * - 同一文档复用已有面板，不重复创建（SPEC-CMD-03）；
 * - webview 资源仅经 asWebviewUri 加载，CSP 只放行 nonce 自有脚本与扩展自有资源（SPEC-ENV-03 / 05）；
 * - 不信任 webview 消息，经 parseWebviewMessage 按类型与版本校验（SPEC-ENV-04）；
 * - 文档变化（含未保存修改）推送到对应预览；标题与状态行标明尚未保存的新文档（SPEC-CMD-06）；
 * - 播放类命令可按需显示预览并保留源码焦点，首次渲染完成后仅执行仍有效的起播请求（SPEC-CMD-07 / 09）；
 * - 面板隐藏按暂停处理、恢复后不自动播放（SPEC-PLAY-02）；同一窗口内只允许一处预览发声（SPEC-PLAY-01）。
 *
 * 键盘可视化与源码联动等行为由后续批次接入（见 docs/spec/play.md、state.md）。
 */

/** 面板条目：面板本身与宿主侧需要核验的最小状态。 */
interface PanelEntry {
  panel: vscode.WebviewPanel;
  /** 绑定文档标识（URI 字符串）；预览在前台时作为控制命令的活动目标（SPEC-CMD-04）。 */
  uri: string;
  /** 最近一次推送 / 绑定的文档；就绪握手后据此补推最新内容。 */
  document: vscode.TextDocument;
  /** 最近一次推送的文档版本（SPEC-ENV-04 版本校验基准，rendered 消息按此比对）。 */
  version: number;
  /** 是否已收到过渲染结果（播放类命令据此决定立即转发还是等待渲染）。 */
  renderedOnce: boolean;
  /** 待首次渲染完成后转发的起播请求（SPEC-CMD-07 / 09）。 */
  pendingToggle: boolean;
}

export class PreviewPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** 创建或显示给定文档的预览；同文件已有预览时显示并推送最新内容（只显示，不起播）。 */
  createOrShow(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry !== undefined) {
      entry.panel.reveal();
      this.pushDocument(entry, document);
      return;
    }
    this.createPanel(document);
  }

  /** 播放 / 暂停命令入口（SPEC-CMD-07 / 09）：播放分支可创建或显示预览并保留源码焦点。 */
  requestToggle(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      // 按需创建：待首次渲染完成后执行仍有效的起播请求（SPEC-CMD-07）
      this.createPanel(document, true);
      return;
    }
    if (!entry.panel.visible) {
      // 隐藏时明确起播须先显示对应预览，不提供隐藏面板后台发声（SPEC-CMD-07）
      entry.panel.reveal(undefined, true);
    }
    if (!entry.renderedOnce) {
      entry.pendingToggle = true;
      return;
    }
    entry.pendingToggle = false;
    this.postPlayback(entry, 'toggle');
  }

  /** 停止命令入口（SPEC-CMD-10 / 11）：不新建预览；停音与取消起播不因音频未就绪失效。 */
  requestStop(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      return;
    }
    entry.pendingToggle = false;
    this.postPlayback(entry, 'stop');
  }

  /** 当前处于前台的预览所绑定的文档；预览在前台时作为控制命令的活动目标（SPEC-CMD-04）。 */
  activeDocument(): vscode.TextDocument | undefined {
    for (const entry of this.panels.values()) {
      if (entry.panel.active) {
        return vscode.workspace.textDocuments.find(
          (document) => document.uri.toString() === entry.uri,
        );
      }
    }
    return undefined;
  }

  /** 文档内容或保存状态变化时推送到对应预览（无对应预览时忽略）。 */
  notifyDocumentChanged(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry !== undefined) {
      this.pushDocument(entry, document);
    }
  }

  private createPanel(document: vscode.TextDocument, pendingToggle = false): void {
    const panel = vscode.window.createWebviewPanel(
      'abcdesk.preview',
      panelTitle(document),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // 隐藏时保留 webview 上下文：隐藏按暂停语义处理、恢复后可继续，不重新准备音频（SPEC-PLAY-02）
        retainContextWhenHidden: true,
        // 只允许扩展自有目录作为 webview 资源来源（SPEC-ENV-05）
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
      renderedOnce: false,
      pendingToggle,
    };
    this.panels.set(entry.uri, entry);
    panel.webview.html = this.renderHtml(panel.webview);
    if (pendingToggle) {
      // 播放类命令按需打开预览时不抢源码焦点（SPEC-CMD-07）
      panel.reveal(undefined, true);
    }
    panel.onDidDispose(
      () => {
        // 防止迟到的 dispose 回调误删同文件的新面板
        if (this.panels.get(entry.uri) === entry) {
          this.panels.delete(entry.uri);
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
        // 面板隐藏按暂停处理（SPEC-PLAY-02）；待起播请求随隐藏取消（SPEC-CMD-07）
        entry.pendingToggle = false;
        this.postPlayback(entry, 'pause');
      },
      undefined,
      this.disposables,
    );
    // webview 就绪握手后推送内容；其余消息不信任其来源，按类型与版本校验（SPEC-ENV-04）
    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        const parsed = parseWebviewMessage(message);
        if (parsed === undefined) {
          return;
        }
        if (parsed.type === 'ready') {
          this.pushDocument(entry, entry.document);
          return;
        }
        if (parsed.type === 'rendered') {
          this.handleRendered(entry, parsed);
          return;
        }
        this.handlePlaybackState(entry, parsed.state);
      },
      undefined,
      this.disposables,
    );
  }

  /** 渲染结果：版本不符丢弃；仍有效的待起播请求在首次渲染成功后执行（SPEC-CMD-07 / 09）。 */
  private handleRendered(entry: PanelEntry, message: WebviewRenderedMessage): void {
    if (message.version !== entry.version) {
      return;
    }
    entry.renderedOnce = true;
    if (!entry.pendingToggle) {
      return;
    }
    entry.pendingToggle = false;
    if (entry.panel.visible) {
      this.postPlayback(entry, 'toggle');
    }
  }

  /** 同一窗口内只允许一处预览发声：任一面板起播时暂停其他面板（SPEC-PLAY-01）。 */
  private handlePlaybackState(entry: PanelEntry, state: WebviewPlaybackStateMessage['state']): void {
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
    const message: PlaybackMessage = { type: 'playback', action };
    void entry.panel.webview.postMessage(message);
  }

  private pushDocument(entry: PanelEntry, document: vscode.TextDocument): void {
    entry.panel.title = panelTitle(document);
    entry.document = document;
    entry.version = document.version;
    const message: DocumentMessage = {
      type: 'document',
      uri: document.uri.toString(),
      fileName: fileNameOf(document),
      abc: document.getText(),
      isUntitled: document.isUntitled,
      version: document.version,
    };
    void entry.panel.webview.postMessage(message);
  }

  /** 生成 webview HTML：CSP 只放行 nonce 自有脚本与扩展资源，连接仅限扩展自有资源（SPEC-ENV-03）。 */
  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'));
    // 本地钢琴音色目录经 asWebviewUri 交给 webview（SPEC-ENV-05 / 07），abcjs 默认远程地址不得被触发
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
      // 音色文件经 XHR 读取，放行扩展自有资源（连接目标不超出 cspSource，SPEC-ENV-03）
      `connect-src ${webview.cspSource}`,
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
    #controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    #controls button {
      font: inherit;
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    #controls button:hover { background: var(--vscode-button-hoverBackground); }
    #playback-status { color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
    /* 谱面按纸张外观呈现，浅色 / 深色主题下均可读 */
    #score { padding: 12px; background: #ffffff; min-height: 120px; }
    #score svg { display: block; }
  </style>
</head>
<body>
  <div id="status"></div>
  <div id="controls">
    <button id="play" type="button"></button>
    <button id="stop" type="button"></button>
    <span id="playback-status" role="status" aria-live="polite"></span>
  </div>
  <div id="score"></div>
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
