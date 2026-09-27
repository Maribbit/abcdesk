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

/** 请求宿主打开来源文档并转移焦点（空状态入口，SPEC-STATE-05；目标由宿主按面板绑定决定，不接受任意路径）。 */
export interface WebviewRevealSourceMessage {
  type: 'reveal-source';
}

/** 点击谱面音符后的源码定位请求（SPEC-PLAY-11）：start / end 为字符偏移（左闭右开，abcjs 约定）。 */
export interface WebviewRevealRangeMessage {
  type: 'reveal-range';
  start: number;
  end: number;
}

/** 联动无法执行的原因（SPEC-PLAY-11 / 12）：宿主据此说明，不静默失败。 */
export type LinkageUnavailableReason =
  | 'no-mapping'
  | 'no-selection'
  | 'update-pending'
  | 'stale-score';

/** 联动无法执行时的说明请求（SPEC-PLAY-11 / 12）。 */
export interface WebviewLinkageUnavailableMessage {
  type: 'linkage-unavailable';
  reason: LinkageUnavailableReason;
}

/** 源码区间（字符偏移，左闭右开）：播放高亮回传与目标轮廓回传共用。 */
export interface SourceHighlightRange {
  start: number;
  end: number;
}

/** 播放高亮回传（SPEC-PLAY-11）：宿主对可见源码编辑器设装饰，不滚动、不移动光标；空数组表示清除。 */
export interface WebviewSourceHighlightMessage {
  type: 'source-highlight';
  ranges: SourceHighlightRange[];
}

/** 当前目标音符的源码区间回传（SPEC-PLAY-11）：宿主据此同步编辑器侧轮廓标记，不滚动、不移动光标；空数组表示清除。 */
export interface WebviewTargetRangesMessage {
  type: 'target-ranges';
  ranges: SourceHighlightRange[];
}

/**
 * 预览控制区"从此处播放"按钮的起播请求（SPEC-PLAY-12）：与命令共用宿主路径
 * （先刷新待更新文档、按面板绑定文档执行）；位置由预览内选择决定，无载荷。
 */
export interface WebviewPlayFromSelectionRequestMessage {
  type: 'play-from-selection-request';
}

export type WebviewMessage =
  | WebviewReadyMessage
  | WebviewRenderedMessage
  | WebviewPlaybackStateMessage
  | WebviewRevealSourceMessage
  | WebviewRevealRangeMessage
  | WebviewLinkageUnavailableMessage
  | WebviewSourceHighlightMessage
  | WebviewTargetRangesMessage
  | WebviewPlayFromSelectionRequestMessage;

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
  if (message.type === 'reveal-source') {
    return { type: 'reveal-source' };
  }
  if (
    message.type === 'reveal-range' &&
    isCharOffset(message.start) &&
    isCharOffset(message.end)
  ) {
    return { type: 'reveal-range', start: message.start, end: message.end };
  }
  if (message.type === 'linkage-unavailable' && isLinkageReason(message.reason)) {
    return { type: 'linkage-unavailable', reason: message.reason };
  }
  if (message.type === 'source-highlight' && isCharRanges(message.ranges)) {
    // 逐项重构建：按类型校验的同时丢弃额外字段（SPEC-ENV-04）
    return {
      type: 'source-highlight',
      ranges: message.ranges.map((range) => ({ start: range.start, end: range.end })),
    };
  }
  if (message.type === 'target-ranges' && isCharRanges(message.ranges)) {
    // 逐项重构建：按类型校验的同时丢弃额外字段（SPEC-ENV-04）
    return {
      type: 'target-ranges',
      ranges: message.ranges.map((range) => ({ start: range.start, end: range.end })),
    };
  }
  if (message.type === 'play-from-selection-request') {
    return { type: 'play-from-selection-request' };
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

export type HostMessage =
  | DocumentMessage
  | PlaybackMessage
  | CursorMessage
  | PlayFromCursorMessage
  | PlayFromSelectionMessage;

/**
 * 源码光标位置推送（SPEC-PLAY-11）：webview 据此更新谱面查阅标记，不触发播放；
 * null 表示光标不在当前曲目或不可用，清除标记。
 */
export interface CursorMessage {
  type: 'cursor';
  offset: number | null;
}

/** 从源码光标起播（SPEC-PLAY-12）：按映射定位起播；无有效映射时由 webview 回原因说明。 */
export interface PlayFromCursorMessage {
  type: 'play-from-cursor';
  offset: number;
}

/** 从预览当前目标音符起播（SPEC-PLAY-12）：无目标或映射失效时由 webview 回原因说明。 */
export interface PlayFromSelectionMessage {
  type: 'play-from-selection';
}

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
  if (message.type === 'cursor' && (message.offset === null || isCharOffset(message.offset))) {
    return { type: 'cursor', offset: message.offset };
  }
  if (message.type === 'play-from-cursor' && isCharOffset(message.offset)) {
    return { type: 'play-from-cursor', offset: message.offset };
  }
  if (message.type === 'play-from-selection') {
    return { type: 'play-from-selection' };
  }
  return undefined;
}

/** 文档版本：非负整数（SPEC-ENV-04 的数值范围校验）。 */
function isDocumentVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 字符偏移：非负整数（源文档 offset 与 abcjs startChar / endChar 的口径）。 */
function isCharOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 区间数组上限：一次播放高亮 / 目标轮廓涉及的音符数远超实际需要时视为异常消息。 */
const CHAR_RANGES_MAX = 16;

function isLinkageReason(value: unknown): value is LinkageUnavailableReason {
  return (
    value === 'no-mapping' ||
    value === 'no-selection' ||
    value === 'update-pending' ||
    value === 'stale-score'
  );
}

function isCharRanges(value: unknown): value is SourceHighlightRange[] {
  if (!Array.isArray(value) || value.length > CHAR_RANGES_MAX) {
    return false;
  }
  return value.every(
    (item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      isCharOffset((item as Record<string, unknown>).start) &&
      isCharOffset((item as Record<string, unknown>).end),
  );
}

function isPlaybackState(value: unknown): value is WebviewPlaybackStateMessage['state'] {
  return value === 'idle' || value === 'preparing' || value === 'playing' || value === 'paused';
}

function isPlaybackAction(value: unknown): value is PlaybackMessage['action'] {
  return value === 'toggle' || value === 'pause' || value === 'stop';
}
