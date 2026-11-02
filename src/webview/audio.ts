import {
  synth,
  TimingCallbacks,
  type AudioTracks,
  type MidiBuffer,
  type NoteMapTrack,
  type NoteTimingEvent,
  type SynthOptions,
  type TuneObject,
} from 'abcjs';
import { defaultMusicSettings, type MusicSettings } from '../core/tuneSession';
import {
  SPEED_DEFAULT,
  beatHintFor,
  clampSpeed,
  collectVoices,
  hasChordTrack,
  pianoOnlyTuneView,
  type VoiceEntry,
} from './playback';

/**
 * Playback engine (SPEC-PLAY-01 / 02 / 03 / 04 / 05 / 06 / 11 / 12 / 14, SPEC-STATE-04 / 07, SPEC-PERF-06 / 08, SPEC-ENV-07):
 * - render the score first and prepare audio only on the first explicit play; once prepared, the still-valid request runs directly without a second click;
 * - play / pause again during preparation (including pauses triggered by hiding or preview takeover) cancels the start; a late completion must never sound;
 * - stop silences immediately and returns to the beginning; pause keeps the position; with loop on, a natural end wraps and continues without a version switch (SPEC-PLAY-03);
 *   prepared resources are reusable (this class's synth + the abcjs internal soundfont cache);
 * - caching of content updates and the unified apply moment are coordinated by main (SPEC-STATE-07); this class adopts the new tune via setTune and resets to zero;
 * - performance timing (TimingCallbacks) and audio start together from the same source: event callbacks let main update playback highlighting,
 *   setProgress + seek complete positioning as a pair (SPEC-PLAY-11 / 12; same synchronization as the official SynthController);
 * - browsers require user interaction with the preview before the audio device can resume: before interaction show "click the preview to start playback",
 *   never time out while waiting, and after the first interaction continue the still-valid start automatically (SPEC-PLAY-14);
 * - first version is piano only: the playback view unifies the expansion's instrument instructions to piano (the expansion decides both the soundfont requests and
 *   the actual placement; the original tune object keeps the material's instructions for export, SPEC-ENV-07 / EXP-05), and the sequence mapping is
 *   finalized by sequenceCallback, never hitting the abcjs default remote soundfont URL.
 *
 * Speed and mutes (SPEC-PLAY-02 / 04 / 06):
 * - the speed percentage is the master control: timing is rebuilt via warpedQpm (event milliseconds scale with speed) and audio via the top-level
 *   millisecondsPerMeasure, both based on the tune's natural tempo without parameters (same as the official abcjs go(), fixing the
 *   audio / timing baseline divergence for compound meters without Q:); the position is always kept as a tune fraction (actual performance order including repeats);
 * - voice mutes take effect through a rebuild with voicesOff / chordsOff and affect only sounding tracks, not the score or keyboard hints;
 * - a parameter rebuild does not change the phase: during playback it continues the current snapshot after completion (status shows "applying speed"),
 *   when paused / idle it rebuilds silently (the user plays manually); pause, stop, hide, close or playback takeover during the rebuild cancels the resume;
 * - abcjs programmatic source stops (seek / rebuild / stop / pause) share the onEnded callback with the natural end:
 *   rebuilds and in-playback seeks are excluded via the pendingEndedIgnores counter, the rest is guarded by the phase;
 *   after a natural end abcjs does not clear isRunning (zombie running state), so this class stops it explicitly.
 *
 * Used only inside the webview (browser environment); host communication goes through main.ts over the message bridge (see docs/conventions.md).
 */

export type PlaybackPhase = 'idle' | 'preparing' | 'playing' | 'paused';

/** Current phase and status-area string key (strings live in l10n.ts and are rendered by main). */
export interface PlaybackStatus {
  phase: PlaybackPhase;
  statusKey: string | null;
}

/** Upper bound of the preparation phase: on timeout the request is terminated and a late completion must not sound; the clock does not run while waiting for user interaction (SPEC-PERF-06 / PLAY-14; threshold to be calibrated by SPEC-PERF-10). */
const PREPARE_TIMEOUT_MS = 30_000;

/**
 * Recovery window after the first interaction (SPEC-PLAY-14): an old task that entered buffer generation may be stuck on audio resume,
 * so give it a window to recover on its own; if still unfinished, restart preparation (soundfont cache hit, cheap).
 */
const GESTURE_RECOVERY_MS = 300;

/** First version is piano only (SPEC-ENV-07). */
const PIANO_INSTRUMENT = 'acoustic_grand_piano';

/** One audio preparation task; primeStarted means buffer generation has begun (it may wait on audio resume from here on, SPEC-PLAY-14). */
interface PrepareTask {
  primeStarted: boolean;
}

/** In-progress state of a parameter (speed / mute) rebuild (SPEC-PLAY-02 / 04 / 06): the recorded tune fraction is restored on completion. */
interface RebuildState {
  generation: number;
  /** Target position: tune fraction (actual performance order including repeats), updated by seek requests during the rebuild. */
  fraction: number;
  /** Whether to resume after completion (true when started during playback; cancelled by pause, hide or stop in the meantime). */
  resume: boolean;
}

export class PlaybackController {
  private readonly soundfontUrl: string | undefined;
  private readonly onChange: () => void;
  private readonly onTimeline: (event: NoteTimingEvent | null) => void;
  /** Notification after a timing rebuild (SPEC-PLAY-04): main re-fetches getTimings (event milliseconds change with speed). */
  private readonly onTimingsChanged: () => void;
  private readonly synthOptions: SynthOptions;
  private synthInstance: MidiBuffer | undefined;
  /** Not-yet-installed init/prime instances are also cleaned up on cancel, not just the Promise results dropped. */
  private preparingInstance: MidiBuffer | undefined;
  private tune: TuneObject | undefined;
  private phase: PlaybackPhase = 'idle';
  private statusKey: string | null = null;
  /** Performance timing of the current tune (SPEC-PLAY-11 / 12): shared basis for playback highlighting and seek mapping; rebuilt on version switch and speed change. */
  private timer: TimingCallbacks | undefined;
  /** Pending start position (tune fraction, SPEC-PLAY-12): playback starts there once prepared; dropped on cancel / stop / consumption. */
  private pendingStartFraction: number | undefined;
  /** The current tune's audio buffers are fully generated and start() can be called directly ("prepared resources are reusable", SPEC-PLAY-01). */
  private prepared = false;
  /** Task generation: incremented on cancel / takeover / version switch / timeout; late preparation completions are dropped by it (SPEC-PLAY-01). */
  private taskGeneration = 0;
  /** Tune and timer lifecycles are independent of the reusable audio preparation request. */
  private tuneGeneration = 0;
  private timerGeneration = 0;
  private prepareTimer: number | undefined;
  /** Self-managed audio device: browsers require user interaction before resume (SPEC-PLAY-14); created once and passed to abcjs via init. */
  private audioContext: AudioContext | undefined;
  /** Whether a user interaction has happened inside the preview (precondition for platform audio resume, SPEC-PLAY-14). */
  private hasUserGesture = false;
  /** Current preparation task: used on first interaction to decide whether the old task already entered the buffering stage. */
  private currentTask: PrepareTask | undefined;
  /** Recovery window timer after the first interaction; the first-interaction listener is removed once fired. */
  private gestureRecoveryTimer: number | undefined;
  private gestureUnlock: (() => void) | undefined;
  /** Speed percentage (SPEC-PLAY-04): default 100%, master control for timing and audio rebuilds. */
  private speed = SPEED_DEFAULT;
  /** Loop toggle (SPEC-PLAY-03): default off; kept on stop, restored on tune switch / version switch after the session layer verifies identity. */
  private loopEnabled = false;
  /** Set of muted voice indexes (SPEC-PLAY-06): only accepts overrides verified by the session layer against the full voice signature. */
  private readonly mutedVoices = new Set<number>();
  /** Whether the automatic chord accompaniment is muted (SPEC-PLAY-06): independent of explicit ABC accompaniment voices. */
  private chordsMuted = false;
  /** Actual voice list of the current tune (SPEC-PLAY-06): rebuilt on version switch. */
  private voiceEntries: VoiceEntry[] = [];
  /** Whether an automatic chord accompaniment exists (SPEC-PLAY-06 / 10): detected on the expansion without mute parameters, unaffected by the current mute state. */
  private chordTrackPresent = false;
  /** In-progress parameter rebuild; the phase stays unchanged during the rebuild and this state records target position and resume intent. */
  private rebuild: RebuildState | undefined;
  /**
   * Count of natural-end events to ignore: abcjs programmatic source stops (rebuild / in-playback seek) also fire onEnded,
   * so those are counted off here and not treated as natural ends; ended events from stop / pause are guarded by the phase.
   * Increment only for a "valid running source stop" (stop in the zombie running state no longer dispatches, and counting it would jam the counter forever).
   */
  private pendingEndedIgnores = 0;

  constructor(
    options: { soundfontUrl?: string },
    onChange: () => void,
    onTimeline: (event: NoteTimingEvent | null) => void,
    onTimingsChanged: () => void,
  ) {
    this.soundfontUrl = options.soundfontUrl;
    this.onChange = onChange;
    this.onTimeline = onTimeline;
    this.onTimingsChanged = onTimingsChanged;
    this.synthOptions = {
      soundFontUrl: this.soundfontUrl,
      sequenceCallback: forcePianoInstrument,
    };
    this.installGestureUnlock();
  }

  getStatus(): PlaybackStatus {
    return { phase: this.phase, statusKey: this.statusKey };
  }

  /** Performance timing events of the current tune (for main to build the char<->note mapping, SPEC-PLAY-11 / 12); empty without a rendered tune. */
  getTimings(): NoteTimingEvent[] {
    return this.timer?.noteTimings ?? [];
  }

  /** Current speed percentage (SPEC-PLAY-04). */
  getSpeed(): number {
    return this.speed;
  }

  /** Loop toggle state (SPEC-PLAY-03). */
  getLoopEnabled(): boolean {
    return this.loopEnabled;
  }

  /** Voice list and mute state of the current tune (SPEC-PLAY-06): the list is rebuilt per tune; mutes are restored only from verified per-tune settings. */
  getVoices(): Array<VoiceEntry & { muted: boolean }> {
    return this.voiceEntries.map((entry) => ({ ...entry, muted: this.mutedVoices.has(entry.index) }));
  }

  /** Whether an automatic chord accompaniment exists (SPEC-PLAY-06): decides whether the voice menu offers the chord toggle. */
  hasChordAccompaniment(): boolean {
    return this.chordTrackPresent;
  }

  /** Whether the automatic chord accompaniment is currently muted (SPEC-PLAY-06): basis of the voice menu's checkbox state. */
  getChordsMuted(): boolean {
    return this.chordsMuted;
  }

  /** Beat hint (SPEC-PLAY-04): null when it cannot be converted reliably (the UI shows no guessed value). */
  getBeatHint(): number | null {
    const tune = this.tune;
    if (tune === undefined) {
      return null;
    }
    return beatHintFor(tune, this.speed);
  }

  /** Progress (SPEC-PLAY-05): position and total are actual performance milliseconds at the current speed (including repeats). */
  getProgress(): { positionMs: number; totalMs: number } {
    const totalMs = this.totalMs();
    return { positionMs: Math.round(totalMs * this.currentFraction()), totalMs };
  }

  /**
   * Adjust speed (SPEC-PLAY-04): percentage is the master control and only affects audition; rebuilds timing and audio while keeping the tune position (including repeats),
   * during playback a short buffering pause is allowed before continuing; when paused the rebuild is silent.
   */
  setSpeed(percent: number): void {
    const next = clampSpeed(percent);
    if (next === this.speed) {
      return;
    }
    this.speed = next;
    const tune = this.tune;
    if (tune !== undefined && this.synthInstance === undefined && this.rebuild === undefined) {
      // Without prepared audio only the timing is rebuilt; existing audio is frozen and rebuilt once by startRebuild.
      const fraction = this.currentFraction();
      this.buildTimer(tune, fraction);
      this.onTimingsChanged();
    }
    this.applyAudioParams();
    this.onChange();
  }

  /** Toggle loop (SPEC-PLAY-03): changes behavior only, never starts playback or modifies ABC; toggling during playback applies to this natural-end boundary immediately. */
  setLoopEnabled(enabled: boolean): void {
    if (this.loopEnabled === enabled) {
      return;
    }
    this.loopEnabled = enabled;
    this.onChange();
  }

  /** Mute / unmute a single voice (SPEC-PLAY-06): takes effect through a rebuild, never auto-resumes; affects only sounding tracks, not the score or hints. */
  setVoiceMuted(index: number, muted: boolean): void {
    if (!Number.isInteger(index) || index < 0) {
      return;
    }
    if (muted) {
      if (this.mutedVoices.has(index)) {
        return;
      }
      this.mutedVoices.add(index);
    } else if (!this.mutedVoices.delete(index)) {
      return;
    }
    this.applyAudioParams();
    this.onChange();
  }

  /** Mute / unmute the automatic chord accompaniment (SPEC-PLAY-06): independent of explicit ABC accompaniment voices. */
  setChordsMuted(muted: boolean): void {
    if (this.chordsMuted === muted) {
      return;
    }
    this.chordsMuted = muted;
    this.applyAudioParams();
    this.onChange();
  }

  /** Adopt the rendered tune (version switch at the apply moment, SPEC-STATE-07); when no tune has been rendered yet (undefined), clear so no stale version remains. */
  setTune(tune: TuneObject | undefined, settings?: MusicSettings): void {
    if (tune === this.tune && settings === undefined) return;
    this.invalidateTask();
    this.tuneGeneration += 1;
    this.timerGeneration += 1;
    const old = this.synthInstance;
    this.synthInstance = undefined; // Drop ownership first so an ended fired by stop, sync or async, cannot affect the new tune
    this.phase = 'idle';
    this.pendingEndedIgnores = 0;
    try { old?.stop(); } catch (error) { console.error('ABC Desk: stop on tune change failed', error); }
    const next = settings ?? defaultMusicSettings();
    this.speed = clampSpeed(next.speed);
    this.loopEnabled = next.loop;
    this.chordsMuted = next.chordsMuted;
    this.mutedVoices.clear();
    for (const index of next.mutedVoices) {
      if (Number.isSafeInteger(index) && index >= 0) this.mutedVoices.add(index);
    }
    this.adoptTune(tune);
    this.onChange();
  }

  getSettings(): MusicSettings {
    return { speed: this.speed, loop: this.loopEnabled, chordsMuted: this.chordsMuted, mutedVoices: [...this.mutedVoices] };
  }

  /**
   * Start from a given millisecond ("play from here", SPEC-PLAY-12): shares preparation, cancel and takeover rules with normal play;
   * during playback it is an internal seek followed by continuing (SPEC-PLAY-02), not a user pause and no re-preparation.
   */
  playFromMs(milliseconds: number): void {
    if (this.tune === undefined) {
      return;
    }
    this.playFromFraction(this.fractionOfMs(milliseconds));
  }

  /**
   * Seek to a tune fraction (SPEC-PLAY-05): during playback perform one seek and continue (the drag preview is handled by the UI layer);
   * when paused / idle only the next start point changes - no sound, no restart.
   */
  seekToFraction(fraction: number): void {
    if (this.tune === undefined) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, fraction));
    if (this.rebuild !== undefined) {
      // Rebuild in progress: record the target; completion lands there (the rebuild is not interrupted)
      this.rebuild.fraction = clamped;
      return;
    }
    const instance = this.synthInstance;
    if (this.phase === 'playing' && instance !== undefined) {
      if (instance.getIsRunning()) {
        // An in-playback seek first stops the source programmatically (one ended); that event is not a natural end
        this.pendingEndedIgnores += 1;
      }
      instance.seek(clamped, 'percent');
      this.timer?.setProgress(clamped, 'percent');
      return;
    }
    // Paused / idle: only change the next start point; stop a zombie running state first (abcjs does not clear isRunning after a natural end),
    // otherwise seek would start playback internally via _kickOffSound (clicking the progress bar must not restart playback)
    if (instance !== undefined) {
      if (instance.getIsRunning()) {
        try {
          instance.stop();
        } catch (error) {
          console.error('ABC Desk: stop before seek failed', error);
        }
      }
      instance.seek(clamped, 'percent');
    }
    this.pendingStartFraction = clamped;
    this.timer?.setProgress(clamped, 'percent');
  }

  /** Play / pause toggle (shared operation rule for the button, the command and the preview-local space key, SPEC-CMD-11). */
  toggle(): void {
    switch (this.phase) {
      case 'preparing':
        this.cancelPrepare();
        break;
      case 'playing':
        this.pauseInternal();
        break;
      case 'paused':
        this.startFromIdle();
        break;
      case 'idle':
        this.startFromIdle();
        break;
    }
  }

  /** Pause used by hiding and preview takeover (SPEC-PLAY-02); during preparation it counts as cancelling the start (SPEC-PLAY-01). */
  pause(): void {
    if (this.phase === 'preparing') {
      this.cancelPrepare();
      return;
    }
    if (this.phase === 'playing') {
      this.pauseInternal();
    }
  }

  /** Stop: cancel the start and any in-flight parameter rebuild, silence immediately, return to the beginning (SPEC-PLAY-03 / CMD-10). */
  stop(): void {
    this.invalidateTask();
    this.rebuild = undefined;
    this.pendingStartFraction = undefined;
    const instance = this.synthInstance;
    if (this.phase === 'playing' && instance?.getIsRunning()) this.pendingEndedIgnores += 1;
    this.phase = 'idle'; // Change the phase first: the ended event fired afterwards is not a natural end
    if (instance !== undefined) {
      try {
        instance.stop(); // Silence immediately; abcjs clears its paused position internally, next start is from the beginning
      } catch (error) {
        console.error('ABC Desk: stop failed', error);
      }
    }
    if (this.tune !== undefined) {
      this.buildTimer(this.tune, 0);
      this.onTimingsChanged();
    } else this.timer?.stop();
    this.statusKey = null;
    this.onTimeline(null); // Stop clears playback highlighting (SPEC-PLAY-11)
    this.onChange();
  }

  /** Silence immediately when the webview closes (safety net before the panel is disposed; hiding with retained context does not reach here). */
  dispose(): void {
    this.removeGestureUnlock();
    this.tuneGeneration += 1;
    this.timerGeneration += 1;
    this.invalidateTask();
    this.rebuild = undefined;
    const instance = this.synthInstance;
    this.synthInstance = undefined;
    this.prepared = false;
    this.phase = 'idle';
    this.timer?.stop();
    this.timer = undefined;
    if (instance !== undefined) {
      try {
        instance.stop();
      } catch (error) {
        console.error('ABC Desk: stop on dispose failed', error);
      }
    }
  }

  private startFromIdle(): void {
    if (this.tune === undefined) {
      return;
    }
    if (this.rebuild !== undefined) {
      // Rebuild in progress: queue the resume (starts from the recorded position after completion)
      this.rebuild.resume = true;
      this.phase = 'playing';
      this.onChange();
      return;
    }
    if (this.prepared && this.synthInstance !== undefined) {
      this.startSound(); // Prepared resources are reusable, start directly (the pending start point is consumed by startSound)
      return;
    }
    this.beginPrepare();
  }

  /** Start from a tune fraction (SPEC-PLAY-12 / 05): positions are always recorded as fractions (actual performance order including repeats). */
  private playFromFraction(fraction: number): void {
    if (this.rebuild !== undefined) {
      // Rebuild in progress: merge into the current rebuild target and queue the resume
      this.rebuild.fraction = fraction;
      this.rebuild.resume = true;
      this.phase = 'playing';
      this.onChange();
      return;
    }
    switch (this.phase) {
      case 'idle':
      case 'paused':
        if (this.prepared && this.synthInstance !== undefined) {
          this.startSound(fraction);
        } else {
          this.pendingStartFraction = fraction;
          this.beginPrepare();
        }
        break;
      case 'preparing':
        // A new explicit seek request takes over the one still preparing: the old target is not committed (SPEC-PLAY-01)
        this.cancelPrepare();
        this.pendingStartFraction = fraction;
        this.beginPrepare();
        break;
      case 'playing':
        this.seekToFraction(fraction);
        break;
    }
  }

  /**
   * Start playback (SPEC-PLAY-01 / 02 / 04): optionally from a tune fraction, otherwise consume the pending start point;
   * an in-playback seek is stopped and restarted internally by the audio layer and must not call start() again (M0 measurement: it double-sounds).
   */
  private startSound(fraction?: number): void {
    if (this.rebuild !== undefined) {
      // Rebuild in progress (e.g. the user resumes after a rebuild while paused): queue the resume after the rebuild completes
      this.rebuild.resume = true;
      this.phase = 'playing';
      this.onChange();
      return;
    }
    const instance = this.synthInstance;
    if (instance === undefined) {
      return;
    }
    const target = fraction ?? this.pendingStartFraction;
    this.pendingStartFraction = undefined;
    this.phase = 'playing';
    if (target !== undefined) {
      const wasRunning = instance.getIsRunning();
      instance.seek(target, 'percent');
      if (!wasRunning) {
        // Not running: seek only records the position; an explicit start is required
        instance.start();
      }
    } else {
      instance.start();
    }
    this.syncTimer(target);
    this.statusKey = null;
    this.onChange();
  }

  /** Synchronize the performance timing (SPEC-PLAY-11): correct progress to the seek target first, then start; same source and time as the audio. */
  private syncTimer(startFraction: number | undefined): void {
    const timer = this.timer;
    if (timer === undefined) {
      return;
    }
    if (startFraction !== undefined) {
      timer.setProgress(startFraction, 'percent');
    }
    timer.start();
  }

  private pauseInternal(): void {
    if (this.rebuild !== undefined) {
      // Rebuild in progress: cancel the resume intent and switch to paused (completion stops at the recorded position, SPEC-PLAY-02)
      this.rebuild.resume = false;
      this.phase = 'paused';
      this.statusKey = null;
      this.onChange();
      return;
    }
    const instance = this.synthInstance;
    if (instance === undefined) {
      return;
    }
    if (instance.getIsRunning()) this.pendingEndedIgnores += 1;
    this.phase = 'paused'; // Change the phase first: the ended fired by pause() stopping the source is not a natural end
    instance.pause();
    this.timer?.pause();
    this.onChange();
  }

  private cancelPrepare(): void {
    // Cancel the start: keep the last committed position (preparation commits no new position; the pending seek target is dropped as well)
    this.invalidateTask();
    this.pendingStartFraction = undefined;
    this.phase = 'idle';
    this.statusKey = null;
    this.onChange();
  }

  /** Adopt a new tune: drop the old synth, old timing and position (reset to zero); idle until the next explicit play. */
  private adoptTune(tune: TuneObject | undefined): void {
    this.synthInstance = undefined;
    this.prepared = false;
    this.rebuild = undefined;
    this.tune = tune;
    this.phase = 'idle';
    this.statusKey = null;
    this.pendingStartFraction = undefined;
    this.timer?.stop(); // Stop the old version's timing (version switch resets to zero)
    this.voiceEntries = [];
    this.chordTrackPresent = false;
    if (tune !== undefined) {
      // Fill in pitch data before building the timing: timing events clone midiPitches at construction and late fills are not back-filled (basis of keyboard range and playback highlighting)
      const flattened = this.preparePitchData(tune);
      this.voiceEntries = collectVoices(tune);
      // Chord-track detection uses the expansion without mute parameters (with chordsOff the track is absent entirely; muting only changes volume, never removes notes)
      this.chordTrackPresent =
        flattened !== undefined && hasChordTrack(flattened.tracks, this.voiceEntries.length);
      this.timer = this.createTimer(tune);
    } else {
      this.timer = undefined;
    }
    this.onTimeline(null); // Version switch clears playback highlighting (main rebuilds the mapping for the new score, SPEC-PLAY-11)
  }

  /**
   * Back-fill midiPitches on note elements and return the expansion: abcjs writes pitches onto note elements only via setUpAudio (synth / MIDI path),
   * while TimingCallbacks clones that data at construction; without a prior fill the timing events have no pitches and
   * keyboard range and playback highlighting come up empty. The expansion is used for chord accompaniment detection (pitch values are unaffected by instrument parameters).
   */
  private preparePitchData(tune: TuneObject): AudioTracks | undefined {
    try {
      return tune.setUpAudio({});
    } catch (error) {
      // Pitch data unavailable: do not block rendering or playback; only keyboard range, playback highlighting and the chord toggle are missing
      console.error('ABC Desk: audio sequence setup failed', error);
      return undefined;
    }
  }

  /** Create the current tune's performance timing (SPEC-PLAY-11 / 12): speed baseline shared with the audio, event callbacks handed to main for playback highlighting. */
  private createTimer(tune: TuneObject): TimingCallbacks | undefined {
    const generation = ++this.timerGeneration;
    try {
      return new TimingCallbacks(tune, {
        // Speed adjustment passed via qpm (SPEC-PLAY-04): event milliseconds scale with speed, consistent with the audio's milliseconds per measure
        qpm: this.warpedQpm(tune),
        eventCallback: (event) => {
          if (generation === this.timerGeneration && this.tune === tune) this.onTimeline(event);
          // Return undefined: let the timing stop itself at the end (only returning "continue" would keep going, SPEC-PLAY-03 non-loop natural end)
          return undefined;
        },
      });
    } catch (error) {
      // Timing unavailable: do not block rendering or playback; only playback highlighting is missing (main treats the missing mapping as unavailable)
      console.error('ABC Desk: timing callbacks setup failed', error);
      return undefined;
    }
  }

  /** Rebuild the performance timing at the current speed (SPEC-PLAY-04): replace the old timing and record the target fraction without starting (the start path starts it). */
  private buildTimer(tune: TuneObject, fraction: number): void {
    this.timerGeneration += 1;
    this.timer?.stop();
    this.timer = this.createTimer(tune);
    this.timer?.setProgress(fraction, 'percent');
  }

  /** Milliseconds per measure after speed adjustment (SPEC-PLAY-04): same formula as the official abcjs SynthController, based on the tune's natural tempo without parameters. */
  private warpedMillisecondsPerMeasure(tune: TuneObject): number {
    return (tune.millisecondsPerMeasure() * 100) / this.speed;
  }

  /** Beats per minute after speed adjustment (qpm for TimingCallbacks): derived back from milliseconds per measure and rounded. */
  private warpedQpm(tune: TuneObject): number {
    const millisecondsPerMeasure = this.warpedMillisecondsPerMeasure(tune);
    return Math.round((tune.getBeatsPerMeasure() / millisecondsPerMeasure) * 60000);
  }

  /**
   * Apply speed / mute parameters (SPEC-PLAY-02 / 04 / 06): takes effect through an internal rebuild, not treated as a user pause and no version switch;
   * during playback it continues the current snapshot after the rebuild, when paused / idle it rebuilds silently (the user plays manually, no auto-resume).
   */
  private applyAudioParams(): void {
    if (this.tune === undefined) {
      return;
    }
    if (this.phase === 'preparing') {
      // Preparing: cancel the old preparation and prepare again with the new parameters, keeping the still-valid start target
      this.invalidateTask();
      // An internal parameter restart does not report idle, so onChange does not re-enter a version switch.
      this.beginPrepare();
      return;
    }
    if (this.synthInstance === undefined && this.rebuild === undefined) {
      return; // Not prepared yet: the parameters take effect naturally at the next preparation (beginPrepare reads the current parameters)
    }
    this.startRebuild(this.phase === 'playing');
  }

  /** Start a parameter rebuild (SPEC-PLAY-02 / 04 / 06): the old instance is silenced and destroyed; the recorded tune fraction is restored on completion. */
  private startRebuild(resume: boolean): void {
    const instance = this.synthInstance;
    const fraction = this.rebuild?.fraction ?? this.currentFraction();
    this.synthInstance = undefined;
    this.prepared = false;
    this.pendingEndedIgnores = 0;
    if (instance !== undefined) {
      try {
        instance.stop(); // Ownership already dropped; the old ended does not enter the current counter.
      } catch (error) {
        console.error('ABC Desk: stop for rebuild failed', error);
      }
    }
    if (this.tune !== undefined) {
      this.buildTimer(this.tune, fraction);
      this.onTimingsChanged();
    }
    // Invalidate the old rebuild (if any): its late completion is dropped by generation and never sounds
    this.invalidateTask();
    const generation = this.taskGeneration;
    if (resume) {
      this.statusKey = 'applying-speed'; // Rebuild during playback: the status area shows a short buffering notice
    }
    this.rebuild = { generation, fraction, resume };
    this.beginRebuild(generation, fraction);
    this.onChange();
  }

  /** Async part of the parameter rebuild: initialize a new instance with the current parameters, then restore position and (if requested) resume. */
  private beginRebuild(generation: number, fraction: number): void {
    const tune = this.tune;
    if (tune === undefined) {
      this.rebuild = undefined;
      return;
    }
    if (this.soundfontUrl === undefined || !synth.supportsAudio()) {
      // Soundfont URL missing or environment unsupported: degrade by capability (SPEC-STATE-04), keep the last reliable position
      this.rebuild = undefined;
      this.phase = 'idle';
      this.pendingStartFraction = fraction;
      this.statusKey = 'audio-failed';
      this.onChange();
      return;
    }
    const audioContext = this.ensureAudioContext();
    this.armPrepareTimeout(generation);
    const instance = new synth.CreateSynth();
    this.preparingInstance = instance;
    void this.initSynth(tune, instance, audioContext)
      .then(() => generation === this.taskGeneration ? instance.prime() : undefined)
      .then((result) => {
        if (generation !== this.taskGeneration || this.rebuild?.generation !== generation) {
          // Cancelled / taken over / version switched / timed out: a late completion must not sound (the spare buffers are reused from the abcjs internal cache)
          try {
            instance.stop();
          } catch (error) {
            console.error('ABC Desk: stop of superseded rebuild failed', error);
          }
          return;
        }
        if (result === undefined) return;
        this.preparingInstance = undefined;
        this.currentTask = undefined;
        window.clearTimeout(this.prepareTimer);
        this.prepareTimer = undefined;
        if (result.status === 'empty') {
          // No sounding notes: stay idle, do not enter playback (SPEC-STATE-05)
          this.rebuild = undefined;
          this.phase = 'idle';
          this.pendingStartFraction = undefined;
          this.statusKey = 'no-notes';
          this.onChange();
          return;
        }
        this.finishRebuild(generation, instance);
      })
      .catch((error: unknown) => {
        if (generation !== this.taskGeneration || this.rebuild?.generation !== generation) {
          return;
        }
        // Rebuild failed: keep the last reliable position (the next play retries from there), status-area notice only (SPEC-STATE-04)
        this.invalidateTask();
        this.pendingStartFraction = this.rebuild.fraction;
        this.rebuild = undefined;
        this.phase = 'paused';
        this.statusKey = 'audio-failed';
        console.error('ABC Desk: audio rebuild failed', error);
        this.onChange();
      });
  }

  /** Parameter rebuild complete: install the new instance and restore the recorded position; a rebuild started during playback keeps playing (SPEC-PLAY-02). */
  private finishRebuild(generation: number, instance: MidiBuffer): void {
    const rebuild = this.rebuild;
    if (rebuild === undefined || rebuild.generation !== generation) {
      try {
        instance.stop();
      } catch (error) {
        console.error('ABC Desk: stop of stale rebuild failed', error);
      }
      return;
    }
    this.rebuild = undefined;
    this.synthInstance = instance;
    this.pendingEndedIgnores = 0;
    this.prepared = true;
    this.pendingStartFraction = undefined; // The position is carried by the instance and the rebuild state; clear any earlier leftover start point
    instance.seek(rebuild.fraction, 'percent');
    this.timer?.setProgress(rebuild.fraction, 'percent');
    if (rebuild.resume) {
      instance.start();
      this.timer?.start();
      this.statusKey = null;
      this.onChange();
    }
  }

  /**
   * Initialize the synth (shared by first-play preparation and parameter rebuilds): local soundfont, mute parameters and speed baseline.
   * Instrument unification is passed in via pianoOnlyTuneView (SPEC-ENV-07): the synth requests soundfont samples by the expansion's instrument,
   * and the view makes "requested set" and "actual placement" agree on piano; the original tune object is untouched (export keeps the material's instructions, SPEC-EXP-05).
   */
  private initSynth(
    tune: TuneObject,
    instance: MidiBuffer,
    audioContext: AudioContext | undefined,
  ): Promise<unknown> {
    const generation = this.tuneGeneration;
    const options: SynthOptions = {
      ...this.synthOptions,
      onEnded: () => {
        if (generation === this.tuneGeneration && instance === this.synthInstance) this.handleEnded();
      },
    };
    if (this.mutedVoices.size > 0) {
      // Voice mutes (SPEC-PLAY-06): only set the matching track volume to 0; notes, score and keyboard hints are unchanged
      options.voicesOff = [...this.mutedVoices].sort((first, second) => first - second);
    }
    if (this.chordsMuted) {
      options.chordsOff = true;
    }
    return instance.init({
      visualObj: pianoOnlyTuneView(tune),
      audioContext,
      // Speed baseline (SPEC-PLAY-04): the top-level millisecondsPerMeasure controls render speed (same as the official setWarp)
      millisecondsPerMeasure: this.warpedMillisecondsPerMeasure(tune),
      options,
    });
  }

  /** Current tune fraction (0-1, actual performance order including repeats): playing / paused reads the live position, otherwise the pending start point. */
  private currentFraction(): number {
    if (this.phase === 'playing' || this.phase === 'paused') {
      const total = this.totalMs();
      if (total > 0) {
        return Math.min(1, Math.max(0, (this.timer?.currentMillisecond() ?? 0) / total));
      }
    }
    return this.pendingStartFraction ?? 0;
  }

  /** Total performance length of the current timing (milliseconds): the last event (type: 'end') is the end point. */
  private totalMs(): number {
    const timings = this.timer?.noteTimings;
    if (timings === undefined || timings.length === 0) {
      return 0;
    }
    return timings[timings.length - 1].milliseconds;
  }

  /** Milliseconds -> tune fraction (SPEC-PLAY-05 / 12): converted against the current timing total and clamped. */
  private fractionOfMs(milliseconds: number): number {
    const total = this.totalMs();
    if (total <= 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, milliseconds / total));
  }

  /** Increment the task generation and clear task markers and timers: completion of the old preparation has no further effect. */
  private invalidateTask(): void {
    this.taskGeneration += 1;
    const pending = this.preparingInstance;
    this.preparingInstance = undefined;
    try { pending?.stop(); } catch (error) { console.error('ABC Desk: pending audio cleanup failed', error); }
    this.currentTask = undefined;
    if (this.prepareTimer !== undefined) {
      window.clearTimeout(this.prepareTimer);
      this.prepareTimer = undefined;
    }
    if (this.gestureRecoveryTimer !== undefined) {
      window.clearTimeout(this.gestureRecoveryTimer);
      this.gestureRecoveryTimer = undefined;
    }
  }

  /**
   * Arm the preparation / rebuild timeout (SPEC-PERF-06 / 08 / PLAY-14): before user interaction we are waiting for interaction, not failing, so no timeout is reported;
   * after interaction the system preparation timeout protection resumes and only a long silence is handled by the timeout rules:
   * a first-play timeout terminates the request back to idle; a parameter rebuild timeout goes to paused and keeps the last reliable position (SPEC-PERF-08).
   */
  private armPrepareTimeout(generation: number): void {
    this.prepareTimer = window.setTimeout(() => {
      const rebuilding = this.rebuild !== undefined && this.rebuild.generation === generation;
      if (generation !== this.taskGeneration || (!rebuilding && this.phase !== 'preparing')) {
        return;
      }
      if (!this.hasUserGesture) {
        // Waiting for user interaction: not a failure, the notice stays; the clock resumes after interaction (SPEC-PLAY-14)
        this.prepareTimer = undefined;
        return;
      }
      this.prepareTimer = undefined;
      if (rebuilding) {
        // Rebuild timeout (SPEC-PERF-08): go to paused and keep the last reliable position; pending events are guarded by the phase
        const fraction = this.rebuild?.fraction ?? 0;
        this.invalidateTask();
        this.rebuild = undefined;
        this.pendingStartFraction = fraction;
        this.timer?.setProgress(fraction, 'percent');
        this.phase = 'paused';
        this.statusKey = 'prepare-timeout';
        this.onChange();
        return;
      }
      // Preparation timeout: terminate this request; a later completion must not sound (SPEC-PLAY-01 / PERF-06)
      this.invalidateTask();
      this.pendingStartFraction = undefined;
      this.phase = 'idle';
      this.statusKey = 'prepare-timeout';
      this.onChange();
    }, PREPARE_TIMEOUT_MS);
  }

  /** Create or reuse the AudioContext; a creation failure is treated as limited audio capability (SPEC-STATE-04). */
  private ensureAudioContext(): AudioContext | undefined {
    if (this.audioContext === undefined) {
      try {
        this.audioContext = new AudioContext();
      } catch (error) {
        console.error('ABC Desk: AudioContext creation failed', error);
      }
    }
    return this.audioContext;
  }

  /** Listen for the first user interaction inside the preview: resume the audio device and restart a stuck preparation if needed (SPEC-PLAY-14). */
  private installGestureUnlock(): void {
    const unlock = (): void => {
      this.removeGestureUnlock();
      this.hasUserGesture = true;
      const context = this.audioContext;
      if (context !== undefined && context.state === 'suspended') {
        // A user interaction context is the standard moment to resume the audio device (same behavior as the button path)
        void context.resume().catch(() => {});
      }
      if (this.phase !== 'preparing') {
        return;
      }
      if (this.statusKey === 'click-to-play') {
        // Interaction happened: switch the waiting notice to the real preparation phase
        this.statusKey = 'preparing';
        this.onChange();
      }
      if (this.prepareTimer === undefined) {
        // No clock while waiting for interaction; after interaction the system preparation timeout protection resumes (SPEC-PERF-06)
        this.armPrepareTimeout(this.taskGeneration);
      }
      const task = this.currentTask;
      if (task === undefined || !task.primeStarted) {
        // Buffering has not started: prime will not hang after audio resume, no restart needed
        return;
      }
      // The buffering stage may be stuck on audio resume: give the old task a window to recover on its own, restart preparation if still unfinished
      window.clearTimeout(this.gestureRecoveryTimer);
      this.gestureRecoveryTimer = window.setTimeout(() => {
        this.gestureRecoveryTimer = undefined;
        if (this.currentTask === task && this.phase === 'preparing') {
          this.invalidateTask();
          this.beginPrepare();
        }
      }, GESTURE_RECOVERY_MS);
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
    window.addEventListener('click', unlock, { capture: true, passive: true });
    this.gestureUnlock = unlock;
  }

  /** Remove the first-interaction listener (after it fires or on dispose). */
  private removeGestureUnlock(): void {
    const unlock = this.gestureUnlock;
    if (unlock === undefined) {
      return;
    }
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
    window.removeEventListener('click', unlock, { capture: true });
    this.gestureUnlock = undefined;
  }

  private beginPrepare(): void {
    const tune = this.tune;
    if (tune === undefined) {
      return;
    }
    if (this.soundfontUrl === undefined || !synth.supportsAudio()) {
      // Soundfont URL missing or environment unsupported: degrade by capability and skip preparation (SPEC-STATE-04)
      this.phase = 'idle';
      this.pendingStartFraction = undefined;
      this.statusKey = 'audio-failed';
      this.onChange();
      return;
    }
    const audioContext = this.ensureAudioContext();
    const generation = ++this.taskGeneration;
    const task: PrepareTask = { primeStarted: false };
    this.currentTask = task;
    this.phase = 'preparing';
    // Before interaction, while the audio device is not resumed, say explicitly that we are waiting instead of staying silent (SPEC-PLAY-14)
    const awaitingGesture = !this.hasUserGesture && audioContext?.state === 'suspended';
    this.statusKey = awaitingGesture ? 'click-to-play' : 'preparing';
    this.onChange();
    this.armPrepareTimeout(generation);

    const instance = new synth.CreateSynth();
    this.preparingInstance = instance;
    void this.initSynth(tune, instance, audioContext)
      .then(() => {
        if (generation !== this.taskGeneration) return undefined;
        task.primeStarted = true; // Entering buffer generation: may wait on audio resume from here on (SPEC-PLAY-14)
        return instance.prime();
      })
      .then((result) => {
        if (generation !== this.taskGeneration) {
          // Old task that was cancelled / taken over / version switched / timed out: stop the instance and never sound.
          try { instance.stop(); } catch (error) { console.error('ABC Desk: stale preparation cleanup failed', error); }
          return;
        }
        if (result === undefined) return;
        this.preparingInstance = undefined;
        this.currentTask = undefined;
        window.clearTimeout(this.prepareTimer);
        this.prepareTimer = undefined;
        if (result.status === 'empty') {
          // No sounding notes: stay idle, do not enter playback (SPEC-STATE-05)
          this.phase = 'idle';
          this.pendingStartFraction = undefined;
          this.statusKey = 'no-notes';
          this.onChange();
          return;
        }
        this.synthInstance = instance;
        this.prepared = true;
        // On success run the still-valid request without a second click (SPEC-PLAY-01); the start point is consumed by startSound
        this.startSound();
      })
      .catch((error: unknown) => {
        if (generation !== this.taskGeneration) {
          return;
        }
        // Audio preparation failed: keep the score, status-area notice only; the user's next play issues a new retry request (SPEC-STATE-04)
        this.invalidateTask();
        this.phase = 'idle';
        this.statusKey = 'audio-failed';
        this.synthInstance = undefined;
        this.prepared = false;
        console.error('ABC Desk: audio preparation failed', error);
        this.onChange();
      });
  }

  /**
   * Natural end: with loop on, return to the beginning and keep playing (SPEC-PLAY-03); otherwise silence, return to the playable state and clear playback highlighting
   * (position and replay semantics await P01; no default is invented).
   * ended events from programmatic source stops (rebuild / in-playback seek) are excluded by the counter first, the rest is guarded by the phase;
   * abcjs does not clear isRunning after a natural end (zombie running state), so stop explicitly here to avoid a later seek starting playback by accident.
   */
  private handleEnded(): void {
    if (this.pendingEndedIgnores > 0) {
      this.pendingEndedIgnores -= 1;
      return; // ended from a rebuild / in-playback seek: not a natural end
    }
    if (this.rebuild !== undefined) {
      return; // Rebuild in progress with audio not playing: the arriving event belongs to a programmatic source stop
    }
    if (this.phase !== 'playing') {
      return; // ended from a manual stop / pause: state was already handled in the respective method
    }
    const instance = this.synthInstance;
    if (this.loopEnabled) {
      // Loop (SPEC-PLAY-03): keep the playing phase and playback highlighting; the wrap is not a natural end - pending content is applied
      // uniformly by STATE-07 on stop / pause, the wrap itself triggers no version switch.
      // The order must be stop -> seek -> start: abcjs does not clear isRunning after a natural end (zombie running state),
      // a direct seek would start playback via _kickOffSound; stop on an already ended source dispatches no further ended and is safe to clean up.
      if (instance !== undefined) {
        try {
          instance.stop();
          instance.seek(0, 'percent');
          instance.start();
        } catch (error) {
          console.error('ABC Desk: loop restart failed', error);
        }
      }
      this.syncTimer(0); // Resynchronize the performance timing to the beginning and re-emit playback highlighting (SPEC-PLAY-11)
      return;
    }
    if (instance !== undefined) {
      try {
        instance.stop(); // Clean up the zombie running state (an already ended source dispatches no further ended)
      } catch (error) {
        console.error('ABC Desk: stop after ended failed', error);
      }
    }
    this.phase = 'idle';
    this.statusKey = null;
    this.onTimeline(null);
    this.onChange();
  }
}

/**
 * Sequence mapping finalization (SPEC-ENV-07): the expansion has already been unified to piano by pianoOnlyTuneView (numeric index);
 * unify the final sequence once more here (instrument in the mapping is a soundfont name) to guard against anything the expansion missed.
 */
function forcePianoInstrument(noteMapTracks: NoteMapTrack[]): NoteMapTrack[] {
  for (const track of noteMapTracks) {
    for (const note of track) {
      note.instrument = PIANO_INSTRUMENT;
    }
  }
  return noteMapTracks;
}
