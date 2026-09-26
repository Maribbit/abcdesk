import { renderAbc, type TuneObject } from 'abcjs';
import { parseHostMessage, type DocumentMessage } from '../core/messages';
import { PlaybackController } from './audio';
import { t } from './l10n';

/**
 * 播放器 webview 入口（M0：渲染管线、播放主干与编辑更新管线）。
 *
 * 全部宿主通信必须经消息桥，不得 import vscode（见 docs/conventions.md）；
 * 消息形状不完整时忽略，不信任宿主以外的来源（SPEC-ENV-04）。
 * 内容更新策略（SPEC-STATE-03 / 05 / 07 / 08）：
 * - 播放中到达的新版本只缓存并提示"文件已更新，暂停后应用"，不提前换版；
 * - 暂停 / 停止 / 自然结束 / 隐藏或接替触发暂停时统一应用缓存版本（归零、不自动起播）；
 * - 渲染失败保留旧谱并标记仅供参考、禁用旧谱播放；无旧谱时显示错误占位；
 * - 空白内容显示空状态与"转到源码编辑"入口，不把旧谱当成当前内容。
 * 键盘可视化、源码联动与播放控件扩展由后续批次接入（见 docs/spec/play.md）。
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const host = acquireVsCodeApi();

function queryElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`ABC Desk webview: missing element #${id}`);
  }
  return element as T;
}

const statusElement = queryElement('status');
const scoreElement = queryElement('score');
const playButton = queryElement<HTMLButtonElement>('play');
const stopButton = queryElement<HTMLButtonElement>('stop');
const playbackStatusElement = queryElement('playback-status');
const contentStatusElement = queryElement('content-status');
const contentStatusTextElement = queryElement('content-status-text');
const revealSourceButton = queryElement<HTMLButtonElement>('reveal-source');

/** 播放中到达、待统一应用的最新文档（SPEC-STATE-07）。 */
let pendingDocument: DocumentMessage | undefined;
/** 内容状态区的文案键：暂停后应用 / 旧谱参考 / 空状态。 */
let contentStatusKey: string | null = null;
/** 空状态是否显示"转到源码编辑"入口（SPEC-STATE-05）。 */
let showRevealSource = false;
/** 谱面区是否已有成功渲染的谱面：渲染失败时据此决定保留参考还是错误占位（SPEC-STATE-03）。 */
let hasRenderedScore = false;

// 宿主注入的配置（previewPanel 以 nonce 脚本写入）：本地音色根地址（SPEC-ENV-05 / 07）
const webviewConfig = (window as unknown as { __abcdesk?: { soundfontUrl?: unknown } }).__abcdesk;
const soundfontUrl = typeof webviewConfig?.soundfontUrl === 'string' ? webviewConfig.soundfontUrl : undefined;

const controller = new PlaybackController({ soundfontUrl }, refreshPlaybackUi);

/** 按当前相位刷新按钮标签、状态文案并上报播放状态（SPEC-PLAY-01 / 13）。 */
function refreshPlaybackUi(): void {
  if (pendingDocument !== undefined) {
    const { phase } = controller.getStatus();
    if (phase === 'idle' || phase === 'paused') {
      // 暂停 / 停止 / 自然结束 / 隐藏或接替触发暂停：统一应用更新并归零（SPEC-STATE-07）
      applyPendingDocument();
    }
  }
  const { phase, statusKey } = controller.getStatus();
  const labelKey = phase === 'preparing' ? 'cancel-prepare' : phase === 'playing' ? 'pause' : 'play';
  const label = t(labelKey);
  playButton.textContent = label;
  playButton.setAttribute('aria-label', label); // 可访问名称与按钮文案同步（SPEC-PLAY-01）
  stopButton.textContent = t('stop');
  stopButton.setAttribute('aria-label', t('stop'));
  playbackStatusElement.textContent = statusKey === null ? '' : t(statusKey);
  // 宿主据此维持同一窗口内只有一处预览发声（SPEC-PLAY-01）
  host.postMessage({ type: 'playback-state', state: phase });
}

/** 应用缓存的最新版本：渲染与换版归零（SPEC-STATE-07），不自动起播。 */
function applyPendingDocument(): void {
  const message = pendingDocument;
  if (message === undefined) {
    return;
  }
  pendingDocument = undefined;
  renderDocument(message);
}

/** 内容状态区（SPEC-STATE-08）：旧谱参考 / 空状态 / 暂停后应用提示与"转到源码编辑"入口。 */
function updateContentStatus(): void {
  contentStatusElement.hidden = contentStatusKey === null && !showRevealSource;
  contentStatusTextElement.textContent = contentStatusKey === null ? '' : t(contentStatusKey);
  revealSourceButton.hidden = !showRevealSource;
  if (showRevealSource) {
    revealSourceButton.textContent = t('reveal-source');
    revealSourceButton.setAttribute('aria-label', t('reveal-source'));
  }
}

/** 空状态：清空谱面、提示"文件尚无音乐内容"并提供"转到源码编辑"入口（SPEC-STATE-05）。 */
function showEmptyState(): void {
  scoreElement.textContent = '';
  hasRenderedScore = false;
  contentStatusKey = 'empty-file';
  showRevealSource = true;
  controller.setTune(undefined);
  updateContentStatus();
}

/** 渲染宿主推送的文档；返回渲染是否成功（SPEC-CMD-07 的待起播请求据此执行）。 */
function renderDocument(message: DocumentMessage): boolean {
  // 状态行：文件名 + 仅新文档的尚未保存标记（SPEC-CMD-06）
  statusElement.textContent = message.isUntitled
    ? `${message.fileName} · ${t('unsaved')}`
    : message.fileName;

  if (message.abc.trim() === '') {
    // 完全空白：直接进入空状态，不交给渲染器（SPEC-STATE-05）
    showEmptyState();
    return true;
  }

  // 先留旧谱节点引用：渲染可能中途失败，失败时恢复，保证保留上一次成功渲染的谱面（SPEC-STATE-03）
  const previousNodes = Array.from(scoreElement.childNodes);
  let tune: TuneObject | undefined;
  try {
    tune = renderAbc(scoreElement, message.abc, { responsive: 'resize', add_classes: true })[0];
  } catch (error) {
    console.error('ABC Desk: render failed', error);
    if (hasRenderedScore) {
      // 保留旧谱并标记"仅供参考"（SPEC-STATE-03）
      scoreElement.replaceChildren(...previousNodes);
      contentStatusKey = 'stale-score';
    } else {
      // 首次失败且无旧谱：错误占位（SPEC-STATE-03）
      scoreElement.textContent = '';
      const fallback = document.createElement('p');
      fallback.textContent = t('render-failed');
      scoreElement.appendChild(fallback);
      contentStatusKey = null;
    }
    showRevealSource = false;
    controller.setTune(undefined); // 禁用旧谱播放，避免播放已失效版本（SPEC-STATE-03）
    updateContentStatus();
    return false;
  }

  if (tune === undefined || !tuneHasNotes(tune)) {
    // 空白内容：空状态与转到源码编辑入口，不把旧谱当成当前内容（SPEC-STATE-05）
    showEmptyState();
    return true;
  }

  hasRenderedScore = true;
  contentStatusKey = null;
  showRevealSource = false;
  controller.setTune(tune);
  updateContentStatus();
  return true;
}

/** 谱面是否含可显示的音符（空状态判据，SPEC-STATE-05）：休止符（rest）也是 note 条目，全休止符不算空文件。 */
function tuneHasNotes(tune: TuneObject): boolean {
  for (const line of tune.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const item of voice) {
          if (item.el_type === 'note') {
            return true;
          }
        }
      }
    }
  }
  return false;
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = parseHostMessage(event.data);
  if (message === undefined) {
    return;
  }
  if (message.type === 'document') {
    // 播放中到达的新版本：缓存并提示，暂停 / 停止 / 自然结束时统一应用（SPEC-STATE-07）
    if (controller.getStatus().phase === 'playing') {
      pendingDocument = message;
      contentStatusKey = 'update-pending';
      showRevealSource = false;
      updateContentStatus();
      return; // 不渲染也不上报：换版在应用时机执行
    }
    const ok = renderDocument(message);
    host.postMessage({ type: 'rendered', version: message.version, ok });
    return;
  }
  switch (message.action) {
    case 'toggle':
      controller.toggle();
      break;
    case 'pause':
      controller.pause();
      break;
    case 'stop':
      controller.stop();
      break;
  }
});

playButton.addEventListener('click', () => controller.toggle());
stopButton.addEventListener('click', () => controller.stop());
// 空状态"转到源码编辑"入口（SPEC-STATE-05）：请求宿主打开来源文档并转移焦点
revealSourceButton.addEventListener('click', () => host.postMessage({ type: 'reveal-source' }));

// 预览局部空格与按钮、命令共用操作规则（SPEC-CMD-11）；按钮等交互元素上的空格保留原生行为
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== ' ' || event.defaultPrevented) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target !== null && (target.closest('button, input, textarea, select, a') !== null || target.isContentEditable)) {
    return;
  }
  event.preventDefault();
  controller.toggle();
});

// 面板销毁前立即停音（保留上下文时隐藏不会触发此处）
window.addEventListener('pagehide', () => controller.dispose());

refreshPlaybackUi();
updateContentStatus();
// 就绪握手：宿主收到 ready 后推送当前文档内容
host.postMessage({ type: 'ready' });
