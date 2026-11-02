/** SPEC-ENV-04 / STATE-02: two-way allowlist and context validation; file operation paths are never accepted. */
import {
  PRACTICE_SCHEMA_VERSION,
  parsePracticeRecord,
  type PracticeRecord,
  type PracticeTuneRecord,
  type PracticeUiPreferences,
} from './practice';

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
/** "Open target preview" entry on the migration status page (SPEC-LIFE-04): carries only the instance number; the target path comes from the host's own record. */
export interface WebviewRevealTargetMessage { type: 'reveal-target'; viewId: number }
/** Parse diagnostics (SPEC-STATE-06): reliably located items only; unreliable ones stay in the preview details and never reach Problems. */
export interface WebviewDiagnosticItem { message: string; start: number; end: number }
export interface WebviewDiagnosticsMessage { type: 'diagnostics'; context: PreviewContext; items: WebviewDiagnosticItem[] }
/** "Show problems" entry (SPEC-STATE-06): opens Problems only, changes nothing except binding, playback or focus-unrelated state. */
export interface WebviewShowProblemsMessage { type: 'show-problems'; viewId: number }
export interface WebviewRevealRangeMessage { type: 'reveal-range'; context: PreviewContext; requestId: number; start: number; end: number }
export interface WebviewLinkageUnavailableMessage { type: 'linkage-unavailable'; context: PreviewContext; reason: LinkageUnavailableReason }
export interface WebviewSourceHighlightMessage { type: 'source-highlight'; context: PreviewContext; ranges: SourceHighlightRange[] }
export interface WebviewTargetRangesMessage { type: 'target-ranges'; context: PreviewContext; ranges: SourceHighlightRange[] }
export interface WebviewPlayFromSelectionRequestMessage { type: 'play-from-selection-request'; context: PreviewContext; requestId: number }
export interface WebviewContextInvalidatedMessage { type: 'context-invalidated'; context: PreviewContext; cancelRequests?: boolean }
export interface WebviewSelectTuneMessage { type: 'select-tune'; context: PreviewContext; requestId: number }
/** Practice record submission (SPEC-SET-03 ~ 08): full UI preferences plus tune records; the host merges and saves per file. */
export interface WebviewPracticeStateMessage {
  type: 'practice-state';
  context: PreviewContext;
  ui: PracticeUiPreferences;
  tunes: PracticeTuneRecord[];
}
/** Reset practice settings for this file (SPEC-SET-07): the host deletes the file's record without touching ABC or playback state. */
export interface WebviewResetPracticeMessage { type: 'reset-practice'; context: PreviewContext }
export type WebviewMessage = WebviewReadyMessage | WebviewRenderedMessage | WebviewPlaybackStateMessage |
  WebviewRevealSourceMessage | WebviewRevealTargetMessage | WebviewRevealRangeMessage | WebviewLinkageUnavailableMessage |
  WebviewSourceHighlightMessage | WebviewTargetRangesMessage | WebviewPlayFromSelectionRequestMessage |
  WebviewContextInvalidatedMessage | WebviewSelectTuneMessage | WebviewDiagnosticsMessage | WebviewShowProblemsMessage |
  WebviewPracticeStateMessage | WebviewResetPracticeMessage;

export interface DocumentMessage {
  type: 'document';
  uri: string;
  fileName: string;
  abc: string;
  isUntitled: boolean;
  version: number;
  viewId: number;
  revision: number;
  /** Reliable migration (SPEC-LIFE-03): the uri changed but it is the same practice; keep session settings, tune identity and paused position. */
  continued?: boolean;
  /** The first source intent wins over the default first tune; the sequence number belongs to the host's operation order. */
  initialRequest?: { requestId: number; offset: number };
  /** Saved practice record of the file (SPEC-SET-02): attached only on the first push to the view; after restoring, the webview sends the full set back. */
  practice?: PracticeRecord;
}
/** Source status page (SPEC-LIFE-04 / 06 / 07): migration / unavailable / missing-on-disk notices and recovery clearing, without file operation paths. */
export interface SourceStateMessage {
  type: 'source-state';
  viewId: number;
  state: 'migrated' | 'unavailable' | 'disk-missing' | 'available';
  /** Display-only description (migration target name / original path); empty string when 'available'. */
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
/** Limits on diagnostic count and text length: malformed input must not bloat messages; a position must be a non-empty range. */
function isDiagnosticItems(value: unknown): value is WebviewDiagnosticItem[] {
  return Array.isArray(value) && value.length <= 32 && value.every((item) => {
    const diagnostic = object(item);
    return diagnostic !== undefined && typeof diagnostic.message === 'string' && diagnostic.message.length > 0 && diagnostic.message.length <= 500 &&
      isSequence(diagnostic.start) && isSequence(diagnostic.end) && diagnostic.start < diagnostic.end;
  });
}

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  const message = object(value);
  if (message === undefined) return undefined;
  if (message.type === 'ready') return { type: 'ready' };
  if (message.type === 'reveal-source' && isSequence(message.viewId)) return { type: 'reveal-source', viewId: message.viewId };
  if (message.type === 'reveal-target' && isSequence(message.viewId)) return { type: 'reveal-target', viewId: message.viewId };
  if (message.type === 'show-problems' && isSequence(message.viewId)) return { type: 'show-problems', viewId: message.viewId };
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
    case 'diagnostics':
      return isDiagnosticItems(message.items)
        ? { type: message.type, context, items: message.items.map(({ message: text, start, end }) => ({ message: text, start, end })) } : undefined;
    case 'play-from-selection-request':
    case 'select-tune': return isSequence(message.requestId) ? { type: message.type, context, requestId: message.requestId } : undefined;
    case 'practice-state': {
      const record = parsePracticeRecord({ version: PRACTICE_SCHEMA_VERSION, ui: message.ui, tunes: message.tunes });
      return record === undefined ? undefined : { type: message.type, context, ui: record.ui, tunes: record.tunes };
    }
    case 'reset-practice': return { type: message.type, context };
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
    if (message.practice !== undefined) {
      // Safe fallback for an invalid record (SPEC-SET-08): drop the item instead of rejecting the whole document
      const practice = parsePracticeRecord(message.practice);
      if (practice !== undefined) result.practice = practice;
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
