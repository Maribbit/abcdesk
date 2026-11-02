import { renderAbc, type AbcElem, type NoteTimingEvent, type TuneObject } from 'abcjs';
import { parseHostMessage, sameContext, type DocumentMessage, type SourceStateMessage, type SourceHighlightRange, type PreviewContext, type WebviewMessage, type LinkageUnavailableReason } from '../core/messages';
import { TuneSession, sameSnapshot } from '../core/tuneSession';
import { defaultPracticeUiPreferences } from '../core/practice';
import { tuneAtSource } from '../core/tunes';
import { collectParseDiagnostics, type ParseDiagnostic } from '../core/diagnostics';
import { toSourceRange, type MappedText } from '../core/sourceMap';
import { TunePicker, tuneLabel } from './tunePicker';
import { sourceEvent, sourceRanges, validateSourceTarget } from './tuneSource';
import { PlaybackController, type PlaybackPhase } from './audio';
import { KeyboardView, collectPitches } from './keyboard';
import { t } from './l10n';
import { SPEED_DEFAULT, formatClock, parseSpeedPercent, voiceSignature, type VoiceEntry } from './playback';

/**
 * Player webview entry (M0: render pipeline, playback core, edit update pipeline and source linkage).
 *
 * All host communication goes through the message bridge; never import vscode (see docs/conventions.md);
 * messages with incomplete shapes are ignored and no source other than the host is trusted (SPEC-ENV-04).
 * Content update policy (SPEC-STATE-03 / 05 / 07 / 08):
 * - a new version arriving during playback is only cached with the notice "file updated, applied after pause"; no early version switch;
 * - pause / stop / natural end / pause triggered by hiding or takeover all apply the cached version the same way (reset, no auto-play);
 * - a render failure keeps the old score marked as reference only with its playback disabled; without an old score an error placeholder is shown;
 * - blank content shows the empty state with a "go to source" entry and never treats the old score as current content.
 * Source linkage (SPEC-PLAY-11 / 12):
 * - clicking a score note sets it as the target and requests source locating (focus stays in the preview), without changing the playback position or making extra sound;
 * - the current target note (shared by click and inspection, latest wins) is shown as a fill + dashed box, distinct from playback highlighting in both shape and color;
 * - when the playback position leaves the visible area the view follows automatically; after a manual scroll following pauses and "resume following" is shown;
 * - "play from here" starts from a reliable mapping and explains the reason when the mapping is unreliable or linkage is suspended (never quietly plays from the beginning);
 * - the "play from here" button in the controls starts from the current target note (SPEC-PLAY-12); its availability refreshes with the target and linkage state.
 * Parse diagnostics (SPEC-STATE-06):
 * - abcjs parse warnings are mapped back to the source through the current tune input; contiguously mappable ones go to Problems, the rest stay in the preview details;
 * - the status area shows a summary plus expandable raw details; unreliable positions show no line numbers;
 * - recomputed in full on every render and cleared on read-only source pages; "view problems" opens Problems only on user action.
 *
 * Keyboard (SPEC-PLAY-08 / 09 / 15, STATE-03 / 05):
 * - the keyboard defaults to the current tune's material range (at least two octaves) and can switch to the full 88 keys or be collapsed manually;
 *   playback highlighting follows performance time (including muted voices), sounding notes outside the viewport only show direction arrows;
 * - the target note is reflected on the keyboard in the inspection color (SPEC-PLAY-15) and cleared together with the target.
 * Playback controls (SPEC-PLAY-04 / 05 / 06, implemented in the webview without new messages):
 * - a committed speed keeps the music position through a rebuild (a brief buffer during playback, then continues); the reset-to-original entry and BPM hint follow;
 * - dragging the progress bar only previews and commits one seek on release; commits arriving after a state change (stop / version switch) are dropped; keyboard stepping seeks immediately;
 * - during playback the voices menu is view-only and guides the user to pause first; mutes take effect through a rebuild without auto-resume; chord accompaniment has its own toggle.
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

const topbarElement = queryElement('topbar');
const scoreElement = queryElement('score');
const loopButton = queryElement<HTMLButtonElement>('loop');
const playButton = queryElement<HTMLButtonElement>('play');
const stopButton = queryElement<HTMLButtonElement>('stop');
const playbackStatusElement = queryElement('playback-status');
const contentStatusElement = queryElement('content-status');
const contentStatusTextElement = queryElement('content-status-text');
const viewProblemsButton = queryElement<HTMLButtonElement>('view-problems');
const diagnosticsDetails = queryElement<HTMLDetailsElement>('diagnostics-details');
const diagnosticsSummary = queryElement('diagnostics-summary');
const diagnosticsList = queryElement('diagnostics-list');
const revealSourceButton = queryElement<HTMLButtonElement>('reveal-source');
const revealTargetButton = queryElement<HTMLButtonElement>('reveal-target');
const followResumeButton = queryElement<HTMLButtonElement>('follow-resume');
const playFromHereWrap = queryElement('play-from-here-wrap');
const playFromHereButton = queryElement<HTMLButtonElement>('play-from-here');
const speedLabelElement = queryElement('speed-label');
const speedInputElement = queryElement<HTMLInputElement>('speed-input');
const speedResetButton = queryElement<HTMLButtonElement>('speed-reset');
const speedHintElement = queryElement('speed-hint');
const voicesMenuElement = queryElement<HTMLDetailsElement>('voices-menu');
const voicesSummaryElement = queryElement('voices-summary');
const voicesPauseButton = queryElement<HTMLButtonElement>('voices-pause');
const voicesListElement = queryElement('voices-list');
const voicesPanelElement = queryElement('voices-panel');
const moreMenuElement = queryElement<HTMLDetailsElement>('more-menu');
const moreSummaryElement = queryElement('more-summary');
const morePanelElement = queryElement('more-panel');
const resetPracticeButton = queryElement<HTMLButtonElement>('reset-practice');
const resetPracticeNoteElement = queryElement('reset-practice-note');
const progressElement = queryElement('progress');
const progressFillElement = queryElement('progress-fill');
const progressThumbElement = queryElement('progress-thumb');
const progressTimeElement = queryElement('progress-time');

/** Latest document that arrived during playback and waits to be applied (SPEC-STATE-07). */
let pendingDocument: DocumentMessage | undefined;
const session = new TuneSession();
let currentDocument: DocumentMessage | undefined;
let context: PreviewContext | undefined;
let lastHostRequest = -1;
let sourceRequestSequence = 0;
let pendingTargetRequest: number | undefined;
let transaction = false;
let playable = false;
let activeInput: MappedText | undefined;
let activeSignature: string | null = null;
let referenceLabel = '';
let contentDetail = '';
let renderOk = false;

/** Fill in the currently applied context uniformly; the type system catches omissions from the old protocol. */
type ContextMessage = Extract<WebviewMessage, { context: PreviewContext }>;
type WithoutContext<T> = T extends ContextMessage ? Omit<T, 'context'> : never;
function post(message: WithoutContext<ContextMessage>): void {
  if (context !== undefined) host.postMessage({ ...message, context });
}

const tunePicker = new TunePicker(queryElement('tunes'), queryElement<HTMLButtonElement>('confirm-tune'), chooseTune);
/** Text keys of the content status area: apply after pause / old score reference / empty state. */
let contentStatusKey: string | null = null;
/** Whether the empty state shows the "go to source" entry (SPEC-STATE-05). */
let showRevealSource = false;
/** Source status (SPEC-LIFE-04 / 06 / 07): migration / unavailable pages are read-only references, missing-on-disk is a notice only and does not change playability. */
let sourceState: SourceStateMessage['state'] = 'available';
/** Display text of the source status (migration target name / original path). */
let sourceDetail = '';
/** Instance number carried by the source status message: used by the read-only page's "open the migrated preview" entry when there is no document context. */
let sourceStateViewId = 0;
/** Parse diagnostics of the latest render (SPEC-STATE-06): all stay in the preview details, only reliably positioned ones go to Problems. */
let diagnostics: ParseDiagnostic[] = [];
/** Whether the score area already holds a successfully rendered score: on render failure this decides between keeping a reference and showing the error placeholder (SPEC-STATE-03). */
let hasRenderedScore = false;
/** Performance timing of the current version (SPEC-PLAY-11 / 12): the single basis for the char <-> note <-> element mapping, rebuilt with every render. */
let timingEvents: NoteTimingEvent[] = [];
/** Char offset of the current target note (SPEC-PLAY-11 / 12 / 15): maintained jointly by preview clicks and source cursor hits, latest wins; score marks, keyboard reflection and "play from here" availability sync from it. */
let targetOffset: number | null = null;
/** Score elements of the target note (SPEC-PLAY-11): the basis for scroll positioning; the old ones are cleared before the new ones light up when the target changes. */
let targetElements: SVGElement[] = [];
/** Overlay boxes of the target note (SPEC-PLAY-11): rebuilt wholesale with the target, cleared on version switch / suspension. */
let readingBoxes: HTMLDivElement[] = [];
/** Snapshot of each element's fill attribute at render time (SPEC-PLAY-11): abcjs native click selection overwrites this presentation attribute and it is not restored when the class is removed, so marks are restored from here when cleared. */
let nativeFillSnapshot = new WeakMap<Element, string | null>();
/** Serialized form of the target source range last reported to the host (SPEC-PLAY-11): consecutive cursor moves inside the same note are not re-sent. */
let sentTargetRanges: string | undefined;
/** Current target element of playback highlighting (SPEC-PLAY-11). */
let playingElements: SVGElement[] = [];
/** Auto-follow paused because the user scrolled the score manually during playback (SPEC-PLAY-11); reset on stop or version switch. */
let followPaused = false;
/** Render version counter (SPEC-PLAY-05): a commit arriving after the version became stale (version switch) during a progress drag is dropped. */
let renderSequence = 0;
/** Voices menu structure signature and row inputs (SPEC-PLAY-06): rows are rebuilt only when the structure changes, so checking and refreshing keep focus. */
let voicesStructureSignature: string | undefined;
let voiceInputs: HTMLInputElement[] = [];
let chordsInput: HTMLInputElement | undefined;
/** Progress drag (SPEC-PLAY-05): phase and version counter validate the commit (dropped on stop / version switch and similar). */
type ProgressDrag = { fraction: number; phase: PlaybackPhase; sequence: number };
let dragState: ProgressDrag | undefined;
/** Progress polling timer during playback (SPEC-PLAY-05): stopped outside the playing phase, no idle spinning. */
let progressTimer: number | undefined;
/** This view has applied its first document and may report practice records (SPEC-SET-02 / 08). */
let practiceLoaded = false;
/** Serialized form of the last reported practice record: unchanged settings are not re-submitted. */
let lastPracticeReport: string | undefined;

// Configuration injected by the host (written by previewPanel through the nonce script): local soundfont root URL (SPEC-ENV-05 / 07)
const webviewConfig = (window as unknown as { __abcdesk?: { soundfontUrl?: unknown } }).__abcdesk;
const soundfontUrl = typeof webviewConfig?.soundfontUrl === 'string' ? webviewConfig.soundfontUrl : undefined;

const controller = new PlaybackController(
  { soundfontUrl },
  refreshPlaybackUi,
  applyPlayingHighlight,
  // Event milliseconds scale with the new timing after a speed change (SPEC-PLAY-04): refetch the timing to refresh the char <-> note mapping and the basis for "play from here"
  () => {
    timingEvents = controller.getTimings();
  },
);

/** Keyboard visualization (SPEC-PLAY-08 / 09): range and collapsed states are independent, dynamic highlighting is driven by playback events. */
const keyboardSection = queryElement('keyboard');
const keyboardView = new KeyboardView({
  section: keyboardSection,
  caption: queryElement('keyboard-caption'),
  note: queryElement('keyboard-note'),
  scroll: queryElement('keyboard-scroll'),
  keys: queryElement('keyboard-keys'),
  rangeSelect: queryElement<HTMLSelectElement>('keyboard-range'),
  collapseButton: queryElement<HTMLButtonElement>('keyboard-collapse'),
  leftArrow: queryElement('keyboard-hint-left'),
  rightArrow: queryElement('keyboard-hint-right'),
});
// UI preference changes (SPEC-SET-05): go through the same full report as the music settings
keyboardView.onPreferencesChange = () => reportPracticeState();

/** Refresh button icons and tooltips plus the status text for the current phase and report the playback state (SPEC-PLAY-01 / 13). */
function refreshPlaybackUi(): void {
  if (transaction) return;
  rememberSettings();
  if (pendingDocument !== undefined && session.selectionRequest === undefined) {
    const { phase } = controller.getStatus();
    if (phase === 'idle' || phase === 'paused') {
      // Pause / stop / natural end / pause triggered by hiding or takeover: apply the update uniformly with reset (SPEC-STATE-07)
      applyPendingDocument();
    }
  }
  const { phase, statusKey } = controller.getStatus();
  if (phase === 'idle') {
    // Stop / natural end / cancelled start: reset the follow state (SPEC-PLAY-11)
    followPaused = false;
  }
  const labelKey = phase === 'preparing' ? 'cancel-prepare' : phase === 'playing' ? 'pause' : 'play';
  const label = t(labelKey);
  // Phase -> icon glyph (SPEC-PLAY-01): while preparing show the static loading icon (not spinning); clicking still means cancel the start
  const iconKey = phase === 'preparing' ? 'loading' : phase === 'playing' ? 'debug-pause' : 'play';
  playButton.className = `codicon codicon-${iconKey}`;
  playButton.title = label;
  playButton.setAttribute('aria-label', label); // Accessible name stays in sync with the tooltip (SPEC-PLAY-01 / A11Y-06)
  stopButton.title = t('stop');
  stopButton.setAttribute('aria-label', t('stop'));
  // Stop is enabled only when there is something to stop; kept while preparing (= cancel and reset, SPEC-PLAY-01)
  stopButton.disabled = phase === 'idle' && session.selectionRequest === undefined;
  playButton.disabled = !playable || session.selectionRequest !== undefined;
  loopButton.disabled = !playable;
  speedInputElement.disabled = !playable;
  progressElement.setAttribute('aria-disabled', String(!playable));
  // Loop toggle (SPEC-PLAY-03): fixed glyph, persistent state shown through aria-pressed (ON background in the styles)
  loopButton.title = t('loop');
  loopButton.setAttribute('aria-label', t('loop'));
  loopButton.setAttribute('aria-pressed', String(controller.getLoopEnabled()));
  playbackStatusElement.hidden = statusKey === null; // Takes no space without text (SPEC-PLAY-13)
  playbackStatusElement.textContent = statusKey === null ? '' : t(statusKey);
  updateFollowResumeButton();
  updateSpeedUi();
  updateVoicesUi();
  updateProgressUi();
  updateProgressPolling();
  // The host uses this to keep only one sounding preview per window (SPEC-PLAY-01)
  post({ type: 'playback-state', state: phase });
  reportPracticeState();
}

/** Refresh the speed control (SPEC-PLAY-04): label and current value; a focused input is not overwritten while being edited. */
function updateSpeedUi(): void {
  const speed = controller.getSpeed();
  speedLabelElement.textContent = t('speed-label');
  speedResetButton.title = t('speed-reset');
  speedResetButton.setAttribute('aria-label', t('speed-reset'));
  speedResetButton.disabled = !playable || speed === SPEED_DEFAULT;
  if (document.activeElement !== speedInputElement) {
    speedInputElement.value = String(speed);
  }
  const hint = controller.getBeatHint();
  speedHintElement.hidden = hint === null;
  speedHintElement.textContent = hint === null ? '' : t('speed-hint-beat').replace('{0}', String(hint));
}

/** Commit the speed input (SPEC-PLAY-04): a valid value is applied and written back normalized, empty / non-numeric restores the current value (P06 gauge). */
function commitSpeedInput(): void {
  const parsed = parseSpeedPercent(speedInputElement.value);
  if (parsed === null) {
    speedInputElement.value = String(controller.getSpeed());
    return;
  }
  controller.setSpeed(parsed);
  speedInputElement.value = String(controller.getSpeed()); // Write back the clamped / rounded normalized value
}

/** Refresh the voices menu (SPEC-PLAY-06): with unchanged structure only checks and enabled state are updated; pause first before adjusting during playback. */
function updateVoicesUi(): void {
  const voices = controller.getVoices();
  const hasChords = controller.hasChordAccompaniment();
  const playing = controller.getStatus().phase === 'playing';
  const signature = JSON.stringify([voices.map((voice) => [voice.index, voice.name]), hasChords]);
  if (signature !== voicesStructureSignature) {
    voicesStructureSignature = signature;
    rebuildVoicesList(voices, hasChords);
  }
  for (let index = 0; index < voiceInputs.length; index += 1) {
    // Checked = sounding, unchecked = muted (SPEC-PLAY-06 sound toggle): all checked by default = play every notated voice; not adjustable on read-only source pages
    voiceInputs[index].checked = !(voices[index]?.muted ?? false);
    voiceInputs[index].disabled = playing || isReadOnlySource();
  }
  if (chordsInput !== undefined) {
    chordsInput.checked = !controller.getChordsMuted();
    chordsInput.disabled = playing || isReadOnlySource();
  }
  voicesMenuElement.hidden = voices.length === 0 && !hasChords;
  voicesPauseButton.hidden = !playing;
  // Mute summary while the menu is closed (SPEC-PLAY-06): shows "Voices" without mutes, replaced by the summary when there are mutes
  const mutedCount = voices.filter((voice) => voice.muted).length;
  const chordsMuted = controller.getChordsMuted();
  let summary: string;
  if (mutedCount > 0 && chordsMuted) {
    summary = t('voices-summary-voices-and-chords').replace('{0}', String(mutedCount));
  } else if (mutedCount > 0) {
    summary = t('voices-summary-muted').replace('{0}', String(mutedCount));
  } else if (chordsMuted) {
    summary = t('voices-summary-chords');
  } else {
    summary = t('voices-summary');
  }
  voicesSummaryElement.textContent = summary;
}

/** Rebuild the voices menu rows (SPEC-PLAY-06): voices in list order, checked = sounding; the automatic chord accompaniment row (when present) has its own toggle. */
function rebuildVoicesList(voices: Array<VoiceEntry & { muted: boolean }>, hasChords: boolean): void {
  voicesListElement.textContent = '';
  voiceInputs = [];
  chordsInput = undefined;
  for (const voice of voices) {
    const label = voice.name ?? t('voice-label').replace('{0}', String(voice.index + 1));
    voiceInputs.push(
      appendVoiceRow(label, !voice.muted, (input) => controller.setVoiceMuted(voice.index, !input.checked)),
    );
  }
  if (hasChords) {
    chordsInput = appendVoiceRow(t('voices-chords'), !controller.getChordsMuted(), (input) =>
      controller.setChordsMuted(!input.checked),
    );
  }
}

/** Build one voice toggle row (the whole row is clickable): checked = sounding, unchecked = muted; returns the input for refreshing its check and enabled state. */
function appendVoiceRow(
  labelText: string,
  checked: boolean,
  onToggle: (input: HTMLInputElement) => void,
): HTMLInputElement {
  const row = document.createElement('div');
  row.className = 'abcdesk-voice-row';
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onToggle(input));
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(input, text);
  row.appendChild(label);
  voicesListElement.appendChild(row);
  return input;
}

/** Refresh the progress display (SPEC-PLAY-05): not pulled back to the actual position while a drag preview is active. */
function updateProgressUi(): void {
  if (dragState !== undefined) {
    return;
  }
  const { positionMs, totalMs } = controller.getProgress();
  renderProgress(positionMs, totalMs);
}

/** Refresh thumb, fill and time label from position and total length (visible text and aria-valuetext share one source). */
function renderProgress(positionMs: number, totalMs: number): void {
  const fraction = totalMs > 0 ? Math.min(1, Math.max(0, positionMs / totalMs)) : 0;
  progressFillElement.style.width = `${fraction * 100}%`;
  progressThumbElement.style.left = `${fraction * 100}%`;
  progressElement.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  const text = `${formatClock(positionMs)} / ${formatClock(totalMs)}`;
  progressElement.setAttribute('aria-valuetext', text);
  progressTimeElement.textContent = text;
}

/** Refresh progress and time label every 250ms during playback (SPEC-PLAY-05); polling stops outside the playing phase, no idle spinning. */
function updateProgressPolling(): void {
  const playing = controller.getStatus().phase === 'playing';
  if (playing && progressTimer === undefined) {
    progressTimer = window.setInterval(updateProgressUi, 250);
  } else if (!playing && progressTimer !== undefined) {
    window.clearInterval(progressTimer);
    progressTimer = undefined;
  }
}

/** Pointer x coordinate -> fraction of the music. */
function progressFractionFromPointer(clientX: number): number {
  const rect = progressElement.getBoundingClientRect();
  if (rect.width <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/** Drag preview display (SPEC-PLAY-05): changes the display only, no sound and no playback state change. */
function previewDrag(fraction: number): void {
  const { totalMs } = controller.getProgress();
  renderProgress(Math.round(totalMs * fraction), totalMs);
}

/** Commit a drag seek (SPEC-PLAY-05): dropped when the version or phase changed (stop / natural end / takeover), never applied to the new state. */
function commitDrag(drag: ProgressDrag): void {
  const stale = controller.getStatus().phase !== drag.phase || renderSequence !== drag.sequence;
  if (!stale) {
    controller.seekToFraction(drag.fraction);
  }
  updateProgressUi();
}

/** Apply the cached latest version: render and switch versions with reset (SPEC-STATE-07), no auto-play; the result is reported so the host can lift the linkage suspension (SPEC-PLAY-11). */
function applyPendingDocument(): void {
  const message = pendingDocument;
  if (message === undefined) {
    return;
  }
  pendingDocument = undefined;
  renderAndReport(message);
}

/** Save only committed settings belonging to the currently valid tune; a failure placeholder does not overwrite history. */
function rememberSettings(): void {
  if (playable && session.selectionRequest === undefined) session.remember(controller.getSettings(), activeSignature);
}

/**
 * Report the full practice record (SPEC-SET-03 ~ 08): UI preferences come from the keyboard view, tune records from the session;
 * reporting is allowed only after the first document is applied, and unchanged state is not re-submitted.
 */
function reportPracticeState(): void {
  if (!practiceLoaded || context === undefined) return;
  const ui = keyboardView.getPreferences();
  const tunes = session.exportRecords();
  const serialized = JSON.stringify({ ui, tunes });
  if (serialized === lastPracticeReport) return;
  lastPracticeReport = serialized;
  post({ type: 'practice-state', ui, tunes });
}

function invalidateContext(message: DocumentMessage): void {
  context = { viewId: message.viewId, revision: message.revision, version: message.version, selection: (context?.selection ?? 0) + 1 };
  renderSequence += 1;
  dragState = undefined;
  progressElement.classList.remove('abcdesk-dragging');
  playable = false;
  activeInput = undefined;
  sentTargetRanges = undefined;
  post({ type: 'context-invalidated' });
}

function reportRendered(): void {
  post({ type: 'rendered', ok: renderOk, linkable: playable });
}

/** SPEC-DOC-04: refresh only after the batched commit; the synchronous callbacks of stop/setTune must not re-enter applying the pending update. */
function renderAndReport(message: DocumentMessage, applied = false): void {
  transaction = true;
  if (!applied) {
    rememberSettings();
    session.apply(message);
  }
  const { initialRequest, practice, ...snapshot } = message;
  currentDocument = snapshot; // The initial intent is consumed exactly once and is not revived by cancelling tune selection or re-rendering.
  // A saved file's practice record is restored only when the view applies its first document (SPEC-SET-02 / 03 / 04 / 05)
  if (!practiceLoaded) {
    practiceLoaded = true;
    if (practice !== undefined) {
      session.restore(practice.tunes);
      keyboardView.applyPreferences(practice.ui);
    }
  }
  pendingDocument = undefined;
  invalidateContext(message);
  controller.setTune(undefined);
  resetLinkageState();
  let initialOffset: number | undefined;
  const initial = initialRequest !== undefined && initialRequest.requestId > lastHostRequest ? initialRequest : undefined;
  if (initial !== undefined) {
    lastHostRequest = initial.requestId;
    const candidate = tuneAtSource(session.catalog, initial.offset);
    if (candidate !== undefined && validateSourceTarget(candidate, initial.offset)) {
      session.select(candidate.index);
      initialOffset = initial.offset;
    }
  }
  renderOk = renderDocument(message);
  tunePicker.update(session.catalog, session.selected);
  transaction = false;
  refreshPlaybackUi();
  reportDiagnostics();
  reportRendered();
  if (initialOffset !== undefined) {
    applyReadingMarker(initialOffset);
    playFromOffset(initialOffset);
  } else if (initial !== undefined && initial.requestId === lastHostRequest) {
    post({ type: 'linkage-unavailable', reason: 'no-mapping' });
  }
}

function chooseTune(index: number): void {
  if (isReadOnlySource()) return; // Read-only source pages accept no tune switching (SPEC-LIFE-04 / 06)
  rememberSettings();
  const request = session.beginSelection(index);
  if (request === undefined || currentDocument === undefined) return;
  transaction = true;
  invalidateContext(currentDocument);
  controller.setTune(undefined);
  resetLinkageState();
  contentStatusKey = 'switching-tune';
  contentDetail = hasRenderedScore ? referenceLabel : '';
  transaction = false;
  updateContentStatus();
  refreshPlaybackUi();
  post({ type: 'select-tune', requestId: request.id });
}

/** Stop / hide / a new intent cancels the wait; a late tune selection response must not restore the previous selection. */
function playbackAction(action: 'toggle' | 'pause' | 'stop'): void {
  pendingTargetRequest = undefined;
  dragState = undefined;
  progressElement.classList.remove('abcdesk-dragging');
  // A control intent opens a new operation boundary without re-rendering the score; an earlier host start must not cross this stop/pause.
  if (context !== undefined) {
    context = { ...context, selection: context.selection + 1 };
    sentTargetRanges = undefined;
    post({ type: 'context-invalidated', cancelRequests: true });
  }
  const waiting = session.selectionRequest !== undefined;
  session.cancelSelection();
  if (waiting && currentDocument !== undefined) renderAndReport(pendingDocument ?? currentDocument);
  if (action === 'stop') controller.stop();
  else if (action === 'pause') controller.pause();
  else if (playable) controller.toggle();
  refreshPlaybackUi();
  reportRendered();
  if (playable && targetOffset !== null) applyReadingMarker(targetOffset);
}

/**
 * Reset this file's practice settings (SPEC-SET-07): pause and cancel pending starts first, then restore UI and music defaults;
 * does not modify the ABC, does not auto-play, adds no command; the playback position is kept.
 */
function resetPractice(): void {
  moreMenuElement.open = false;
  const { phase } = controller.getStatus();
  if (phase === 'playing' || phase === 'preparing' || session.selectionRequest !== undefined) {
    playbackAction('pause');
  }
  session.clearRecords();
  // After clearing, force one report of the default state; the host then deletes this file's record
  lastPracticeReport = undefined;
  keyboardView.applyPreferences(defaultPracticeUiPreferences());
  controller.setLoopEnabled(false);
  controller.setSpeed(SPEED_DEFAULT);
  controller.setChordsMuted(false);
  for (const voice of controller.getVoices()) {
    controller.setVoiceMuted(voice.index, false);
  }
  refreshPlaybackUi();
  post({ type: 'reset-practice' });
}

/** Content status area (SPEC-STATE-08 / LIFE-04 / 06): source status / old score reference / empty state / apply-after-pause notice and entries. */
function updateContentStatus(): void {
  const warnings: string[] = [];
  if (sourceState === 'migrated') warnings.push(t('source-migrated').replace('{0}', sourceDetail));
  else if (sourceState === 'unavailable') warnings.push(t('source-unavailable').replace('{0}', sourceDetail));
  else if (sourceState === 'disk-missing') warnings.push(t('source-disk-missing').replace('{0}', sourceDetail));
  // The old score on a read-only source page is reference only (SPEC-LIFE-04 / 06): add an explicit reference note
  if (isReadOnlySource() && hasRenderedScore) warnings.push(t('stale-score'));
  if (contentStatusKey !== null) warnings.push(t(contentStatusKey));
  if (contentDetail) warnings.push(contentDetail);
  if (session.catalog.issues.length > 0 && contentStatusKey !== 'structure-unreliable') warnings.push(t('structure-unreliable'));
  // Ordinary parse warnings do not block playback (SPEC-STATE-06): summary only, details in the expandable area
  if (diagnostics.length > 0) warnings.push(t('parse-warnings').replace('{0}', String(diagnostics.length)));
  contentStatusTextElement.textContent = warnings.filter(Boolean).join(' ');
  renderDiagnostics();
  const revealTarget = sourceState === 'migrated';
  contentStatusElement.hidden = contentStatusTextElement.textContent === '' && !showRevealSource && !revealTarget;
  revealSourceButton.hidden = !showRevealSource;
  if (showRevealSource) {
    revealSourceButton.textContent = t('reveal-source');
    revealSourceButton.setAttribute('aria-label', t('reveal-source'));
  }
  revealTargetButton.hidden = !revealTarget;
  if (revealTarget) {
    revealTargetButton.textContent = t('open-migrated');
    revealTargetButton.setAttribute('aria-label', t('open-migrated'));
  }
  // Content status changes also affect "play from here" availability (pending update / old score reference, SPEC-PLAY-12)
  updatePlayFromHereButton();
}

/** Parse diagnostics details (SPEC-STATE-06): raw messages listed one by one, without abcjs's position prefix or line numbers. */
function renderDiagnostics(): void {
  diagnosticsSummary.textContent = t('diagnostics-details');
  diagnosticsList.replaceChildren(...diagnostics.map((item) => {
    const entry = document.createElement('li');
    const message = document.createElement('span');
    message.textContent = item.message;
    entry.append(message);
    if (item.detail !== '') {
      const detail = document.createElement('div');
      detail.className = 'abcdesk-diagnostic-detail';
      detail.textContent = item.detail;
      entry.append(detail);
    }
    return entry;
  }));
  diagnosticsDetails.hidden = diagnostics.length === 0;
  // "View problems" appears only when there are reliably positioned items (SPEC-STATE-06): the user opens Problems themselves after triggering it
  const reliable = diagnostics.some((item) => item.range !== undefined);
  viewProblemsButton.hidden = !reliable;
  if (reliable) {
    viewProblemsButton.textContent = t('view-problems');
    viewProblemsButton.setAttribute('aria-label', t('view-problems'));
  }
}

/** Report only contiguously mappable diagnostics (SPEC-STATE-06): unreliable items stay in the preview details, no line numbers are invented. */
function reportDiagnostics(): void {
  const items = diagnostics.flatMap((item) => item.range === undefined
    ? []
    : [{ message: item.message.slice(0, 500), start: item.range.start, end: item.range.end }]);
  post({ type: 'diagnostics', items });
}

/** Read-only source state (SPEC-LIFE-04 / 06): migration status page and source-unavailable page, the old score is reference only. */
function isReadOnlySource(): boolean {
  return sourceState === 'migrated' || sourceState === 'unavailable';
}

/**
 * Apply the source status (SPEC-LIFE-04 / 06 / 07):
 * - migrated / unavailable: read-only reference page - playback, locating, settings changes and tune switching are disabled, the old score stays displayed;
 * - disk-missing: a missing-on-disk notice, playability unchanged; available: clears the notice.
 */
function applySourceState(state: SourceStateMessage['state'], detail: string): void {
  sourceState = state;
  sourceDetail = detail;
  if (!isReadOnlySource()) {
    updateContentStatus();
    return;
  }
  pendingDocument = undefined;
  session.cancelSelection();
  playable = false;
  activeInput = undefined;
  applyTarget(null);
  setMarkerClass(playingElements, 'abcdesk-playing', false);
  playingElements = [];
  followPaused = false;
  contentStatusKey = null;
  contentDetail = '';
  showRevealSource = false;
  // The old binding has ended (SPEC-STATE-06): the old score reference keeps no diagnostics that could lead into Problems
  diagnostics = [];
  controller.setTune(undefined);
  tunePicker.setLocked(true);
  updateContentStatus();
  refreshPlaybackUi();
  reportDiagnostics();
}

/** Source recovered (SPEC-LIFE-07): an explicit document push from the host lifts the read-only lock and returns to the regular apply path. */
function releaseSourceLock(): void {
  if (!isReadOnlySource()) return;
  sourceState = 'available';
  sourceDetail = '';
  tunePicker.setLocked(false);
}

/** Empty state: clear the score, show "file has no music content yet" and offer the "go to source" entry (SPEC-STATE-05). */
function showEmptyState(): void {
  scoreElement.textContent = '';
  hasRenderedScore = false;
  contentStatusKey = 'empty-file';
  showRevealSource = true;
  controller.setTune(undefined);
  keyboardView.clear(); // The empty state shows no keyboard (SPEC-STATE-05, the keyboard area appears / disappears with the material)
  updateContentStatus();
}

/** Render the selected tune's self-contained input; the old score's ownership label is independent of the current selection. */
function renderDocument(message: DocumentMessage): boolean {
  contentDetail = '';
  // Parse diagnostics are recomputed in full on every render (SPEC-STATE-06): warnings from old versions / old tunes must not linger
  diagnostics = [];
  if (session.catalog.tunes.length === 0 && session.catalog.issues.length === 0) {
    showEmptyState();
    return true;
  }
  const selected = session.current;
  if (selected === undefined || !selected.reliable) {
    showUnavailableScore(selected === undefined && !session.catalog.initialBlocked ? 'choose-tune' : 'structure-unreliable');
    return false;
  }
  const previousNodes = Array.from(scoreElement.childNodes);
  const sequence = renderSequence;
  try {
    const tune = renderAbc(scoreElement, selected.input.text, {
      responsive: 'resize',
      add_classes: true,
      clickListener: (abcElem) => { if (sequence === renderSequence) handleScoreClick(abcElem); },
    })[0];
    if (tune === undefined || !tuneHasNotes(tune)) {
      scoreElement.replaceChildren(...previousNodes);
      showUnavailableScore('no-notes');
      return false;
    }
    // abcjs parse warnings are mapped back to the source through the current tune input (SPEC-STATE-06): only contiguously mappable ones go to Problems
    diagnostics = collectParseDiagnostics(tune.warnings ?? [], selected.input);
    activeSignature = voiceSignature(tune, selected.input.text);
    const restored = session.settingsFor(activeSignature);
    controller.setTune(tune, restored.settings);
    activeInput = selected.input;
    playable = true;
    hasRenderedScore = true;
    referenceLabel = t('reference-tune').replace('{0}', tuneLabel(session.catalog, selected.index))
      .replace('{1}', selected.id ?? t('missing-tune-id')).replace('{2}', String(message.version));
    contentStatusKey = restored.voicesChanged ? 'voices-changed' : null;
    showRevealSource = session.catalog.issues.length > 0;
    session.remember(controller.getSettings(), activeSignature);
    // Uncommitted speed input does not carry over between tunes.
    speedInputElement.value = String(controller.getSpeed());
    snapshotNativePaint();
    timingEvents = controller.getTimings();
    keyboardView.setTune(collectPitches(timingEvents));
    updateContentStatus();
    return true;
  } catch (error) {
    console.error('ABC Desk: render failed', error);
    scoreElement.replaceChildren(...previousNodes);
    showUnavailableScore('render-failed');
    return false;
  }
}

function showUnavailableScore(reason: string): void {
  contentStatusKey = reason;
  if (hasRenderedScore) {
    contentDetail = `${t('stale-score')} ${referenceLabel}`;
    keyboardView.clearActivePitches();
  } else {
    scoreElement.textContent = '';
    keyboardView.clear();
  }
  playable = false;
  activeInput = undefined;
  controller.setTune(undefined);
  showRevealSource = true;
  updateContentStatus();
}

/** Whether the score has displayable notes (empty-state criterion, SPEC-STATE-05): rests are also note entries, so an all-rest score is not an empty file. */
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

/** Linkage state is rebuilt with the render (SPEC-PLAY-11): mapping, target and follow state are all cleared, and a new mapping is built after success. */
function resetLinkageState(): void {
  timingEvents = [];
  applyTarget(null); // Target cleared: marks, keyboard reflection and button state are rebuilt with the render (SPEC-PLAY-11 / 12 / 15)
  setMarkerClass(playingElements, 'abcdesk-playing', false);
  playingElements = [];
  followPaused = false;
  keyboardView.clearActivePitches(); // Version switch / re-render clears the keyboard's dynamic hints (SPEC-STATE-03)
}

/** Add / remove a mark class on a batch of elements (SPEC-PLAY-11); CSS handles the presentation, removing the class restores the original style. */
function setMarkerClass(elements: SVGElement[], className: string, on: boolean): void {
  for (const element of elements) {
    element.classList.toggle(className, on);
  }
}

/** Extract the score DOM elements of a timing event (elements is the flattened original elemset). */
function elementsOf(event: NoteTimingEvent): SVGElement[] {
  return eventGroups(event).flat();
}

/**
 * Char offset -> performance timing event (SPEC-PLAY-11 / 12): char ranges are half-open (abcjs convention);
 * a note that occurs several times through repeats takes its first occurrence in performance order (P02 resolution, see docs/decisions.md).
 */
function findTimingEvent(offset: number): NoteTimingEvent | undefined {
  return activeInput === undefined ? undefined : sourceEvent(timingEvents, activeInput, offset);
}

/** Playback highlighting reports back only contiguous, reliable source ranges of the current tune. */
function sourceRangesOf(event: NoteTimingEvent): SourceHighlightRange[] {
  return activeInput === undefined ? [] : sourceRanges(event, activeInput).slice(0, 16);
}

/**
 * Report the current target's source range (SPEC-PLAY-11): the host syncs the editor-side outline decoration from it;
 * skipped while linkage is suspended (pending update / old score reference) - the host already cleared the outline on content change, so no old mapping is applied.
 */
function syncTargetSourceRanges(ranges: SourceHighlightRange[]): void {
  if (linkageUnavailableReason() !== undefined) {
    return;
  }
  const serialized = JSON.stringify(ranges);
  if (serialized === sentTargetRanges) {
    return;
  }
  sentTargetRanges = serialized;
  post({ type: 'target-ranges', ranges });
}

/** Whether linkage is in its suspension window (SPEC-PLAY-11): no locating / starting while a new version is pending or the current score is an old reference; read-only source pages are equally unavailable. */
function linkageUnavailableReason(): LinkageUnavailableReason | undefined {
  if (isReadOnlySource()) return 'stale-score';
  if (pendingDocument !== undefined || session.selectionRequest !== undefined) return 'update-pending';
  if (session.selected === null) return session.catalog.initialBlocked ? 'structure-unreliable' : 'choose-tune';
  if (!session.current?.reliable) return 'structure-unreliable';
  return playable ? undefined : 'stale-score';
}

/** Click on a score note (SPEC-PLAY-11 / 12): set it as the target and request source locating; focus stays in the preview, the playback position is unchanged, no extra sound. */
function handleScoreClick(abcElem: AbcElem): void {
  const startChar = abcElem.startChar;
  const endChar = abcElem.endChar;
  if (abcElem.el_type !== 'note' || startChar === undefined || endChar === undefined) {
    // Clicked a non-note element (bar line, clef, ...): clear the target (marks, keyboard reflection and button in sync) and request no locating (no valid mapping)
    applyTarget(null);
    return;
  }
  const unavailable = linkageUnavailableReason();
  if (unavailable !== undefined) {
    post({ type: 'linkage-unavailable', reason: unavailable });
    return;
  }
  const range = activeInput === undefined ? undefined : toSourceRange(activeInput, startChar, endChar);
  if (range === undefined) { applyTarget(null); return; }
  applyTarget(range.start);
  post({ type: 'reveal-range', requestId: ++sourceRequestSequence, ...range });
}

/** Shared "play from here" path (SPEC-PLAY-12): explains the reason when the mapping is unreliable or linkage is suspended, never quietly plays from the beginning. */
function playFromOffset(offset: number): void {
  const unavailable = linkageUnavailableReason();
  if (unavailable !== undefined) {
    post({ type: 'linkage-unavailable', reason: unavailable });
    return;
  }
  const event = findTimingEvent(offset);
  if (event === undefined) {
    post({ type: 'linkage-unavailable', reason: 'no-mapping' });
    return;
  }
  controller.playFromMs(event.milliseconds);
}

/** Play from the source cursor (SPEC-PLAY-12): the offset comes from the host push and the mapping is done inside the webview; read-only source pages accept no start. */
function startFromCursor(offset: number): void {
  if (isReadOnlySource()) { post({ type: 'linkage-unavailable', reason: 'stale-score' }); return; }
  if (pendingDocument !== undefined) { post({ type: 'linkage-unavailable', reason: 'update-pending' }); return; }
  const candidate = tuneAtSource(session.catalog, offset);
  if (candidate === undefined || !validateSourceTarget(candidate, offset)) {
    // A later invalid request still takes over an old intent that has not sounded yet, but does not interrupt music already playing validly.
    if (session.selectionRequest !== undefined) playbackAction('pause');
    else if (controller.getStatus().phase === 'preparing') controller.pause();
    post({ type: 'linkage-unavailable', reason: candidate === undefined && session.catalog.issues.some((range) => offset >= range.start && offset < range.end) ? 'structure-unreliable' : 'no-mapping' });
    return;
  }
  // Do not stop currently valid music before validation completes; only on success cancel the old selection and commit the target tune.
  rememberSettings();
  session.cancelSelection();
  if (candidate.index !== session.selected || !playable) {
    session.select(candidate.index);
    if (currentDocument !== undefined) renderAndReport(currentDocument, true);
  }
  applyReadingMarker(offset);
  playFromOffset(offset);
}

/** Play from the current target note (SPEC-PLAY-12 / CMD-08): the target is maintained by click or inspection; without a target the reason is reported. */
function startFromTarget(): void {
  if (targetOffset === null) {
    const unavailable = linkageUnavailableReason();
    post({ type: 'linkage-unavailable', reason: unavailable ?? 'no-selection' });
    return;
  }
  playFromOffset(targetOffset);
}

/**
 * Inspection cursor (SPEC-PLAY-11 / 12): a note hit becomes the current target; leaving the note / sitting in another tune clears the target,
 * without automatic tune switching or reusing the current tune's mapping.
 */
function applyReadingMarker(offset: number | null): void {
  applyTarget(offset !== null && findTimingEvent(offset) !== undefined ? offset : null);
}

/**
 * Set / clear the current target note (SPEC-PLAY-11 / 12 / 15): preview clicks and source cursor hits maintain the same target,
 * latest wins; fill and dashed box, keyboard reflection and "play from here" availability sync with the target.
 * When the offset has no reliable mapping (old score reference, waiting for a re-render after a click) no mark is shown but the target is kept, and the button explains the reason.
 */
function applyTarget(offset: number | null): void {
  if (targetOffset !== offset) pendingTargetRequest = undefined;
  clearTargetMarks();
  targetOffset = offset;
  const event = offset === null ? undefined : findTimingEvent(offset);
  // The editor-side outline syncs with the target (SPEC-PLAY-11): the host draws the outline from the reported range, an empty array is reported when the target is cleared
  syncTargetSourceRanges(event === undefined ? [] : sourceRangesOf(event));
  if (event === undefined) {
    keyboardView.clearPointedPitches();
    updatePlayFromHereButton();
    return;
  }
  targetElements = elementsOf(event);
  setMarkerClass(targetElements, 'abcdesk-target', true);
  drawReadingBoxes(event);
  // Keyboard reflection (SPEC-PLAY-15): shares the target's mapping and highlights the matching keys in the inspection color
  keyboardView.setPointedPitches(collectPitches([event]));
  updatePlayFromHereButton();
  if (controller.getStatus().phase !== 'playing') {
    // Bring an invisible target into view; during playback only update the mark without fighting the playback follow scroll (SPEC-PLAY-11)
    scrollIntoViewIfNeeded(targetElements);
  }
}

/**
 * Clear the old target marks (SPEC-PLAY-11 / 12): fill, dashed box and element references are cleared together;
 * abcjs native selection is added by the click itself and is not removed when the target moves, and it is more than a class: native click selection writes the fill color straight into the note's
 * presentation attribute, which stays in effect after the class is removed - restore it from the render snapshot as well so the old note keeps no residue.
 */
function clearTargetMarks(): void {
  clearReadingBoxes();
  for (const element of scoreElement.querySelectorAll('.abcdesk-target, .abcjs-note_selected')) {
    element.classList.remove('abcdesk-target', 'abcjs-note_selected');
    restoreNativePaint(element);
  }
  targetElements = [];
}

/** Record the original fill attribute of score elements (SPEC-PLAY-11): called after a successful render and before any click happens. */
function snapshotNativePaint(): void {
  nativeFillSnapshot = new WeakMap();
  for (const element of scoreElement.querySelectorAll('*')) {
    nativeFillSnapshot.set(element, element.getAttribute('fill'));
  }
}

/** Restore fill attributes overwritten by abcjs native click selection (SPEC-PLAY-11): an element missing from the snapshot (added after render) is treated as never having had the attribute. */
function restoreNativePaint(element: Element): void {
  const fill = nativeFillSnapshot.get(element);
  if (fill === null || fill === undefined) {
    element.removeAttribute('fill');
  } else {
    element.setAttribute('fill', fill);
  }
}

/** Remove all inspection boxes (SPEC-PLAY-11). */
function clearReadingBoxes(): void {
  for (const box of readingBoxes) {
    box.remove();
  }
  readingBoxes = [];
}

/** Gap between the inspection box and the note (layout pixels). */
const READING_BOX_PADDING = 3;

/**
 * Draw inspection boxes (SPEC-PLAY-11): overlay dashed boxes generated from the screen bounding boxes of note clusters;
 * the overlay stays out of abcjs's SVG nodes and CSS disables hit testing, so click detection is unaffected.
 */
function drawReadingBoxes(event: NoteTimingEvent): void {
  const container = scoreElement.getBoundingClientRect();
  for (const group of eventGroups(event)) {
    const rect = unionRect(group);
    if (rect === undefined) {
      continue;
    }
    const box = document.createElement('div');
    box.className = 'abcdesk-reading-box';
    box.style.left = `${rect.left - container.left - READING_BOX_PADDING}px`;
    box.style.top = `${rect.top - container.top - READING_BOX_PADDING}px`;
    box.style.width = `${rect.right - rect.left + READING_BOX_PADDING * 2}px`;
    box.style.height = `${rect.bottom - rect.top + READING_BOX_PADDING * 2}px`;
    scoreElement.appendChild(box);
    readingBoxes.push(box);
  }
}

/**
 * Redraw the target dashed boxes after the panel resizes (SPEC-PLAY-11): abcjs responsive mode scales the SVG purely in CSS by container width
 * without re-layout, so the overlay's pixel geometry must be re-measured from the current elements or it drifts away from the notes.
 */
function refreshReadingBoxes(): void {
  if (targetOffset === null) {
    return;
  }
  const event = findTimingEvent(targetOffset);
  if (event === undefined) {
    return;
  }
  clearReadingBoxes();
  drawReadingBoxes(event);
}

/** Group a timing event's elements into note clusters (SPEC-PLAY-11): a chord is one group, each cluster of an expanded tie is its own group. */
function eventGroups(event: NoteTimingEvent): SVGElement[][] {
  const groups: SVGElement[][] = [];
  for (const group of event.elements ?? []) {
    const members: SVGElement[] = [];
    for (const element of group) {
      if (element instanceof SVGElement) {
        members.push(element);
      }
    }
    if (members.length > 0) {
      groups.push(members);
    }
  }
  return groups;
}

/**
 * Playback highlighting (SPEC-PLAY-11): score recoloring, source highlight report and follow scrolling when outside the viewport;
 * a null event (end / stop / version switch) clears both highlights.
 */
function applyPlayingHighlight(event: NoteTimingEvent | null): void {
  setMarkerClass(playingElements, 'abcdesk-playing', false);
  playingElements = [];
  if (event === null || event.type !== 'event') {
    keyboardView.setActivePitches([]);
    post({ type: 'source-highlight', ranges: [] });
    return;
  }
  playingElements = elementsOf(event);
  setMarkerClass(playingElements, 'abcdesk-playing', true);
  // Keyboard hints follow the notated material's performance time, including muted voices (SPEC-PLAY-09); outside the viewport only direction arrows are shown (SPEC-PLAY-08)
  keyboardView.setActivePitches(collectPitches([event]));
  // The source is only highlighted, not scrolled and the cursor is not moved; the host decorates visible editors (SPEC-PLAY-11)
  if (linkageUnavailableReason() === undefined) post({ type: 'source-highlight', ranges: sourceRangesOf(event) });
  if (!followPaused) {
    scrollIntoViewIfNeeded(playingElements);
  }
}

/**
 * Scroll a score element into view when it leaves the visible area (SPEC-PLAY-11); programmatic scrolling does not count as a "manual scroll".
 * The viewport bottom excludes the keyboard dock height: the bottom-stuck keyboard is not visible area, so following never scrolls a note under the keyboard.
 */
function scrollIntoViewIfNeeded(elements: SVGElement[]): void {
  const rect = unionRect(elements);
  if (rect === undefined) {
    return;
  }
  const margin = 32;
  // Reserve the actual top bar height at the top (updated when wrapping makes it taller): after scrolling the note is not hidden behind the sticky controls
  const viewTop = topbarElement.offsetHeight;
  const viewBottom = window.innerHeight - keyboardSection.offsetHeight;
  if (rect.bottom > viewBottom - margin) {
    window.scrollBy({ top: rect.bottom - viewBottom + margin });
  } else if (rect.top < viewTop + margin) {
    window.scrollBy({ top: rect.top - viewTop - margin });
  }
}

/** Screen bounding box of a set of elements; undefined when all are empty shapes (e.g. invisible rests). */
function unionRect(
  elements: SVGElement[],
): { left: number; top: number; right: number; bottom: number } | undefined {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (left > right || top > bottom) {
    return undefined;
  }
  return { left, top, right, bottom };
}

/** Navigation keys for follow scrolling (SPEC-PLAY-11): scrolling caused by these keys counts as a manual scroll. */
const FOLLOW_SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);

/** The user scrolled the score manually during playback: pause auto-follow and offer an explicit resume entry (SPEC-PLAY-11). */
function pauseFollowOnUserScroll(): void {
  if (controller.getStatus().phase !== 'playing' || followPaused) {
    return;
  }
  followPaused = true;
  updateFollowResumeButton();
}

/** "Resume following" entry (SPEC-PLAY-11): shown while playing after a manual scroll; fixed position so it stays usable when the controls scroll out of view. */
function updateFollowResumeButton(): void {
  const visible = followPaused && controller.getStatus().phase === 'playing';
  followResumeButton.hidden = !visible;
  if (!visible) {
    return;
  }
  followResumeButton.textContent = t('resume-follow');
  followResumeButton.setAttribute('aria-label', t('resume-follow'));
}

/**
 * "Play from here" button (SPEC-PLAY-12): starts from the current target note and shares the host path with the command;
 * disabled without a target note, with a pending update or with an old score reference; the reason is shown through the wrapper element (a disabled button does not trigger its own tooltip);
 * the reason reflects the actual suspension state: linkage suspension takes precedence over the no-target hint.
 */
function updatePlayFromHereButton(): void {
  const label = t('play-from-here');
  playFromHereButton.textContent = label;
  playFromHereButton.setAttribute('aria-label', label);
  const reasonKey =
    linkageUnavailableReason() ?? (targetOffset === null ? 'select-note-first' : undefined);
  const reason = reasonKey === undefined ? undefined : t(reasonKey);
  playFromHereButton.disabled = reason !== undefined;
  if (reason === undefined) {
    playFromHereWrap.removeAttribute('title');
  } else {
    playFromHereWrap.setAttribute('title', reason);
  }
}

/**
 * Host document push (SPEC-STATE-07 / LIFE-03 / 07):
 * - a document push received by a read-only status page counts as source recovery: lift the read-only lock first, then apply under the regular rules;
 * - continued (reliable migration): same content only updates the source identity and keeps position, settings and mapping;
 *   changed content first aligns the same practice identity, then applies under the regular version switch rules;
 * - everything else follows the existing rules: old version / cross-document dropped, same snapshot only reported, cached while playing.
 */
function handleDocumentMessage(message: DocumentMessage): void {
  const readOnly = isReadOnlySource();
  if (currentDocument !== undefined && message.viewId !== currentDocument.viewId) return;
  const migrating = !readOnly && currentDocument !== undefined && message.continued === true;
  if (!readOnly && !migrating && currentDocument !== undefined &&
      (message.uri !== currentDocument.uri || message.revision < (pendingDocument ?? currentDocument).revision)) return;
  if (readOnly) releaseSourceLock();
  if (migrating && currentDocument !== undefined) {
    session.rekey(message.uri);
    if (pendingDocument !== undefined) pendingDocument = { ...pendingDocument, uri: message.uri };
    if (pendingDocument === undefined && session.selectionRequest === undefined && message.abc === currentDocument.abc) {
      // Unchanged content: keep paused position, settings and mapping, update only the source identity (SPEC-LIFE-03)
      currentDocument = { ...currentDocument, uri: message.uri, fileName: message.fileName, isUntitled: message.isUntitled };
      return;
    }
  }
  if (!readOnly && sameSnapshot(session.snapshot, message)) {
    if (session.selectionRequest === undefined) reportRendered();
    return;
  }
  const phase = controller.getStatus().phase;
  if (phase === 'playing' || phase === 'preparing' || session.selectionRequest !== undefined) {
    pendingDocument = message;
    session.receive(message, true);
    contentStatusKey = session.selectionRequest === undefined ? 'update-pending' : 'switching-tune';
    showRevealSource = false;
    applyTarget(null);
    updateContentStatus();
    return;
  }
  renderAndReport(message);
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = parseHostMessage(event.data);
  if (message === undefined) return;
  if (message.type === 'document') {
    handleDocumentMessage(message);
    return;
  }
  if (message.type === 'source-state') {
    const expected = currentDocument?.viewId ?? context?.viewId;
    if (expected !== undefined && message.viewId !== expected) return;
    sourceStateViewId = message.viewId;
    applySourceState(message.state, message.detail);
    return;
  }
  if (message.type === 'selection-snapshot') {
    if (message.viewId !== context?.viewId || message.document.uri !== currentDocument?.uri) return;
    const latest = pendingDocument !== undefined && pendingDocument.revision > message.document.revision ? pendingDocument : message.document;
    if (!session.completeSelection(message.requestId, latest)) return;
    renderAndReport(latest, true);
    return;
  }
  if (message.type === 'playback') {
    if (message.viewId !== context?.viewId || message.requestId <= lastHostRequest) return;
    if (message.action === 'toggle' && !sameContext(context, message.context)) return;
    lastHostRequest = message.requestId;
    playbackAction(message.action);
    return;
  }
  if (!sameContext(context, message.context)) return;
  if (message.type === 'cursor') {
    if (linkageUnavailableReason() === undefined) applyReadingMarker(message.offset);
    return;
  }
  if (message.requestId <= lastHostRequest) return;
  if (message.type === 'play-from-selection' && message.targetRequestId !== undefined && message.targetRequestId !== pendingTargetRequest) return;
  pendingTargetRequest = undefined;
  lastHostRequest = message.requestId;
  if (message.type === 'play-from-cursor') startFromCursor(message.offset);
  else startFromTarget();
});

// Loop toggle (SPEC-PLAY-03): toggling does not change the current playback phase; takes effect at the next natural end boundary
loopButton.addEventListener('click', () => controller.setLoopEnabled(!controller.getLoopEnabled()));
playButton.addEventListener('click', () => playbackAction('toggle'));
stopButton.addEventListener('click', () => playbackAction('stop'));
// "Play from here" (SPEC-PLAY-12): ask the host to start through the command path (flush pending document updates first, failure explanation reuses the command path)
playFromHereButton.addEventListener('click', () => {
  pendingTargetRequest = ++sourceRequestSequence;
  post({ type: 'play-from-selection-request', requestId: pendingTargetRequest });
});
// Empty state "go to source" entry (SPEC-STATE-05): ask the host to open the source document and move focus
revealSourceButton.addEventListener('click', () => { if (context !== undefined) host.postMessage({ type: 'reveal-source', viewId: context.viewId }); });
// Migration status page "open the migrated preview" entry (SPEC-LIFE-04): the target is decided by the host's record, the webview sends only the instance number
revealTargetButton.addEventListener('click', () => { host.postMessage({ type: 'reveal-target', viewId: context?.viewId ?? sourceStateViewId }); });
// "View problems" (SPEC-STATE-06): ask the host to open Problems only on user click, no automatic popup, no focus stealing
viewProblemsButton.addEventListener('click', () => { if (context !== undefined) host.postMessage({ type: 'show-problems', viewId: context.viewId }); });
// "Resume following" (SPEC-PLAY-11): return to the current playback position immediately and resume auto-follow
followResumeButton.addEventListener('click', () => {
  followPaused = false;
  updateFollowResumeButton();
  scrollIntoViewIfNeeded(playingElements);
});

// Speed control (SPEC-PLAY-04 / P06): Enter / blur / native stepping commit, Esc cancels editing and restores the current value
speedInputElement.addEventListener('change', commitSpeedInput);
speedInputElement.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitSpeedInput();
  } else if (event.key === 'Escape') {
    speedInputElement.value = String(controller.getSpeed());
  }
});
speedResetButton.addEventListener('click', () => controller.setSpeed(SPEED_DEFAULT));
// Voices menu (SPEC-PLAY-06): pause first before adjusting during playback
voicesPauseButton.addEventListener('click', () => playbackAction('pause'));
// Esc closes the menu and returns focus to the trigger (SPEC-A11Y-05)
voicesMenuElement.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || !voicesMenuElement.open) {
    return;
  }
  voicesMenuElement.open = false;
  voicesSummaryElement.focus();
});
// Right-edge constraint of the panel (SPEC-PLAY-13): if it overflows the viewport's right edge when opened, flip to right alignment (max width in CSS)
voicesMenuElement.addEventListener('toggle', () => {
  voicesPanelElement.style.removeProperty('left');
  voicesPanelElement.style.removeProperty('right');
  if (!voicesMenuElement.open) {
    return;
  }
  const rect = voicesPanelElement.getBoundingClientRect();
  if (rect.right > document.documentElement.clientWidth - 8) {
    voicesPanelElement.style.left = 'auto';
    voicesPanelElement.style.right = '0';
  }
});
// More menu (SPEC-SET-07): Esc closes and returns focus to the trigger; flips when overflowing the right edge
moreMenuElement.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || !moreMenuElement.open) {
    return;
  }
  moreMenuElement.open = false;
  moreSummaryElement.focus();
});
moreMenuElement.addEventListener('toggle', () => {
  morePanelElement.style.removeProperty('left');
  morePanelElement.style.removeProperty('right');
  if (!moreMenuElement.open) {
    return;
  }
  const rect = morePanelElement.getBoundingClientRect();
  if (rect.right > document.documentElement.clientWidth - 8) {
    morePanelElement.style.left = 'auto';
    morePanelElement.style.right = '0';
  }
});
resetPracticeButton.addEventListener('click', resetPractice);
// Progress bar (SPEC-PLAY-05): drag previews, release commits; cancelling the drag (Esc / pointercancel) does not commit
progressElement.addEventListener('pointerdown', (event: PointerEvent) => {
  if (event.button !== 0 || !playable) {
    return;
  }
  event.preventDefault(); // Dragging does not trigger text selection; focus is moved explicitly to the thumb (P06: arrow keys usable immediately)
  dragState = {
    fraction: progressFractionFromPointer(event.clientX),
    phase: controller.getStatus().phase,
    sequence: renderSequence,
  };
  progressElement.setPointerCapture(event.pointerId);
  progressElement.classList.add('abcdesk-dragging'); // Drag feedback (SPEC-PLAY-05): thicker thumb and track
  progressElement.focus();
  previewDrag(dragState.fraction);
});
progressElement.addEventListener('pointermove', (event: PointerEvent) => {
  if (dragState === undefined) {
    return;
  }
  dragState.fraction = progressFractionFromPointer(event.clientX);
  previewDrag(dragState.fraction);
});
progressElement.addEventListener('pointerup', (event: PointerEvent) => {
  const drag = dragState;
  dragState = undefined;
  progressElement.classList.remove('abcdesk-dragging');
  if (drag === undefined) {
    return;
  }
  if (progressElement.hasPointerCapture(event.pointerId)) {
    progressElement.releasePointerCapture(event.pointerId);
  }
  commitDrag(drag);
});
progressElement.addEventListener('pointercancel', () => {
  if (dragState === undefined) {
    return;
  }
  dragState = undefined; // Drag cancelled: no commit, display returns to the actual position
  progressElement.classList.remove('abcdesk-dragging');
  updateProgressUi();
});
progressElement.addEventListener('keydown', (event: KeyboardEvent) => {
  if (!playable) return;
  if (dragState !== undefined) {
    if (event.key === 'Escape') {
      dragState = undefined;
      progressElement.classList.remove('abcdesk-dragging');
      updateProgressUi();
      event.preventDefault();
    }
    return; // While dragging the pointer position leads; keyboard seeking is not layered on top
  }
  const { positionMs, totalMs } = controller.getProgress();
  const current = totalMs > 0 ? positionMs / totalMs : 0;
  let next: number;
  switch (event.key) {
    case 'ArrowLeft':
      next = current - 0.01;
      break;
    case 'ArrowRight':
      next = current + 0.01;
      break;
    case 'PageDown':
      next = current - 0.1;
      break;
    case 'PageUp':
      next = current + 0.1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  controller.seekToFraction(next); // Keyboard and click share the same commit path (P06): every key press seeks immediately
  updateProgressUi();
});

// On panel resize the score scales with the container width (abcjs responsive mode does not re-layout): redraw the overlay inspection boxes to keep them attached (SPEC-PLAY-11)
new ResizeObserver(() => refreshReadingBoxes()).observe(scoreElement);

// The keyboard dock height drives the floating entry's bottom offset: keeps "resume following" from covering the keyboard
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--abcdesk-dock-height', `${keyboardSection.offsetHeight}px`);
}).observe(keyboardSection);

// Manual scroll detection (SPEC-PLAY-11): scroll events are also fired by programmatic scrolling, so only user input is listened to
window.addEventListener('wheel', pauseFollowOnUserScroll, { passive: true });
window.addEventListener('touchmove', pauseFollowOnUserScroll, { passive: true });
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (!FOLLOW_SCROLL_KEYS.has(event.key)) {
    return;
  }
  const target = event.target as HTMLElement | null;
  // PageUp / PageDown / Home / End on the progress bar are seek operations (SPEC-PLAY-05), not manual scrolling
  if (target !== null && (target.closest('input, textarea, select, #progress') !== null || target.isContentEditable)) {
    return;
  }
  pauseFollowOnUserScroll();
});

// Space inside the preview shares the operation rules of buttons and commands (SPEC-CMD-11); on interactive elements such as buttons Space keeps its native behavior
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== ' ' || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const target = event.target as HTMLElement | null;
  // summary is an interactive element (SPEC-PLAY-06 menu toggle); Space keeps native expand / collapse
  if (target !== null && (target.closest('button, input, textarea, select, a, summary') !== null || target.isContentEditable)) {
    return;
  }
  event.preventDefault();
  playbackAction('toggle');
});

// Silence immediately and stop progress polling before the panel is destroyed (hiding with retained context does not reach here)
window.addEventListener('pagehide', () => {
  session.cancelSelection();
  context = undefined;
  renderSequence += 1;
  if (progressTimer !== undefined) {
    window.clearInterval(progressTimer);
    progressTimer = undefined;
  }
  controller.dispose();
});

// Accessible name of the progress bar (SPEC-PLAY-05 / P06 gauge)
progressElement.setAttribute('aria-label', t('progress-label'));
// More menu text (SPEC-SET-07): the reset entry affects only this file and explains that the source file is not modified
moreSummaryElement.textContent = t('more');
resetPracticeButton.textContent = t('reset-practice');
resetPracticeButton.setAttribute('aria-label', t('reset-practice'));
resetPracticeNoteElement.textContent = t('reset-practice-note');

refreshPlaybackUi();
updateContentStatus();
// Ready handshake: the host pushes the current document content once it receives ready
host.postMessage({ type: 'ready' });
