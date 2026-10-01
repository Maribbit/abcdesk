import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  parseWebviewMessage,
  type CursorMessage,
  type DocumentMessage,
  type LinkageUnavailableReason,
  type PlaybackMessage,
  type PlayFromCursorMessage,
  type SourceHighlightRange,
  type WebviewPlaybackStateMessage,
  type WebviewRenderedMessage,
  type WebviewRevealRangeMessage,
} from '../core/messages';

/**
 * 音乐预览面板管理（SPEC-CMD-03 / 06 / 07 / 09 / 10 / 12、SPEC-ENV-03 / 04 / 05、SPEC-PLAY-01 / 02 / 11）：
 * - 同一文档复用已有面板，不重复创建（SPEC-CMD-03）；
 * - webview 资源仅经 asWebviewUri 加载，CSP 只放行 nonce 自有脚本与扩展自有资源（SPEC-ENV-03 / 05）；
 * - 不信任 webview 消息，经 parseWebviewMessage 按类型与版本校验（SPEC-ENV-04）；
 * - 文档变化（含未保存修改）经防抖推送到对应预览；预览标签标题标明文件名与尚未保存的新文档（SPEC-CMD-06）；
 * - 播放中的换版与应用时机由 webview 按 SPEC-STATE-07 执行，宿主只负责推送最新版本；
 * - 播放类命令可按需显示预览并保留源码焦点，首次渲染成功后仅执行仍有效的起播请求（SPEC-CMD-07 / 09）；
 * - 文档变化到新版本渲染确认之间停用源码联动：不推送光标、不定位、不起播，并清除源码高亮（SPEC-PLAY-11）；
 * - 点击谱面音符的源码定位只设选区与滚动、不抢焦点，编辑器侧以专用轮廓标记呈现当前目标音符的源码区间（随目标同步、与原生选区 / 同文高亮双重区分）；播放高亮只对可见编辑器设装饰（SPEC-PLAY-11）；
 * - 面板隐藏按暂停处理、恢复后不自动播放（SPEC-PLAY-02）；同一窗口内只允许一处预览发声（SPEC-PLAY-01）；
 * - 空状态的"转到源码编辑"入口与 goToSource 命令打开来源文档并转移焦点，来源标签关闭后按 URI 重新打开（SPEC-STATE-05 / CMD-12）。
 *
 * 键盘可视化（SPEC-PLAY-08 / 09）与播放控件（速度 / 进度 / 声部，SPEC-PLAY-04 / 05 / 06）
 * 均在 webview 内实现：宿主只提供 DOM 骨架与样式，界面状态不新增消息
 * （跨会话恢复留待设置记忆批次，SPEC-SET-05）；进度条独占一行，支持拖动与键盘定位。
 * 布局形态：顶栏（播放控件）粘在预览顶部、键盘作为独立 dock 粘在底部（无多余按钮，形态对齐 chatmusic 调校版），
 * 长谱滚动时两者保持可见可点；低高度回退内容整体滚动、键盘回文档流（D0 低高度例外，阈值为暂订实测项）。
 */

/** 待首次渲染完成后执行的起播请求（SPEC-CMD-07 / 09）。 */
type PendingRequest = { kind: 'toggle' } | { kind: 'play-from-cursor'; offset: number };

/** 面板条目：面板本身与宿主侧需要核验的最小状态。 */
interface PanelEntry {
  panel: vscode.WebviewPanel;
  /** 绑定文档标识（URI 字符串）；预览在前台时作为控制命令的活动目标（SPEC-CMD-04）。 */
  uri: string;
  /** 最近一次推送 / 绑定的文档；就绪握手后据此补推最新内容。 */
  document: vscode.TextDocument;
  /** 最近一次推送的文档版本（SPEC-ENV-04 版本校验基准，rendered 消息按此比对）。 */
  version: number;
  /** 最近一次推送给预览的文档文本（SPEC-CMD-12）：来源标签关闭后重新打开时按内容差异决定是否换版。 */
  lastPushedAbc: string | undefined;
  /** 是否已收到过渲染结果（播放类命令据此决定立即转发还是等待渲染）。 */
  renderedOnce: boolean;
  /** 待首次渲染完成后执行的起播请求（SPEC-CMD-07 / 09）；取消或渲染失败时丢弃。 */
  pendingRequest: PendingRequest | undefined;
  /** 联动停用窗口（SPEC-PLAY-11）：文档已变化、新版本尚未渲染确认；期间不推送光标、不定位、不起播。 */
  suspend: boolean;
  /** 联动停用期间记录的最新光标偏移，渲染完成后补发（SPEC-PLAY-11）。 */
  lastCursorOffset: number | undefined;
  /** 防抖期间待推送的最新文档（SPEC-CMD-06）。 */
  pendingChange: vscode.TextDocument | undefined;
  /** 当前目标音符的源码区间（SPEC-PLAY-11 轮廓标记 / SPEC-CMD-12 落点依据），由 webview 目标回传驱动；目标清除 / 内容变化时清空，不套用旧偏移。 */
  targetRanges: SourceHighlightRange[];
}

/** 文档更新推送防抖（毫秒）：连续输入只在稳定后推送一次最新版本。 */
const UPDATE_DEBOUNCE_MS = 300;

export class PreviewPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  /** 各文档待推送的防抖计时器（按 URI 键控）。 */
  private readonly updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 源码播放高亮装饰（SPEC-PLAY-11）：只对可见编辑器设置，不滚动、不移动光标。 */
  private readonly sourceHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
  });
  /**
   * 当前目标音符的联动轮廓标记（SPEC-PLAY-11）：描边 + 概览标尺刻度，
   * 与原生选区（圆角填充）和 VS Code 同文高亮（灰盒）以形状与颜色双重区分；
   * 由各文档当前目标音符的源码区间（targetRanges）驱动：点选 / 查阅命中后发生者胜，
   * 目标清除、内容变化或面板关闭时清除。
   */
  private readonly linkedNote = vscode.window.createTextEditorDecorationType({
    border: '1px dashed',
    borderColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  constructor(private readonly extensionUri: vscode.Uri) {
    // 可见编辑器变化时同步轮廓标记（SPEC-PLAY-11）：新可见的编辑器按当前目标区间重绘
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.syncLinkedDecorations()),
    );
  }

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
      this.createPanel(document, { kind: 'toggle' });
      return;
    }
    if (!entry.panel.visible) {
      // 隐藏时明确起播须先显示对应预览，不提供隐藏面板后台发声（SPEC-CMD-07）
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
   * "从光标播放"命令入口（SPEC-CMD-07 / 08 / PLAY-12）：按需创建或显示预览并保留源码焦点；
   * 起播前先推送待更新文档，保证按最新版本映射；无有效映射时由 webview 回原因说明。
   */
  requestPlayFromCursor(document: vscode.TextDocument, offset: number): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      this.createPanel(document, { kind: 'play-from-cursor', offset });
      return;
    }
    if (!entry.panel.visible) {
      entry.panel.reveal(undefined, true);
    }
    this.flushDocumentUpdate(entry);
    if (!entry.renderedOnce) {
      entry.pendingRequest = { kind: 'play-from-cursor', offset };
      return;
    }
    entry.pendingRequest = undefined;
    const message: PlayFromCursorMessage = { type: 'play-from-cursor', offset };
    void entry.panel.webview.postMessage(message);
  }

  /** "从所选音符播放"命令入口（SPEC-CMD-08 / PLAY-12）：取预览内的当前目标音符；预览不存在时说明先打开预览。 */
  requestPlayFromSelection(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open the preview first, then place the cursor on a note or select one on the score.'),
      );
      return;
    }
    this.flushDocumentUpdate(entry);
    void entry.panel.webview.postMessage({ type: 'play-from-selection' });
  }

  /**
   * "转到源码编辑"命令（SPEC-CMD-12）：打开来源文档并显式转移焦点；
   * 无有效音符映射时只打开文件、不套用旧偏移；来源标签已关闭时按 URI 重新打开。
   */
  async requestGoToSource(document: vscode.TextDocument): Promise<void> {
    if (document.isClosed) {
      // 防御：收到已关闭的文档对象时按 URI 走重新打开路径（SPEC-CMD-12）
      await this.requestGoToSourceByUri(document.uri.toString());
      return;
    }
    const entry = this.panels.get(document.uri.toString());
    const range = entry?.targetRanges[0];
    try {
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false,
      });
      if (range === undefined) {
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
   * 来源标签已关闭时的"转到源码编辑"（SPEC-CMD-12）：文件可读取时按 URI 重新打开并显式转移焦点，
   * 预览继续绑定该文件（SPEC-LIFE-05）——磁盘内容有变化时按常规换版规则推送（SPEC-STATE-07），
   * 未变化不推送以避免无谓换版归零、保留播放位置；文件被删除 / 无法读取时说明原因，不自动新建同路径文件。
   */
  async requestGoToSourceByUri(uriText: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriText));
      const entry = this.panels.get(uriText);
      if (entry !== undefined) {
        entry.document = document;
        if (entry.lastPushedAbc !== document.getText()) {
          // 标签关闭期间的磁盘变化：先停用旧联动，再按最新内容换版（SPEC-PLAY-11 / SPEC-STATE-07）
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

  /** 来源文档打开失败的统一说明（SPEC-CMD-12）：不静默失败，不自动新建同路径文件。 */
  private reportSourceUnavailable(error: unknown): void {
    console.error('ABC Desk: go to source failed', error);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The source document is unavailable.'),
    );
  }

  /** 停止命令入口（SPEC-CMD-10 / 11）：不新建预览；停音与取消起播不因音频未就绪失效。 */
  requestStop(document: vscode.TextDocument): void {
    const entry = this.panels.get(document.uri.toString());
    if (entry === undefined) {
      return;
    }
    entry.pendingRequest = undefined;
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

  /** 前台预览的绑定 URI（SPEC-CMD-04 / CMD-12）：绑定不因来源标签关闭而失效（SPEC-LIFE-05），供"转到源码编辑"按 URI 重新打开。 */
  activeBoundUri(): string | undefined {
    for (const entry of this.panels.values()) {
      if (entry.panel.active) {
        return entry.uri;
      }
    }
    return undefined;
  }

  /** 文档内容或保存状态变化时推送到对应预览（无对应预览时忽略）；连续变化防抖，只推送稳定后的最新版本。 */
  notifyDocumentChanged(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const entry = this.panels.get(uri);
    if (entry === undefined) {
      return;
    }
    // 从发现内容变化起立即停用源码联动（SPEC-PLAY-11）：清除播放高亮、丢弃旧映射定位依据
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

  /** 源码光标变化（SPEC-PLAY-11）：属于某预览的绑定文档时推送查阅标记位置；光标属于其他曲目时清除各预览的标记。 */
  notifySelectionChanged(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();
    const entry = this.panels.get(uri);
    if (entry !== undefined) {
      this.sendCursor(entry, editor.document.offsetAt(editor.selection.active));
      return;
    }
    // 不自动切曲、不套用当前曲目的映射（SPEC-PLAY-11）
    for (const other of this.panels.values()) {
      this.sendCursor(other, null);
    }
  }

  /** 推送查阅标记位置（SPEC-PLAY-11）：停用窗口内只记录、不应用，渲染完成后补发最新位置。 */
  private sendCursor(entry: PanelEntry, offset: number | null): void {
    entry.lastCursorOffset = offset ?? undefined;
    if (entry.suspend || !entry.renderedOnce) {
      return;
    }
    const message: CursorMessage = { type: 'cursor', offset };
    void entry.panel.webview.postMessage(message);
  }

  /** 立即推送待更新文档（若有）：起播命令前刷新，保证按最新版本映射（SPEC-PLAY-11 / 12）。 */
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

  private createPanel(document: vscode.TextDocument, request?: PendingRequest): void {
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
      lastPushedAbc: undefined,
      renderedOnce: false,
      pendingRequest: request,
      // 首次渲染完成前不应用联动（SPEC-PLAY-11）
      suspend: true,
      lastCursorOffset: undefined,
      pendingChange: undefined,
      targetRanges: [],
    };
    this.panels.set(entry.uri, entry);
    panel.webview.html = this.renderHtml(panel.webview);
    if (request !== undefined) {
      // 播放类命令按需打开预览时不抢源码焦点（SPEC-CMD-07）
      panel.reveal(undefined, true);
    }
    panel.onDidDispose(
      () => {
        // 防止迟到的 dispose 回调误删同文件的新面板
        if (this.panels.get(entry.uri) === entry) {
          this.panels.delete(entry.uri);
          // 面板关闭后轮廓标记一并清除（SPEC-PLAY-11）
          this.syncLinkedDecorations();
        }
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
        // 面板隐藏按暂停处理（SPEC-PLAY-02）；待起播请求随隐藏取消（SPEC-CMD-07）
        entry.pendingRequest = undefined;
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
        if (parsed.type === 'play-from-selection-request') {
          // 预览控制区"从此处播放"（SPEC-PLAY-12）：与命令共用路径（先刷新待更新文档再映射）
          this.requestPlayFromSelection(entry.document);
          return;
        }
        if (parsed.type === 'reveal-source') {
          this.revealSource(entry);
          return;
        }
        if (parsed.type === 'reveal-range') {
          if (entry.suspend) {
            // 停用窗口：忽略旧谱面→旧源码的定位（SPEC-PLAY-11）
            return;
          }
          this.revealRange(entry, parsed);
          return;
        }
        if (parsed.type === 'linkage-unavailable') {
          this.showLinkageUnavailable(parsed.reason);
          return;
        }
        if (parsed.type === 'source-highlight') {
          if (entry.suspend) {
            // 停用窗口：变化时已清除高亮，此处不再应用旧映射（SPEC-PLAY-11）
            return;
          }
          this.applySourceHighlight(entry, parsed.ranges);
          return;
        }
        if (parsed.type === 'target-ranges') {
          if (entry.suspend) {
            // 停用窗口：变化时已清除轮廓，此处不再应用旧映射（SPEC-PLAY-11）
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
   * 渲染结果：版本不符丢弃；解除联动停用并补发停用期间的最新光标；
   * 仍有效的待起播请求在首次渲染成功后执行（SPEC-CMD-07 / 09、PLAY-11）。
   */
  private handleRendered(entry: PanelEntry, message: WebviewRenderedMessage): void {
    if (message.version !== entry.version) {
      return;
    }
    entry.renderedOnce = true;
    // 新版本已在预览侧落地：解除联动停用（SPEC-PLAY-11）
    entry.suspend = false;
    if (entry.lastCursorOffset !== undefined) {
      const cursor: CursorMessage = { type: 'cursor', offset: entry.lastCursorOffset };
      void entry.panel.webview.postMessage(cursor);
    }
    const request = entry.pendingRequest;
    if (request === undefined) {
      return;
    }
    entry.pendingRequest = undefined;
    // 渲染失败时没有可起播的曲目，丢弃该请求；只执行仍有效且成功的请求（SPEC-CMD-07）
    if (!message.ok || !entry.panel.visible) {
      return;
    }
    if (request.kind === 'toggle') {
      this.postPlayback(entry, 'toggle');
      return;
    }
    const playFrom: PlayFromCursorMessage = { type: 'play-from-cursor', offset: request.offset };
    void entry.panel.webview.postMessage(playFrom);
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

  /**
   * 状态页"转到源码编辑"入口（SPEC-STATE-05 / CMD-12）：与命令共用打开路径
   * （含来源标签关闭后的按 URI 重新打开）；目标取面板绑定，不接受 webview 提供的路径。
   */
  private revealSource(entry: PanelEntry): void {
    void this.requestGoToSource(entry.document);
  }

  /**
   * 点击谱面音符的源码定位（SPEC-PLAY-11）：设置选区并滚动可见，焦点留在预览、不改变播放位置；
   * 源码不可见时显示但不抢焦点（轮廓标记由 webview 的目标区间回传驱动，不经过这里）。
   */
  private revealRange(entry: PanelEntry, message: WebviewRevealRangeMessage): void {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === entry.uri,
    );
    if (document === undefined) {
      return;
    }
    // active 端取音符起点：选区变化回传的光标偏移据此落在同一音符上（SPEC-PLAY-11）
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
      preserveFocus: true, // 点击谱面不转移焦点（SPEC-PLAY-11）
      selection,
    });
  }

  /** 联动不可用的原因说明（SPEC-PLAY-11 / 12）：不静默失败，不悄悄从头播放。 */
  private showLinkageUnavailable(reason: LinkageUnavailableReason): void {
    void vscode.window.showInformationMessage(linkageUnavailableText(reason));
  }

  /** 源码播放高亮（SPEC-PLAY-11）：只对可见编辑器设装饰，不滚动、不移动光标、不因播放打开已关闭的源码页。 */
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

  /** 清除源码播放高亮（SPEC-PLAY-11）：文档变化或换版时立即停用旧映射的显示。 */
  private clearSourceHighlight(entry: PanelEntry): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === entry.uri) {
        editor.setDecorations(this.sourceHighlight, []);
      }
    }
  }

  /**
   * 按各文档当前目标音符的源码区间同步轮廓标记（SPEC-PLAY-11）：只作用于可见编辑器，
   * 无区间（未命中 / 目标已清除 / 内容已变化 / 面板已关闭）时清除。
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
    entry.lastPushedAbc = message.abc;
    void entry.panel.webview.postMessage(message);
  }

  /** 生成 webview HTML：CSP 只放行 nonce 自有脚本与扩展资源，连接仅限扩展自有资源（SPEC-ENV-03）。 */
  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'));
    // codicon 图标字体经 asWebviewUri 交给 webview（构建拷贝到 out/codicons/，SPEC-ENV-05）：图标按钮字形与旋转动画
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'codicons', 'codicon.css'),
    );
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
  <link rel="stylesheet" href="${codiconUri}">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      margin: 0;
      /* 预览无全局横滚需求：谱面按容器宽缩放、键盘内部横滚；兼作旧宽渲染溢出的防线 */
      overflow-x: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    /* 顶栏（SPEC-PLAY-13）：播放控件粘在预览顶部，长谱滚动时保持可见可点；键盘贴底、谱面在两者之间滚动。
       文件名与“尚未保存”标记不在此重复：预览标签标题已含（SPEC-CMD-06） */
    #topbar {
      flex: 0 0 auto;
      position: sticky;
      top: 0;
      z-index: 3;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    /* 控制区（SPEC-PLAY-13）：列间距走分组 margin-right（图标节奏需要精确值），仅保留行距 8px */
    #controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      row-gap: 8px;
      padding: 6px 12px;
    }
    /* 稳定分组（SPEC-PLAY-13）：组内不换行、仅组间断行；默认组间距 12px（循环实现后与播放 / 停止同组） */
    .abcdesk-control-group { display: inline-flex; align-items: center; gap: 8px; }
    .abcdesk-control-group:not(:last-child) { margin-right: 12px; }
    /* 图标节奏（SPEC-PLAY-13）：% ⟳ ▶ ⏹ 墨迹间距统一 18px——速度组 → 传输组 1.4px、播放 ↔ 停止 2.2px；
       数值由无头 Chrome 4 倍放大像素实测校准（% ⟳ ▶ ⏹ 三项均 18.0px），改动前先复测 */
    #speed-group { margin-right: 1.4px; }
    #transport-group { gap: 2.2px; }
    /* 谱面区：flex 拉伸把键盘 dock 顶到视口底边（短文档也贴底）；滚动仍走整页 */
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
    /* "从此处播放"（SPEC-PLAY-12）：禁用原因由包裹元素承载（禁用按钮自身不触发悬停提示） */
    #play-from-here-wrap { display: inline-flex; }
    #controls button:disabled {
      opacity: 0.5;
      cursor: default;
      background: var(--vscode-button-background);
    }
    /* 图标按钮（SPEC-PLAY-01 / 13、A11Y-06）：字形 14px；hover 可视面 20×20、可视圆角 4px，内距 3px 与 VS Code 工具栏（22px 盒 / 16px 字形）同口径——4 倍放大像素实测右隙 4.75 vs 原生 5.00；
       hover 底色必须用 background-color：background 简写会把 background-clip 重置回 border-box、灰底涨到 26×26 命中区（曾致多轮“偏大”反馈）；
       3px 透明边框 + padding-box 裁剪把命中区保持 26×26；语义由 title 与可访问名称承载 */
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
    #controls button.codicon:disabled { background-color: transparent; }
    /* "恢复跟随"浮动入口（SPEC-PLAY-11）：固定定位，底边避开键盘 dock（高度经 CSS 变量同步） */
    #follow-resume {
      position: fixed;
      right: 16px;
      bottom: calc(var(--abcdesk-dock-height, 0px) + 16px);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    }
    #follow-resume[hidden] { display: none; }
    /* 状态行（SPEC-PLAY-13）：关键状态位于控制区下方、独占一行；无文案时不占位 */
    #playback-status {
      display: block;
      padding: 0 12px 6px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    #playback-status[hidden] { display: none; }
    /* 速度控件（SPEC-PLAY-04）：数字输入 + 恢复原速；带拍提示仅在可可靠换算时显示 */
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
    /* 恢复原速为弱化图标：不抢播放 / 停止的视觉位置（禁用底色由通用 .codicon:disabled 规则处理）；
       margin-left 参与 “% ⟳ ▶ ⏹” 等距节奏：组内 gap 4px + 5.15px = 18px 墨迹间距（实测校准） */
    #controls #speed-reset { margin-left: 5.15px; color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
    /* 进度条独占一行（SPEC-PLAY-05）：细轨 + 圆点滑块，整行高度保证易点中 */
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
    /* 拖动中（SPEC-PLAY-05）：轨道与滑块加粗、光标抓取，提供拖动生效的即时反馈 */
    #progress.abcdesk-dragging { cursor: grabbing; }
    #progress.abcdesk-dragging #progress-fill { height: 6px; }
    #progress.abcdesk-dragging #progress-thumb { transform: translate(-50%, -50%) scale(1.4); }
    #progress:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; border-radius: 2px; }
    #progress-time {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    /* 声部菜单（SPEC-PLAY-06）：原生 details/summary，面板定位于触发钮下方、不挤压控件行 */
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
    /* 播放中提示“暂停后可调整声部”（SPEC-PLAY-06）：点击即暂停，之后才能改声部 */
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
    .abcdesk-voice-row { padding: 3px 4px; white-space: nowrap; }
    .abcdesk-voice-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    /* 内容状态区（SPEC-STATE-08）：旧谱参考 / 空状态 / 待更新提示，位于控制区下方 */
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
    /* 谱面按纸张外观呈现（SPEC-A11Y-09）：固定前景色，避免 abcjs 的 currentColor 在暗色主题下继承浅色谱线；
       box-sizing 必须 border-box：abcjs responsive 会往容器写内联 width:100%，content-box 下再加 padding 就溢出撑宽 */
    #score { padding: 12px; background: #ffffff; color: #000000; min-height: 120px; position: relative; box-sizing: border-box; }
    /*
     * 谱面宽度始终跟住容器（覆盖 abcjs 内联 width/height）：viewBox 按比例缩放，
     * 容器变窄（渲染后出现滚动条 / 面板变化）不再溢出撑出全局横滚，dock 与谱面同宽。
     */
    #score > svg { display: block; width: 100% !important; height: auto !important; }
    /*
     * 谱面联动标记（SPEC-PLAY-11）：形状与颜色双重区分——
     * 当前目标音符（点选 / 查阅共用）为填充 + 音符包围虚线框（覆盖层，不进入 SVG、不阻断点击命中），播放高亮为音符填充换色；两类标记可共存。
     * CSS 类规则优先于 abcjs 写入的 presentation 属性；但原生点选改写的属性不随类移除复原，
     * 清除标记时由 webview 按渲染快照还原（见 main.ts 的 snapshotNativePaint / clearTargetMarks）。
     */
    #score .abcdesk-reading-box {
      position: absolute;
      box-sizing: border-box;
      border: 1.5px dashed #1a73e8;
      border-radius: 3px;
      pointer-events: none;
    }
    /* 目标填充（SPEC-PLAY-11 / 12）：点选与查阅共用的当前目标；abcjs 原生选中类同色兜底、避免闪现原生亮红；播放高亮规则保持在后（同优先级时后写生效） */
    #score .abcjs-note_selected,
    #score .abcdesk-target { fill: #8ab4f8; }
    #score .abcdesk-playing { fill: #d84315; }
    /*
     * 键盘可视化（SPEC-PLAY-08 / 09）：独立 dock 粘在预览底部，形态就是一架键盘——
     * 无盒子边框与多余按钮，dock 条只留说明 / 状态与弱化的音域 / 收起控件；
     * 窄窗口横向滚动而非压缩键宽。
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
    /* dock 条：说明与状态居左，控件居右；字号比正文小一级，不与键盘争视觉重心 */
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
    /* 收起 / 展开为弱化按钮：透明底、悬停才浮现，保持 dock 条安静 */
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
    /* 键盘滚动区可用键盘访问，但不把 88 个琴键加入 Tab 顺序（SPEC-A11Y-13） */
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
    /* 各 C 的八度标签（SPEC-PLAY-08）：白键右下角，中央 C 即为 C4 */
    .abcdesk-key-white[data-note^='C']::after {
      content: attr(data-note);
      position: absolute;
      right: 2px;
      bottom: 3px;
      font-size: 8px;
      line-height: 1;
      color: #5a5a5a;
    }
    /* 查阅 / 点选反射（SPEC-PLAY-15）：与查阅虚线框同色系；播放高亮规则保持在后（同键同时命中时播放色优先） */
    .abcdesk-key-pointed { background: #1a73e8; }
    .abcdesk-key-pointed::after { color: #ffffff; }
    /* 播放高亮（SPEC-PLAY-09）：与谱面高亮同色；亮键不代表真实按键或必发声 */
    .abcdesk-key-active { background: #d84315; }
    .abcdesk-key-active::after { color: #ffffff; }
    /* 方向提示（SPEC-PLAY-08）：视口外有提示音时显示，只提示方向、不拉回滚动位置 */
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
    /* 焦点可见性统一（SPEC-A11Y-07）：按钮 / 菜单触发 / 下拉 / 声部复选一律显示主题焦点环 */
    button:focus-visible, summary:focus-visible, select:focus-visible, .abcdesk-voice-row input:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    /* 低高度例外（D0）：不把谱面夹在上下固定区域之间，键盘回文档流随内容整体滚动；阈值为暂订实测项 */
    @media (max-height: 400px) {
      #keyboard { position: static; }
      /* 低高度顶栏压缩（SPEC-PLAY-13）：至少保留播放 / 暂停与停止及关键状态摘要 */
      #controls { padding: 4px 12px; }
      #progress-row { padding: 0 12px 4px; }
      #playback-status { padding: 0 12px 4px; }
    }
  </style>
</head>
<body>
  <div id="topbar">
    <div id="controls">
      <!-- 速度组（SPEC-PLAY-13）：置于最左——先调速、再播放的练习流 -->
      <span class="abcdesk-control-group" id="speed-group">
        <span id="speed-control">
          <label id="speed-label" for="speed-input"></label>
          <input id="speed-input" type="number" min="25" max="200" step="5" inputmode="numeric">
          <span aria-hidden="true">%</span>
          <button id="speed-reset" type="button" class="codicon codicon-refresh"></button>
          <span id="speed-hint" hidden></span>
        </span>
      </span>
      <!-- 播放/停止单独成组：极窄面板换行时整组下移，不被速度组连累隐藏 -->
      <span class="abcdesk-control-group" id="transport-group">
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
      <button id="reveal-source" type="button" hidden></button>
    </div>
    <div id="score"></div>
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
    this.sourceHighlight.dispose();
    this.linkedNote.dispose();
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

/** 联动不可用原因的用户可见文案（SPEC-PLAY-11 / 12）。 */
function linkageUnavailableText(reason: LinkageUnavailableReason): string {
  switch (reason) {
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
