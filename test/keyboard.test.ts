import { describe, expect, it } from 'vitest';
import {
  MIDDLE_C_PITCH,
  MIN_SPAN_SEMITONES,
  MIN_WHITE_KEY_WIDTH,
  PIANO_MAX_PITCH,
  PIANO_MIN_PITCH,
  collectPitches,
  computeKeyMetrics,
  computeTuneRange,
  isBlackKey,
  keyPitches,
  outOfRangePitches,
  pitchName,
} from '../src/webview/keyboard';

// Bindings in docs/spec/play.md (PLAY-08 range and expansion, PLAY-09 hint semantics, STATE-05 all-rest scores);
// titles are prefixed with [SPEC-domain-number] and checked both ways by scripts/spec-check.mjs.

describe('keyboard range algorithm (SPEC-PLAY-08)', () => {
  it('[SPEC-PLAY-08] material pitches are deduplicated and sorted, missing pitches ignored', () => {
    const pitches = collectPitches([
      { midiPitches: [{ pitch: 64 }, { pitch: 60 }] },
      { midiPitches: [{ pitch: 64 }, {}] },
      {},
      { midiPitches: [{ pitch: 67 }] },
    ]);

    expect(pitches).toEqual([60, 64, 67]);
  });

  it('[SPEC-PLAY-08] a wide material range is kept as is; a narrow one is centered and expanded to at least two octaves', () => {
    // Exactly two octaves: no expansion
    expect(computeTuneRange([60, 84])).toEqual({ start: 60, end: 84 });

    // Narrow range: expanded around the center, spans two octaves and still covers the material
    const narrow = computeTuneRange([60, 64]);
    expect(narrow.end - narrow.start).toBe(MIN_SPAN_SEMITONES);
    expect(narrow.start).toBeLessThanOrEqual(60);
    expect(narrow.end).toBeGreaterThanOrEqual(64);
    expect((narrow.start + narrow.end) / 2).toBe((60 + 64) / 2);
  });

  it('[SPEC-PLAY-08] a range at the edge keeps at least two octaves after clamping to A0–C8', () => {
    const low = computeTuneRange([PIANO_MIN_PITCH]);
    expect(low.start).toBe(PIANO_MIN_PITCH);
    expect(low.end - low.start).toBe(MIN_SPAN_SEMITONES);

    const high = computeTuneRange([PIANO_MAX_PITCH]);
    expect(high.end).toBe(PIANO_MAX_PITCH);
    expect(high.end - high.start).toBe(MIN_SPAN_SEMITONES);
  });

  it('[SPEC-PLAY-08] notes outside A0–C8 do not take part in the range (reported separately by the description line, not folded back)', () => {
    const range = computeTuneRange([10, 30, 50]);
    expect(range.start).toBeGreaterThanOrEqual(PIANO_MIN_PITCH);
    expect(range.end).toBeLessThanOrEqual(PIANO_MAX_PITCH);
    expect(range.end - range.start).toBeGreaterThanOrEqual(MIN_SPAN_SEMITONES);

    expect(outOfRangePitches([20, PIANO_MIN_PITCH, 60, PIANO_MAX_PITCH, 109])).toEqual([20, 109]);
    expect(outOfRangePitches([21, 60, 108])).toEqual([]);
  });

  it('[SPEC-PLAY-08][SPEC-STATE-05] material without pitches returns the default two-octave reference range', () => {
    const range = computeTuneRange([]);
    expect(range.end - range.start).toBe(MIN_SPAN_SEMITONES);
    // The default reference range is centered on middle C (all-rest material still shows the reference space and explains there is no pitch to hint)
    expect(range.start).toBeLessThanOrEqual(MIDDLE_C_PITCH);
    expect(range.end).toBeGreaterThanOrEqual(MIDDLE_C_PITCH);
  });

  it('[SPEC-PLAY-08] full 88-key mode is fixed to A0–C8, tune mode follows the computed range', () => {
    const tuneRange = computeTuneRange([60, 64]);
    const tuneKeys = keyPitches('tune', tuneRange);
    expect(tuneKeys[0]).toBe(tuneRange.start);
    expect(tuneKeys[tuneKeys.length - 1]).toBe(tuneRange.end);

    const fullKeys = keyPitches('full', tuneRange);
    expect(fullKeys).toHaveLength(88);
    expect(fullKeys[0]).toBe(PIANO_MIN_PITCH);
    expect(fullKeys[fullKeys.length - 1]).toBe(PIANO_MAX_PITCH);
  });

  it('[SPEC-PLAY-08] note names label the octave of each C, middle C is labelled C4', () => {
    expect(pitchName(PIANO_MIN_PITCH)).toBe('A0');
    expect(pitchName(MIDDLE_C_PITCH)).toBe('C4');
    expect(pitchName(61)).toBe('C#4');
    expect(pitchName(PIANO_MAX_PITCH)).toBe('C8');
  });

  it('[SPEC-PLAY-08] black and white key layout follows 12-tone equal temperament', () => {
    // White keys: C D E F G A B
    for (const pitch of [60, 62, 64, 65, 67, 69, 71]) {
      expect(isBlackKey(pitch)).toBe(false);
    }
    // Black keys: C# D# F# G# A#
    for (const pitch of [61, 63, 66, 68, 70]) {
      expect(isBlackKey(pitch)).toBe(true);
    }
  });

  it('[SPEC-PLAY-08] key sizes keep a minimum key width, scroll horizontally rather than compress; height has upper and lower bounds', () => {
    // Narrow container: white key width is kept at the minimum (88 keys stay legible)
    const narrow = computeKeyMetrics(200, 52);
    expect(narrow.whiteWidth).toBe(MIN_WHITE_KEY_WIDTH);
    expect(narrow.blackWidth).toBeCloseTo(MIN_WHITE_KEY_WIDTH * 0.6);
    expect(narrow.blackOffset).toBeCloseTo(-narrow.blackWidth / 2);

    // Zero width (hidden / not laid out): same minimum, no invalid sizes
    expect(computeKeyMetrics(0, 15).whiteWidth).toBe(MIN_WHITE_KEY_WIDTH);

    // Wide container: white keys spread out, height scales proportionally under the upper bound
    const wide = computeKeyMetrics(1600, 15);
    expect(wide.whiteWidth).toBeGreaterThan(MIN_WHITE_KEY_WIDTH);
    expect(wide.whiteHeight).toBeLessThanOrEqual(96);
    expect(wide.whiteHeight).toBeGreaterThanOrEqual(52);
    expect(wide.blackHeight).toBeLessThan(wide.whiteHeight);
  });
});
