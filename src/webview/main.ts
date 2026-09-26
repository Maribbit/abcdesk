import { renderAbc } from 'abcjs';
import { t } from './l10n';

/**
 * 播放器 webview 入口（M0 第一批：渲染管线）。
 *
 * 全部宿主通信必须经消息桥，不得 import vscode（见 docs/conventions.md）；
 * 消息形状不完整时忽略，不信任宿主以外的来源。
 * 播放、键盘与联动由后续批次接入（见 docs/spec/play.md）。
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface DocumentMessage {
  type: 'document';
  uri: string;
  fileName: string;
  abc: string;
  isUntitled: boolean;
  version: number;
}

const host = acquireVsCodeApi();

function queryElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`ABC Desk webview: missing element #${id}`);
  }
  return element;
}

const statusElement = queryElement('status');
const scoreElement = queryElement('score');

function isDocumentMessage(value: unknown): value is DocumentMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    message.type === 'document' &&
    typeof message.uri === 'string' &&
    typeof message.fileName === 'string' &&
    typeof message.abc === 'string' &&
    typeof message.isUntitled === 'boolean' &&
    typeof message.version === 'number'
  );
}

function renderDocument(message: DocumentMessage): void {
  // 状态行：文件名 + 仅新文档的尚未保存标记（SPEC-CMD-06）
  statusElement.textContent = message.isUntitled
    ? `${message.fileName} · ${t('unsaved')}`
    : message.fileName;

  try {
    renderAbc(scoreElement, message.abc, { responsive: 'resize', add_classes: true });
  } catch (error) {
    scoreElement.textContent = '';
    const fallback = document.createElement('p');
    fallback.textContent = t('render-failed');
    scoreElement.appendChild(fallback);
    console.error('ABC Desk: render failed', error);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message: unknown = event.data;
  if (!isDocumentMessage(message)) {
    return;
  }
  renderDocument(message);
});

// 就绪握手：宿主收到 ready 后推送当前文档内容
host.postMessage({ type: 'ready' });
