/**
 * Pure logic for the playback controls (SPEC-PLAY-04 / 05 / 06, SPEC-ENV-07): speed conversion and parsing, time display,
 * voice list and chord-track detection, beat hint conversion, instrument unification for the performance view.
 *
 * Everything is pure functions and structural types (no abcjs runtime import, same precedent as keyboard.ts),
 * really covered by test/playback.test.ts; the PLAY domain is manual-verified (registered in docs/manual-checks.md),
 * so test titles additionally cite the items for two-way checking.
 */

import type { AudioTracks, SynthOptions, TuneObject } from 'abcjs';

/** Speed percentage range, step and default (SPEC-PLAY-04: default 100%, range 25%-200%). */
export const SPEED_MIN = 25;
export const SPEED_MAX = 200;
export const SPEED_DEFAULT = 100;
export const SPEED_STEP = 5;

/** Normalize speed to a legal value (SPEC-PLAY-04): round to integer and clamp to range; non-numeric falls back to default. */
export function clampSpeed(percent: number): number {
  if (!Number.isFinite(percent)) {
    return SPEED_DEFAULT;
  }
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(percent)));
}

/**
 * Parse speed input (SPEC-PLAY-04 / P06 wording): empty and invalid numbers return null (the caller restores the current value);
 * out-of-range numbers are clamped (not treated as invalid).
 */
export function parseSpeedPercent(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return null;
  }
  return clampSpeed(value);
}

/** Milliseconds -> "M:SS" (progress time label, SPEC-PLAY-05); negative and non-finite values are treated as 0. */
export function formatClock(milliseconds: number): string {
  const safe = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Voice list entry (SPEC-PLAY-06): index is the voice index in the performance timing; empty name means unnamed. */
export interface VoiceEntry {
  index: number;
  name: string | null;
}

/** Minimal tune structure required for the voice list (subset of abcjs TuneObject). */
export interface VoiceStaffView {
  clef?: { type?: string };
  voices?: ReadonlyArray<unknown>;
  title?: ReadonlyArray<string | undefined>;
}

export interface VoiceLineView {
  staff?: ReadonlyArray<VoiceStaffView>;
}

export interface VoiceSource {
  lines?: ReadonlyArray<VoiceLineView>;
}

/**
 * Collect the tune's actual voice list (SPEC-PLAY-06: show the real ABC voices; the first voice is not forced to be the demo).
 * Counting mirrors the abcjs sequencer: reset per line, skip TAB staves, follow voices order within a staff, take the maximum across lines;
 * the name is the voice's first non-empty staff.title (already a string array after abcjs fixTitles), null when unnamed.
 */
export function collectVoices(tune: VoiceSource): VoiceEntry[] {
  const names: Array<string | null> = [];
  for (const line of tune.lines ?? []) {
    let voiceNumber = 0;
    for (const staff of line.staff ?? []) {
      if (staff.clef?.type === 'TAB') {
        continue;
      }
      const voices = staff.voices ?? [];
      for (let withinStaff = 0; withinStaff < voices.length; withinStaff += 1) {
        const title = staff.title?.[withinStaff];
        if (names[voiceNumber] === undefined || names[voiceNumber] === null) {
          names[voiceNumber] = typeof title === 'string' && title !== '' ? title : null;
        }
        voiceNumber += 1;
      }
    }
  }
  return names.map((name, index) => ({ index, name }));
}

/**
 * SPEC-SET-04: verify V: ownership from the note's position in the parse input; display names or track indexes are not identifiers.
 * abcjs does not expose the original V: id; incomplete, contradictory or unverifiable tracks all return unknown.
 */
export function voiceSignature(tune: TuneObject, abc: string): string | null {
  // Mask text blocks and non-voice fields first, then filter comments, strings and decorations; always preserve UTF-16 length and line boundaries.
  let block: string | undefined;
  const source = abc.split('\n').map((line) => {
    const begin = /^%%begin(\w+)/i.exec(line);
    const end = /^%%end(\w+)/i.exec(line);
    const blocked = block !== undefined || begin !== null;
    if (begin !== null) block = begin[1].toLowerCase();
    if (end !== null && end[1].toLowerCase() === block) block = undefined;
    return blocked || /^(?!V:|K:)[A-Za-z+]:/.test(line) ? ' '.repeat(line.length) : line;
  }).join('\n');
  let masked = '';
  let quote = '';
  let comment = false;
  for (let index = 0; index < abc.length; index += 1) {
    const char = source[index];
    if (char === '\n') { comment = false; quote = ''; masked += char; continue; }
    if (comment) { masked += ' '; continue; }
    if (quote !== '') {
      if (char === quote && abc[index - 1] !== '\\') quote = '';
      masked += ' ';
      continue;
    }
    if (char === '%' && abc[index - 1] !== '\\') { comment = true; masked += ' '; continue; }
    if (char === '"' || char === '!' || char === '+') { quote = char; masked += ' '; continue; }
    masked += char;
  }
  const headerEnd = /^K:.*$/m.exec(masked);
  const bodyStart = headerEnd === null ? 0 : headerEnd.index + headerEnd[0].length;
  const declarations = [...masked.matchAll(/(?:^|\n)V:[ \t]*([^\s[\]%]+)|\[V:[ \t]*([^\s\]]+)/g)];
  const declared = new Set(declarations.map((match) => match[1] ?? match[2]));
  const switches = declarations.filter((match) => match.index >= bodyStart || match[2] !== undefined);
  const entries = collectVoices(tune);
  const ids: Array<string | undefined> = [];
  for (const line of tune.lines) {
    let track = 0;
    for (const staff of line.staff ?? []) {
      if ((staff.clef as { type?: string } | undefined)?.type === 'TAB') continue;
      for (const voice of staff.voices ?? []) {
        for (const note of voice ?? []) {
          if (note.el_type !== 'note' || note.startChar === undefined || note.startChar < 0) continue;
          let id = declared.size === 0 ? '@implicit' : declared.size === 1 ? [...declared][0] : undefined;
          for (const change of switches) {
            if (change.index > note.startChar) break;
            id = change[1] ?? change[2];
          }
          if (id === undefined || (ids[track] !== undefined && ids[track] !== id)) return null;
          ids[track] = id;
        }
        track += 1;
      }
    }
  }
  if (entries.length === 0 || entries.some((entry) => ids[entry.index] === undefined)) return null;
  if (new Set(ids).size !== entries.length || [...declared].some((id) => !ids.includes(id))) return null;
  // null is the internal default voice id and never collides with an explicit V: string.
  return JSON.stringify(entries.map((entry) => [declared.size === 0 ? null : ids[entry.index], entry.name]));
}

/**
 * Whether an automatic chord accompaniment track exists (SPEC-PLAY-06 / 10): the abcjs chord track's channel equals the voice count
 * (the drum track is voice count + 1, see abcjs ChordTrack / writeDrum); the first program instruction identifies the track.
 * Detection must use the expansion without mute parameters (with chordsOff the track is absent entirely); without it the menu hides the chord toggle.
 */
export function hasChordTrack(tracks: unknown, voiceCount: number): boolean {
  if (!Array.isArray(tracks)) {
    return false;
  }
  for (let index = voiceCount; index < tracks.length; index += 1) {
    const track: unknown = tracks[index];
    if (!Array.isArray(track)) {
      continue;
    }
    for (const item of track) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const event = item as { cmd?: unknown; channel?: unknown };
      if (event.cmd !== 'program') {
        continue;
      }
      if (event.channel === voiceCount) {
        return true;
      }
      break; // The track's first program is not the chord-track marker: later programs only switch instruments, this is not the chord track
    }
  }
  return false;
}

/** Minimal tune structure required for the beat hint (subset of abcjs TuneObject). */
export interface BeatHintSource {
  getBeatLength: () => number;
  getBpm: () => number;
  /** abcjs runtime property: mid-tune tempo positions indexed by measure number (0 = the opening Q:); undeclared type, read as unknown. */
  tempoLocations?: unknown;
}

/**
 * Beat hint conversion (SPEC-PLAY-04): returns "quarter notes per minute" when it can be converted reliably, otherwise null (no guessed value shown).
 * Given only when a quarter note is one beat (beatLength = 0.25) and there is no tempo change other than at the start;
 * getBpm already converts the beat unit declared in Q:, so only scaling by the speed percentage remains.
 */
export function beatHintFor(tune: BeatHintSource, speedPercent: number): number | null {
  if (tune.getBeatLength() !== 0.25) {
    return null;
  }
  const locations = tune.tempoLocations;
  if (typeof locations !== 'object' || locations === null) {
    return null;
  }
  for (const key of Object.keys(locations)) {
    if (Number(key) > 0) {
      return null; // Mid-tune tempo change: a single hint cannot express it; interpret by position instead
    }
  }
  return Math.round((tune.getBpm() * speedPercent) / 100);
}

/** Piano's number in the General MIDI instrument table (abcjs expansion indexes by number; 0 is acoustic_grand_piano). */
const PIANO_PROGRAM = 0;

/**
 * Piano-only playback view (SPEC-ENV-07): wraps a copy prototyped on the original tune that overrides only setUpAudio,
 * unifying the expansion's instrument instructions (program / note event instrument) to piano.
 *
 * Why unify on the expansion: the synth requests soundfont samples inside init, grouped by the expansion's instrument
 * (before sequenceCallback and buffer generation); changing only the sequence mapping would mismatch "requested set vs actual placement" -
 * non-piano instructions in the material (e.g. %%MIDI program 73) would request a locally missing soundfont directory and be silently skipped at placement.
 * Why not modify the original tune: MIDI export must keep the material's instrument instructions (SPEC-EXP-05), so the original object stays intact;
 * the view's other methods (meter / pickup / beat count, etc.) reach the original via the prototype chain.
 */
export function pianoOnlyTuneView<T extends { setUpAudio: (options: SynthOptions) => AudioTracks }>(
  tune: T,
): T {
  const view = Object.create(tune) as T;
  const originalSetUpAudio = tune.setUpAudio;
  // The original expansion method reads the tune via this (formatting / lines) and must be called with the original object as this
  view.setUpAudio = (options: SynthOptions): AudioTracks => {
    const flattened = originalSetUpAudio.call(tune, options);
    for (const track of flattened.tracks) {
      for (const item of track) {
        if ('instrument' in item) {
          item.instrument = PIANO_PROGRAM;
        }
      }
    }
    return flattened;
  };
  return view;
}
