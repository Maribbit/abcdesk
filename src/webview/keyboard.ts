import { t } from './l10n';
import type { PracticeUiPreferences } from '../core/practice';

/**
 * Piano keyboard visualization (SPEC-PLAY-08 / 09 / 15, SPEC-STATE-03 / 05) and range algorithms.
 *
 * - The range algorithms (computeTuneRange / keyPitches / computeKeyMetrics, etc.) are pure functions,
 *   really covered by test/keyboard.test.ts (SPEC-PLAY-08); the KeyboardView class only touches the DOM;
 * - the keyboard is purely visual (SPEC-PLAY-09): keys are not in the Tab order, offer no click audition and are not playable buttons;
 *   the accessible description lives on the scroll container (SPEC-A11Y-13 / 15);
 * - playback highlighting follows performance time via setActivePitches; hints outside the viewport only show direction arrows,
 *   with no automatic horizontal scrolling and no pulling back of manual browsing (SPEC-PLAY-08);
 * - inspection / click reflection (SPEC-PLAY-15) highlights the matching keys in the inspection color via setPointedPitches, independent of playback highlighting;
 *   when the same key is hit by both, a CSS rule lets the playback color win.
 */

/** Keyboard range mode (SPEC-PLAY-08 / SET-05): tune = range of the current tune's material, full 88 keys = A0-C8. */
export type KeyboardRangeMode = 'tune' | 'full';

/** MIDI pitch bounds of A0-C8 (SPEC-PLAY-08): the visible range of the full 88 keys. */
export const PIANO_MIN_PITCH = 21;
export const PIANO_MAX_PITCH = 108;

/** MIDI pitch of middle C (SPEC-PLAY-08: middle C is labelled C4; note names follow scientific pitch notation). */
export const MIDDLE_C_PITCH = 60;

/** Lower bound of the material range (SPEC-PLAY-08: keep at least two octaves of reference space). */
export const MIN_SPAN_SEMITONES = 24;

/** Minimum white-key width (SPEC-PLAY-08: keep keys recognizable in narrow windows; scroll horizontally rather than compress). */
export const MIN_WHITE_KEY_WIDTH = 20;

const MIN_WHITE_KEY_HEIGHT = 52;
const MAX_WHITE_KEY_HEIGHT = 96;
const WHITE_KEY_HEIGHT_RATIO = 3;
const BLACK_KEY_WIDTH_RATIO = 0.6;
const BLACK_KEY_HEIGHT_RATIO = 0.62;
const KEYBOARD_HORIZONTAL_PADDING = 16;

/** Default reference range C3-C5 for material without pitches (whole rests, etc.) (SPEC-STATE-05: the keyboard can state there are no pitch hints). */
const EMPTY_TUNE_START = 48;
const EMPTY_TUNE_END = 72;

export interface TuneRange {
  start: number;
  end: number;
}

/** Material pitch extractable from performance timing events (structural type to avoid importing abcjs in a pure-logic module). */
export interface PitchCarrier {
  midiPitches?: ReadonlyArray<{ pitch?: number }>;
}

/**
 * Material pitch set (SPEC-PLAY-08): the whole current tune's notated material, deduplicated and sorted; includes muted voices
 * (muting only affects sounding tracks, not the pitches in timing events); other tunes in the file are not merged.
 */
export function collectPitches(events: ReadonlyArray<PitchCarrier>): number[] {
  const pitches = new Set<number>();
  for (const event of events) {
    for (const midiPitch of event.midiPitches ?? []) {
      if (typeof midiPitch.pitch === 'number') {
        pitches.add(midiPitch.pitch);
      }
    }
  }
  return [...pitches].sort((first, second) => first - second);
}

/**
 * Range in tune mode (SPEC-PLAY-08): min-max expanded around the centre to at least two octaves, then clamped to A0-C8;
 * material without pitches returns the default two-octave reference range; pitches outside A0-C8 are excluded from the interval (reported by the note line, not folded).
 */
export function computeTuneRange(pitches: ReadonlyArray<number>): TuneRange {
  if (pitches.length === 0) {
    return { start: EMPTY_TUNE_START, end: EMPTY_TUNE_END };
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const pitch of pitches) {
    start = Math.min(start, pitch);
    end = Math.max(end, pitch);
  }
  const deficit = MIN_SPAN_SEMITONES - (end - start);
  if (deficit > 0) {
    const below = Math.floor(deficit / 2);
    start -= below;
    end += deficit - below;
  }
  if (start < PIANO_MIN_PITCH) {
    end += PIANO_MIN_PITCH - start;
    start = PIANO_MIN_PITCH;
  }
  if (end > PIANO_MAX_PITCH) {
    start -= end - PIANO_MAX_PITCH;
    end = PIANO_MAX_PITCH;
  }
  return {
    start: Math.max(start, PIANO_MIN_PITCH),
    end: Math.min(end, PIANO_MAX_PITCH),
  };
}

/** Pitches outside A0-C8 (SPEC-PLAY-08): not folded into another octave; the note line states them explicitly. */
export function outOfRangePitches(pitches: ReadonlyArray<number>): number[] {
  return [...new Set(pitches.filter((pitch) => pitch < PIANO_MIN_PITCH || pitch > PIANO_MAX_PITCH))].sort(
    (first, second) => first - second,
  );
}

/** Key list for the current range mode (SPEC-PLAY-08): full 88 keys is fixed A0-C8, tune mode uses the computed range. */
export function keyPitches(mode: KeyboardRangeMode, tuneRange: TuneRange): number[] {
  const start = mode === 'full' ? PIANO_MIN_PITCH : tuneRange.start;
  const end = mode === 'full' ? PIANO_MAX_PITCH : tuneRange.end;
  const pitches: number[] = [];
  for (let pitch = start; pitch <= end; pitch += 1) {
    pitches.push(pitch);
  }
  return pitches;
}

/** Black-key test (12-tone equal temperament, C-major piano layout). */
export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

/** Note name (SPEC-PLAY-08: label each C with its octave, middle C as C4). */
export function pitchName(pitch: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(pitch / 12) - 1;
  return `${names[((pitch % 12) + 12) % 12]}${octave}`;
}

export interface KeyMetrics {
  whiteWidth: number;
  whiteHeight: number;
  blackWidth: number;
  blackHeight: number;
  blackOffset: number;
}

/** Key metrics (SPEC-PLAY-08): spread white-key width over the visible width with a minimum (scroll rather than compress); black keys proportional. */
export function computeKeyMetrics(availableWidth: number, whiteCount: number): KeyMetrics {
  const usable = Math.max(0, availableWidth - KEYBOARD_HORIZONTAL_PADDING);
  const whiteWidth = Math.max(MIN_WHITE_KEY_WIDTH, usable / Math.max(1, whiteCount));
  const whiteHeight = Math.min(
    MAX_WHITE_KEY_HEIGHT,
    Math.max(MIN_WHITE_KEY_HEIGHT, whiteWidth * WHITE_KEY_HEIGHT_RATIO),
  );
  const blackWidth = whiteWidth * BLACK_KEY_WIDTH_RATIO;
  return {
    whiteWidth,
    whiteHeight,
    blackWidth,
    blackHeight: whiteHeight * BLACK_KEY_HEIGHT_RATIO,
    blackOffset: -blackWidth / 2,
  };
}

/** DOM elements the keyboard view depends on (provided by previewPanel's HTML; the constructor throws when missing, same policy as queryElement). */
export interface KeyboardElements {
  section: HTMLElement;
  caption: HTMLElement;
  note: HTMLElement;
  scroll: HTMLElement;
  keys: HTMLElement;
  rangeSelect: HTMLSelectElement;
  collapseButton: HTMLButtonElement;
  leftArrow: HTMLElement;
  rightArrow: HTMLElement;
}

/**
 * Keyboard view (SPEC-PLAY-08 / 09 / 15): builds the key list, keeps range / collapsed as two independent states,
 * handles playback highlighting, inspection / click reflection and direction arrows; no audio and no relayout notification (low heights are handled by scrolling the whole content).
 */
export class KeyboardView {
  private readonly elements: KeyboardElements;
  private readonly keyElements = new Map<number, HTMLElement>();
  /** Wrapper label of the range selector (hidden together when collapsed; the dock bar keeps only the note and the expand entry). */
  private readonly rangeLabel: HTMLElement | null;

  private mode: KeyboardRangeMode = 'tune';
  /** Manually collapsed (SPEC-PLAY-08): within the same preview, playback or voice changes do not expand it. */
  private collapsed = false;
  /** Whether displayable material exists (the whole keyboard area is hidden in the empty state / on first render failure). */
  private hasTune = false;
  private tunePitches: number[] = [];
  private tuneRange: TuneRange = { start: EMPTY_TUNE_START, end: EMPTY_TUNE_END };
  private activePitches: number[] = [];
  /** Inspection / click reflection (SPEC-PLAY-15): pitches hit by the cursor or a click, independent of playback highlighting. */
  private pointedPitches: number[] = [];
  /** Notify the caller to save after the user changes collapsed / range (SPEC-SET-05); not fired when restoring preferences. */
  onPreferencesChange: (() => void) | undefined;

  constructor(elements: KeyboardElements) {
    this.elements = elements;
    this.rangeLabel = elements.rangeSelect.closest('label');
    this.applyStaticTexts();
    elements.rangeSelect.addEventListener('change', () => this.setMode(readMode(elements.rangeSelect)));
    elements.collapseButton.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    elements.scroll.addEventListener('scroll', () => this.updateArrows());
    // Panel resize: recompute only key metrics and direction hints, keep the scroll position (do not pull back manual browsing, SPEC-PLAY-08)
    new ResizeObserver(() => {
      this.refreshSize();
      this.updateArrows();
    }).observe(elements.scroll);
    this.updateVisibility();
  }

  /** Adopt the new version's material pitches (SPEC-PLAY-08): recompute range and key list; dynamic highlighting is rebuilt with the new version. */
  setTune(pitches: ReadonlyArray<number>): void {
    this.tunePitches = [...pitches];
    this.activePitches = [];
    this.hasTune = true;
    this.rebuild();
  }

  /** Clear (empty state / no tune / first render failure): hide the whole keyboard area without leaving the old key list or dynamic / reflection state. */
  clear(): void {
    this.hasTune = false;
    this.activePitches = [];
    this.pointedPitches = [];
    this.tunePitches = [];
    this.keyElements.clear();
    this.elements.keys.replaceChildren();
    this.updateVisibility();
  }

  /**
   * Playback highlighting (SPEC-PLAY-09): follows the performance time of the notated material, including muted voices;
   * an empty array clears it (stop / pause / natural end / render failure clear dynamic hints, SPEC-STATE-03).
   */
  setActivePitches(pitches: ReadonlyArray<number>): void {
    this.activePitches = [...new Set(pitches)];
    this.applyActiveClasses();
    this.updateArrows();
  }

  /** Clear dynamic hints but keep the key list (SPEC-STATE-03: clear keyboard dynamic hints while the stale score is shown for reference). */
  clearActivePitches(): void {
    this.setActivePitches([]);
  }

  /**
   * Inspection / click reflection (SPEC-PLAY-15): the note under the source cursor or clicked in the preview is highlighted on the keyboard in the inspection color;
   * coexists independently with playback highlighting; when both hit the same key the playback color wins (guaranteed by CSS).
   */
  setPointedPitches(pitches: ReadonlyArray<number>): void {
    this.pointedPitches = [...new Set(pitches)];
    this.applyActiveClasses();
  }

  /** Clear inspection / click reflection (SPEC-PLAY-15): called when the marker is cleared, the version changes or a non-note element is clicked. */
  clearPointedPitches(): void {
    this.setPointedPitches([]);
  }

  /** Current file-level UI preferences (SPEC-SET-05): collapsed and range mode; selection and playback position are not persisted. */
  getPreferences(): PracticeUiPreferences {
    return { keyboardCollapsed: this.collapsed, keyboardMode: this.mode };
  }

  /** Restore UI preferences (SPEC-SET-05): only changes the view without firing the save callback; the range is recomputed for the current tune. */
  applyPreferences(preferences: PracticeUiPreferences): void {
    this.mode = preferences.keyboardMode;
    this.elements.rangeSelect.value = this.mode;
    this.collapsed = preferences.keyboardCollapsed;
    this.updateCollapseButton();
    if (this.hasTune) {
      this.rebuild();
    } else {
      this.updateVisibility();
    }
  }

  private applyStaticTexts(): void {
    const { elements } = this;
    elements.caption.textContent = t('keyboard-caption');
    elements.scroll.setAttribute('aria-label', t('keyboard-region'));
    const labelText = this.rangeLabel === null ? null : this.rangeLabel.querySelector('span');
    if (labelText !== null) {
      labelText.textContent = t('keyboard-range');
    }
    for (const option of Array.from(elements.rangeSelect.options)) {
      option.textContent = t(option.value === 'full' ? 'keyboard-mode-full' : 'keyboard-mode-tune');
    }
    elements.leftArrow.title = t('keyboard-hint-left');
    elements.rightArrow.title = t('keyboard-hint-right');
    this.updateCollapseButton();
  }

  /** Range mode switch (SPEC-PLAY-08): rebuild the key list immediately and position the view on the material range; collapsed state and hint visibility are unchanged. */
  private setMode(mode: KeyboardRangeMode): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    if (this.hasTune) {
      this.rebuild();
    }
    this.onPreferencesChange?.();
  }

  private setCollapsed(collapsed: boolean): void {
    if (collapsed === this.collapsed) {
      return;
    }
    this.collapsed = collapsed;
    this.updateCollapseButton();
    this.updateVisibility();
    if (!collapsed) {
      // Give the key list a stable anchor (material range) when expanding; playback never drives horizontal scrolling, so this initial positioning is not a pull-back
      this.refreshSize();
      this.scrollToTuneRange();
      this.updateArrows();
    }
    this.onPreferencesChange?.();
  }

  private updateCollapseButton(): void {
    const label = t(this.collapsed ? 'keyboard-expand' : 'keyboard-collapse');
    this.elements.collapseButton.textContent = label;
    this.elements.collapseButton.setAttribute('aria-label', label);
    this.elements.collapseButton.setAttribute('aria-expanded', String(!this.collapsed));
  }

  /** Visibility (SPEC-PLAY-08): shown when there is material; collapsing hides only the key list / note / range selector, the dock bar stays. */
  private updateVisibility(): void {
    const visible = this.hasTune;
    this.elements.section.hidden = !visible;
    this.elements.scroll.hidden = this.collapsed;
    if (this.rangeLabel !== null) {
      this.rangeLabel.hidden = this.collapsed;
    }
    this.updateNote();
    if (!visible || this.collapsed) {
      this.updateArrows();
    }
  }

  /** Rebuild the key list (SPEC-PLAY-08): generate keys in key order for the current mode and range; keys are purely visual and not in the Tab order. */
  private rebuild(): void {
    this.tuneRange = computeTuneRange(this.tunePitches);
    const pitches = keyPitches(this.mode, this.tuneRange);
    this.keyElements.clear();
    const fragment = document.createDocumentFragment();
    for (const pitch of pitches) {
      const key = document.createElement('div');
      key.className = isBlackKey(pitch)
        ? 'abcdesk-key abcdesk-key-black'
        : 'abcdesk-key abcdesk-key-white';
      key.dataset.pitch = String(pitch);
      key.dataset.note = pitchName(pitch);
      // Keys are purely visual (SPEC-PLAY-09): no button semantics, not in the Tab order; the description lives on the scroll container (SPEC-A11Y-15)
      key.setAttribute('aria-hidden', 'true');
      fragment.appendChild(key);
      this.keyElements.set(pitch, key);
    }
    this.elements.keys.replaceChildren(fragment);
    this.updateVisibility();
    this.applyActiveClasses();
    this.refreshSize();
    this.scrollToTuneRange();
    this.updateArrows();
  }

  /** Key metrics (SPEC-PLAY-08): recompute only CSS variables, keep the scroll position. */
  private refreshSize(): void {
    const whiteCount = [...this.keyElements.keys()].filter((pitch) => !isBlackKey(pitch)).length;
    const metrics = computeKeyMetrics(this.elements.scroll.clientWidth, whiteCount);
    const style = this.elements.keys.style;
    style.setProperty('--abcdesk-white-key-width', `${metrics.whiteWidth}px`);
    style.setProperty('--abcdesk-white-key-height', `${metrics.whiteHeight}px`);
    style.setProperty('--abcdesk-black-key-width', `${metrics.blackWidth}px`);
    style.setProperty('--abcdesk-black-key-height', `${metrics.blackHeight}px`);
    style.setProperty('--abcdesk-black-key-offset', `${metrics.blackOffset}px`);
  }

  /** Scroll anchor after initial build / rebuild: centre the material range; playback events never trigger it (no automatic horizontal scrolling, SPEC-PLAY-08). */
  private scrollToTuneRange(): void {
    const startKey = this.keyElements.get(this.tuneRange.start);
    const endKey = this.keyElements.get(this.tuneRange.end);
    if (startKey === undefined || endKey === undefined) {
      return;
    }
    const scroll = this.elements.scroll;
    const scrollRect = scroll.getBoundingClientRect();
    const startRect = startKey.getBoundingClientRect();
    const endRect = endKey.getBoundingClientRect();
    const center = (startRect.left + endRect.right) / 2 - scrollRect.left + scroll.scrollLeft;
    scroll.scrollLeft = Math.max(0, center - scroll.clientWidth / 2);
  }

  /** Key coloring (SPEC-PLAY-09 / 15): playback highlighting and inspection reflection toggle independently; when both hit the same key CSS lets the playback color win. */
  private applyActiveClasses(): void {
    const active = new Set(this.activePitches);
    const pointed = new Set(this.pointedPitches);
    for (const [pitch, element] of this.keyElements) {
      element.classList.toggle('abcdesk-key-active', active.has(pitch));
      element.classList.toggle('abcdesk-key-pointed', pointed.has(pitch));
    }
  }

  /**
   * Direction hints (SPEC-PLAY-08): when a hinted pitch is outside the visible window, show an arrow at the matching edge;
   * only the direction is hinted - no scrolling and no pulling back of the user's manual browsing.
   */
  private updateArrows(): void {
    const { leftArrow, rightArrow, scroll } = this.elements;
    if (!this.hasTune || this.collapsed || this.activePitches.length === 0) {
      leftArrow.hidden = true;
      rightArrow.hidden = true;
      return;
    }
    const scrollRect = scroll.getBoundingClientRect();
    let leftOut = false;
    let rightOut = false;
    for (const pitch of this.activePitches) {
      const key = this.keyElements.get(pitch);
      if (key === undefined) {
        continue;
      }
      const rect = key.getBoundingClientRect();
      if (rect.right <= scrollRect.left + 1) {
        leftOut = true;
      } else if (rect.left >= scrollRect.right - 1) {
        rightOut = true;
      }
    }
    leftArrow.hidden = !leftOut;
    rightArrow.hidden = !rightOut;
  }

  /** Note line (SPEC-STATE-05 / PLAY-08): material without pitches states there are no hints; pitches outside A0-C8 are not folded and are stated explicitly. */
  private updateNote(): void {
    const text = this.noteText();
    this.elements.note.textContent = text ?? '';
    this.elements.note.hidden = text === null || this.collapsed;
  }

  private noteText(): string | null {
    if (!this.hasTune) {
      return null;
    }
    if (this.tunePitches.length === 0) {
      return t('keyboard-no-pitch');
    }
    if (outOfRangePitches(this.tunePitches).length > 0) {
      return t('keyboard-out-of-range');
    }
    return null;
  }
}

function readMode(select: HTMLSelectElement): KeyboardRangeMode {
  return select.value === 'full' ? 'full' : 'tune';
}
