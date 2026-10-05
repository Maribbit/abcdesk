/** SPEC-ENV-04 / STATE-02：双向白名单与上下文校验，不接受文件操作路径。 */
export interface PreviewContext {
  viewId: number;
  revision: number;
  version: number;
  selection: number;
}
export interface SourceHighlightRange { start: number; end: number }
export type LinkageUnavailableReason = 'no-mapping' | 'no-selection' | 'update-pending' | 'stale-score' | 'choose-tune' | 'structure-unreliable';
export interface WebviewReadyMessage { type: 'ready' }
export interface WebviewRenderedMessage { type: 'rendered'; context: PreviewContext; ok: boolean; linkable: boolean }
export interface WebviewPlaybackStateMessage { type: 'playback-state'; context: PreviewContext; state: 'idle' | 'preparing' | 'playing' | 'paused' }
export interface WebviewRevealSourceMessage { type: 'reveal-source'; viewId: number }
/** 迁移状态页"打开目标预览"入口（SPEC-LIFE-04）：只带实例编号，目标路径由宿主内部记录决定。 */
export interface WebviewRevealTargetMessage { type: 'reveal-target'; viewId: number }
export interface WebviewRevealRangeMessage { type: 'reveal-range'; context: PreviewContext; requestId: number; start: number; end: number }
export interface WebviewLinkageUnavailableMessage { type: 'linkage-unavailable'; context: PreviewContext; reason: LinkageUnavailableReason }
export interface WebviewSourceHighlightMessage { type: 'source-highlight'; context: PreviewContext; ranges: SourceHighlightRange[] }
export interface WebviewTargetRangesMessage { type: 'target-ranges'; context: PreviewContext; ranges: SourceHighlightRange[] }
export interface WebviewPlayFromSelectionRequestMessage { type: 'play-from-selection-request'; context: PreviewContext; requestId: number }
export interface WebviewContextInvalidatedMessage { type: 'context-invalidated'; context: PreviewContext; cancelRequests?: boolean }
export interface WebviewSelectTuneMessage { type: 'select-tune'; context: PreviewContext; requestId: number }
export type WebviewMessage = WebviewReadyMessage | WebviewRenderedMessage | WebviewPlaybackStateMessage |
  WebviewRevealSourceMessage | WebviewRevealTargetMessage | WebviewRevealRangeMessage | WebviewLinkageUnavailableMessage |
  WebviewSourceHighlightMessage | WebviewTargetRangesMessage | WebviewPlayFromSelectionRequestMessage |
  WebviewContextInvalidatedMessage | WebviewSelectTuneMessage;

export interface DocumentMessage {
  type: 'document';
  uri: string;
  fileName: string;
  abc: string;
  isUntitled: boolean;
  version: number;
  viewId: number;
  revision: number;
  /** 可靠迁移（SPEC-LIFE-03）：uri 已变化但属于同一练习，保留会话设置、选曲身份与暂停位置。 */
  continued?: boolean;
  /** 首次源码意图优先于默认第一首；编号属于宿主操作序列。 */
  initialRequest?: { requestId: number; offset: number };
}
/** 来源状态页（SPEC-LIFE-04 / 06 / 07）：迁移 / 不可用 / 磁盘缺失提示与恢复清除，不带文件操作路径。 */
export interface SourceStateMessage {
  type: 'source-state';
  viewId: number;
  state: 'migrated' | 'unavailable' | 'disk-missing' | 'available';
  /** 展示用说明（迁移目标名 / 原路径）；'available' 时为空串。 */
  detail: string;
}
export type PlaybackMessage = { type: 'playback'; viewId: number; requestId: number } & (
  { action: 'toggle'; context: PreviewContext } | { action: 'pause' | 'stop' }
);
export interface CursorMessage { type: 'cursor'; context: PreviewContext; offset: number | null }
export interface PlayFromCursorMessage { type: 'play-from-cursor'; context: PreviewContext; requestId: number; offset: number }
export interface PlayFromSelectionMessage { type: 'play-from-selection'; context: PreviewContext; requestId: number; targetRequestId?: number }
export interface SelectionSnapshotMessage { type: 'selection-snapshot'; viewId: number; requestId: number; document: DocumentMessage }
export type HostMessage = DocumentMessage | PlaybackMessage | CursorMessage | PlayFromCursorMessage | PlayFromSelectionMessage | SelectionSnapshotMessage | SourceStateMessage;

export function sameContext(first: PreviewContext | undefined, second: PreviewContext): boolean {
  return first?.viewId === second.viewId && first.revision === second.revision && first.version === second.version && first.selection === second.selection;
}

export function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function parseContext(value: unknown): PreviewContext | undefined {
  const context = object(value);
  if (context === undefined || !isSequence(context.viewId) || !isSequence(context.revision) || !isSequence(context.version) || !isSequence(context.selection)) return undefined;
  return { viewId: context.viewId, revision: context.revision, version: context.version, selection: context.selection };
}
function isRange(value: unknown): value is SourceHighlightRange {
  const range = object(value);
  return range !== undefined && isSequence(range.start) && isSequence(range.end) && range.start < range.end;
}
function isRanges(value: unknown): value is SourceHighlightRange[] {
  return Array.isArray(value) && value.length <= 16 && value.every(isRange);
}
function isReason(value: unknown): value is LinkageUnavailableReason {
  return value === 'no-mapping' || value === 'no-selection' || value === 'update-pending' || value === 'stale-score' || value === 'choose-tune' || value === 'structure-unreliable';
}

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  const message = object(value);
  if (message === undefined) return undefined;
  if (message.type === 'ready') return { type: 'ready' };
  if (message.type === 'reveal-source' && isSequence(message.viewId)) return { type: 'reveal-source', viewId: message.viewId };
  if (message.type === 'reveal-target' && isSequence(message.viewId)) return { type: 'reveal-target', viewId: message.viewId };
  const context = parseContext(message.context);
  if (context === undefined) return undefined;
  switch (message.type) {
    case 'context-invalidated':
      if (message.cancelRequests !== undefined && typeof message.cancelRequests !== 'boolean') return undefined;
      return { type: message.type, context, ...(message.cancelRequests === undefined ? {} : { cancelRequests: message.cancelRequests }) };
    case 'rendered':
      return typeof message.ok === 'boolean' && typeof message.linkable === 'boolean'
        ? { type: message.type, context, ok: message.ok, linkable: message.linkable } : undefined;
    case 'playback-state':
      return message.state === 'idle' || message.state === 'preparing' || message.state === 'playing' || message.state === 'paused'
        ? { type: message.type, context, state: message.state } : undefined;
    case 'reveal-range':
      return isRange(message) && isSequence(message.requestId) ? { type: message.type, context, requestId: message.requestId, start: message.start, end: message.end } : undefined;
    case 'source-highlight':
    case 'target-ranges':
      return isRanges(message.ranges) ? { type: message.type, context, ranges: message.ranges.map(({ start, end }) => ({ start, end })) } : undefined;
    case 'linkage-unavailable': return isReason(message.reason) ? { type: message.type, context, reason: message.reason } : undefined;
    case 'play-from-selection-request':
    case 'select-tune': return isSequence(message.requestId) ? { type: message.type, context, requestId: message.requestId } : undefined;
    default: return undefined;
  }
}

export function parseHostMessage(value: unknown): HostMessage | undefined {
  const message = object(value);
  if (message === undefined) return undefined;
  if (message.type === 'document') {
    if (typeof message.uri !== 'string' || typeof message.fileName !== 'string' || typeof message.abc !== 'string' || typeof message.isUntitled !== 'boolean' || !isSequence(message.version) || !isSequence(message.viewId) || !isSequence(message.revision)) return undefined;
    const result: DocumentMessage = { type: 'document', uri: message.uri, fileName: message.fileName, abc: message.abc, isUntitled: message.isUntitled, version: message.version, viewId: message.viewId, revision: message.revision };
    if (message.continued !== undefined) {
      if (typeof message.continued !== 'boolean') return undefined;
      result.continued = message.continued;
    }
    if (message.initialRequest !== undefined) {
      const request = object(message.initialRequest);
      if (request === undefined || !isSequence(request.requestId) || !isSequence(request.offset) || request.offset > result.abc.length) return undefined;
      result.initialRequest = { requestId: request.requestId, offset: request.offset };
    }
    return result;
  }
  if (message.type === 'source-state') {
    if (!isSequence(message.viewId) || typeof message.detail !== 'string') return undefined;
    if (message.state !== 'migrated' && message.state !== 'unavailable' && message.state !== 'disk-missing' && message.state !== 'available') return undefined;
    return { type: 'source-state', viewId: message.viewId, state: message.state, detail: message.detail };
  }
  if (message.type === 'selection-snapshot') {
    if (object(message.document)?.type !== 'document') return undefined;
    const document = parseHostMessage(message.document);
    return isSequence(message.viewId) && isSequence(message.requestId) && document?.type === 'document' && document.viewId === message.viewId
      ? { type: message.type, viewId: message.viewId, requestId: message.requestId, document } : undefined;
  }
  if (message.type === 'playback') {
    if (!isSequence(message.viewId) || !isSequence(message.requestId)) return undefined;
    if (message.action === 'pause' || message.action === 'stop') return { type: message.type, viewId: message.viewId, requestId: message.requestId, action: message.action };
    const context = parseContext(message.context);
    return message.action === 'toggle' && context?.viewId === message.viewId
      ? { type: message.type, viewId: message.viewId, requestId: message.requestId, action: message.action, context } : undefined;
  }
  const context = parseContext(message.context);
  if (context === undefined) return undefined;
  if (message.type === 'cursor' && (message.offset === null || isSequence(message.offset))) return { type: message.type, context, offset: message.offset };
  if (message.type === 'play-from-cursor' && isSequence(message.requestId) && isSequence(message.offset)) return { type: message.type, context, requestId: message.requestId, offset: message.offset };
  if (message.type === 'play-from-selection' && isSequence(message.requestId)) {
    if (message.targetRequestId !== undefined && !isSequence(message.targetRequestId)) return undefined;
    return { type: message.type, context, requestId: message.requestId, ...(message.targetRequestId === undefined ? {} : { targetRequestId: message.targetRequestId }) };
  }
  return undefined;
}
