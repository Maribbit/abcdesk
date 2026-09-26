/**
 * 消息桥消息形状校验（SPEC-ENV-04）。
 *
 * 纯逻辑模块，双向校验：宿主侧不信任 webview 消息（parseWebviewMessage），
 * webview 侧同样只接受已登记的宿主消息形状（parseHostMessage）；
 * 未知类型、缺类型或非对象一律拒绝，额外字段全部丢弃。
 * 数值范围在此校验；"当前文档版本"的比对由持有版本的调用方完成。
 */

/** webview 就绪握手；宿主收到后推送当前文档内容。 */
export interface WebviewReadyMessage {
  type: 'ready';
}

/** 渲染结果：version 为该次渲染对应的文档版本（SPEC-CMD-07 据此执行仍有效的待起播请求）。 */
export interface WebviewRenderedMessage {
  type: 'rendered';
  version: number;
  ok: boolean;
}

/** 播放状态变更：宿主据此维持同一窗口内只有一处预览发声（SPEC-PLAY-01）。 */
export interface WebviewPlaybackStateMessage {
  type: 'playback-state';
  state: 'idle' | 'preparing' | 'playing' | 'paused';
}

export type WebviewMessage =
  | WebviewReadyMessage
  | WebviewRenderedMessage
  | WebviewPlaybackStateMessage;

/** 解析 webview 消息：只接受形状完整的已登记类型，丢弃额外字段。 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') {
    return { type: 'ready' };
  }
  if (
    message.type === 'rendered' &&
    isDocumentVersion(message.version) &&
    typeof message.ok === 'boolean'
  ) {
    return { type: 'rendered', version: message.version, ok: message.ok };
  }
  if (message.type === 'playback-state' && isPlaybackState(message.state)) {
    return { type: 'playback-state', state: message.state };
  }
  return undefined;
}

/** 宿主推送的文档内容（经就绪握手与文档变化事件触发，SPEC-CMD-06）。 */
export interface DocumentMessage {
  type: 'document';
  uri: string;
  fileName: string;
  abc: string;
  isUntitled: boolean;
  version: number;
}

/**
 * 宿主发出的播放操作：toggle（播放 / 暂停 / 准备中取消起播）、
 * pause（隐藏或预览接替触发的暂停）、stop（停音并归零）。
 */
export interface PlaybackMessage {
  type: 'playback';
  action: 'toggle' | 'pause' | 'stop';
}

export type HostMessage = DocumentMessage | PlaybackMessage;

/** 解析宿主消息：webview 侧同样只接受已登记形状，防御消息桥之外的注入来源。 */
export function parseHostMessage(value: unknown): HostMessage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (
    message.type === 'document' &&
    typeof message.uri === 'string' &&
    typeof message.fileName === 'string' &&
    typeof message.abc === 'string' &&
    typeof message.isUntitled === 'boolean' &&
    isDocumentVersion(message.version)
  ) {
    return {
      type: 'document',
      uri: message.uri,
      fileName: message.fileName,
      abc: message.abc,
      isUntitled: message.isUntitled,
      version: message.version,
    };
  }
  if (message.type === 'playback' && isPlaybackAction(message.action)) {
    return { type: 'playback', action: message.action };
  }
  return undefined;
}

/** 文档版本：非负整数（SPEC-ENV-04 的数值范围校验）。 */
function isDocumentVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPlaybackState(value: unknown): value is WebviewPlaybackStateMessage['state'] {
  return value === 'idle' || value === 'preparing' || value === 'playing' || value === 'paused';
}

function isPlaybackAction(value: unknown): value is PlaybackMessage['action'] {
  return value === 'toggle' || value === 'pause' || value === 'stop';
}
