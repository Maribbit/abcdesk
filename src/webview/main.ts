import { renderAbc, type TuneObject } from 'abcjs';
import { parseHostMessage, type DocumentMessage } from '../core/messages';
import { PlaybackController } from './audio';
import { t } from './l10n';

/**
 * 播放器 webview 入口（M0：渲染管线 + 播放主干）。
 *
 * 全部宿主通信必须经消息桥，不得 import vscode（见 docs/conventions.md）；
 * 消息形状不完整时忽略，不信任宿主以外的来源（SPEC-ENV-04）。
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

// 宿主注入的配置（previewPanel 以 nonce 脚本写入）：本地音色根地址（SPEC-ENV-05 / 07）
const webviewConfig = (window as unknown as { __abcdesk?: { soundfontUrl?: unknown } }).__abcdesk;
const soundfontUrl = typeof webviewConfig?.soundfontUrl === 'string' ? webviewConfig.soundfontUrl : undefined;

const controller = new PlaybackController({ soundfontUrl }, refreshPlaybackUi);

/** 按当前相位刷新按钮标签、状态文案并上报播放状态（SPEC-PLAY-01 / 13）。 */
function refreshPlaybackUi(): void {
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

/** 渲染宿主推送的文档；返回渲染是否成功（SPEC-CMD-07 的待起播请求据此执行）。 */
function renderDocument(message: DocumentMessage): boolean {
  // 状态行：文件名 + 仅新文档的尚未保存标记（SPEC-CMD-06）
  statusElement.textContent = message.isUntitled
    ? `${message.fileName} · ${t('unsaved')}`
    : message.fileName;

  try {
    const tunes = renderAbc(scoreElement, message.abc, { responsive: 'resize', add_classes: true });
    const tune: TuneObject | undefined = tunes[0];
    controller.setTune(tune);
    return true;
  } catch (error) {
    scoreElement.textContent = '';
    const fallback = document.createElement('p');
    fallback.textContent = t('render-failed');
    scoreElement.appendChild(fallback);
    console.error('ABC Desk: render failed', error);
    // 渲染失败不打断正在播放的旧快照（SPEC-STATE-03）；否则清掉旧曲目，避免播放已失效版本
    if (controller.getStatus().phase !== 'playing') {
      controller.setTune(undefined);
    }
    return false;
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = parseHostMessage(event.data);
  if (message === undefined) {
    return;
  }
  if (message.type === 'document') {
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
// 就绪握手：宿主收到 ready 后推送当前文档内容
host.postMessage({ type: 'ready' });
