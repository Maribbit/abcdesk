import { readFileSync } from 'node:fs';
import { parseOnly, type AbcElem, type AudioTracks } from 'abcjs';
import { describe, expect, it } from 'vitest';
import {
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  beatHintFor,
  clampSpeed,
  collectVoices,
  formatClock,
  hasChordTrack,
  parseSpeedPercent,
  pianoOnlyTuneView,
} from '../src/webview/playback';

// Bindings in docs/spec/play.md (PLAY-04 speed, PLAY-05 progress, PLAY-06 voices);
// the PLAY domain is verified manually (registered in docs/manual-checks.md); test titles additionally reference the items for coverage checks.

describe('speed conversion and parsing (SPEC-PLAY-04)', () => {
  it('[SPEC-PLAY-04] out-of-range values are clamped to 25–200 and rounded; non-numbers fall back to the default', () => {
    expect(clampSpeed(10)).toBe(SPEED_MIN);
    expect(clampSpeed(0)).toBe(SPEED_MIN);
    expect(clampSpeed(-40)).toBe(SPEED_MIN);
    expect(clampSpeed(201)).toBe(SPEED_MAX);
    expect(clampSpeed(1000)).toBe(SPEED_MAX);
    expect(clampSpeed(72.4)).toBe(72);
    expect(clampSpeed(72.6)).toBe(73);
    expect(clampSpeed(SPEED_DEFAULT)).toBe(SPEED_DEFAULT);
    expect(clampSpeed(Number.NaN)).toBe(SPEED_DEFAULT);
  });

  it('[SPEC-PLAY-04] input parsing: empty and non-numeric give null (restore), out-of-range values are clamped rather than rejected', () => {
    expect(parseSpeedPercent('')).toBeNull();
    expect(parseSpeedPercent('   ')).toBeNull();
    expect(parseSpeedPercent('abc')).toBeNull();
    expect(parseSpeedPercent('120%')).toBeNull();
    expect(parseSpeedPercent('25')).toBe(SPEED_MIN);
    expect(parseSpeedPercent('250')).toBe(SPEED_MAX);
    expect(parseSpeedPercent('-40')).toBe(SPEED_MIN);
    expect(parseSpeedPercent('12.5')).toBe(SPEED_MIN);
    expect(parseSpeedPercent('72.5')).toBe(73);
    expect(parseSpeedPercent(' 80 ')).toBe(80);
  });

  it('[SPEC-PLAY-04] BPM hint: scales with speed when the conversion is reliable; mid-tune tempo changes / non-quarter beats / missing data show nothing', () => {
    const base = { getBeatLength: () => 0.25, getBpm: () => 120, tempoLocations: {} };
    expect(beatHintFor(base, 100)).toBe(120);
    expect(beatHintFor(base, 75)).toBe(90);
    expect(beatHintFor(base, 150)).toBe(180);
    // A Q: at the start of the tune (key 0) counts as a uniform tempo (getBpm already read the Q: value)
    expect(beatHintFor({ getBeatLength: () => 0.25, getBpm: () => 132, tempoLocations: { 0: 132 } }, 100)).toBe(132);
    // Mid-tune tempo change: no guessed value is shown
    expect(beatHintFor({ ...base, tempoLocations: { 0: 132, 5: 88 } }, 100)).toBeNull();
    expect(beatHintFor({ ...base, tempoLocations: { 3: 88 } }, 100)).toBeNull();
    // Non-quarter beat (compound meter etc.): no conversion
    expect(beatHintFor({ ...base, getBeatLength: () => 0.375 }, 100)).toBeNull();
    // Missing data: nothing shown
    expect(beatHintFor({ ...base, tempoLocations: undefined }, 100)).toBeNull();
  });
});

describe('progress time display (SPEC-PLAY-05)', () => {
  it('[SPEC-PLAY-05] milliseconds display as M:SS; negative and non-finite values display as 0', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(12_000)).toBe('0:12');
    expect(formatClock(59_999)).toBe('0:59');
    expect(formatClock(204_000)).toBe('3:24');
    expect(formatClock(3_600_000)).toBe('60:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('voice list (SPEC-PLAY-06)', () => {
  it('[SPEC-PLAY-06] voices are collected in performance order, the name is the first non-empty one and the count is the maximum across lines', () => {
    const tune = {
      lines: [
        // First line: one staff with two voices, the first named, the second unnamed
        { staff: [{ clef: { type: 'treble' }, voices: [{}, {}], title: ['Flute', undefined] }] },
        // TAB staves are skipped and not counted as voices
        { staff: [{ clef: { type: 'TAB' }, voices: [{}, {}, {}], title: ['T1', 'T2', 'T3'] }] },
        // Counting continues across staves within a line; the title was empty before and is filled with a non-empty name here
        { staff: [{ clef: { type: 'treble' }, voices: [{}, {}], title: ['', ''] }, { clef: { type: 'bass' }, voices: [{}], title: ['Cello'] }] },
      ],
    };

    expect(collectVoices(tune)).toEqual([
      { index: 0, name: 'Flute' },
      { index: 1, name: null },
      { index: 2, name: 'Cello' },
    ]);
  });

  it('[SPEC-PLAY-06] the first non-empty title on later lines fills in an unnamed voice; an empty title stays unnamed', () => {
    const tune = {
      lines: [
        { staff: [{ voices: [{}, {}] }] },
        { staff: [{ voices: [{}, {}], title: ['', 'Viola'] }] },
      ],
    };

    expect(collectVoices(tune)).toEqual([
      { index: 0, name: null },
      { index: 1, name: 'Viola' },
    ]);
    expect(collectVoices({})).toEqual([]);
  });
});

describe('chord track detection (SPEC-PLAY-06)', () => {
  it('[SPEC-PLAY-06] the chord track is detected by channel equal to the voice count; drum tracks and no extra track are not misjudged', () => {
    const voices = [
      [{ cmd: 'program', channel: 0 }],
      [{ cmd: 'program', channel: 1 }],
    ];
    // Chord track channel = voice count (2)
    expect(hasChordTrack([...voices, [{ cmd: 'program', channel: 2 }]], 2)).toBe(true);
    // Drum track channel = voice count + 1, not a chord track
    expect(hasChordTrack([...voices, [{ cmd: 'program', channel: 3, instrument: 128 }]], 2)).toBe(false);
    // No extra track
    expect(hasChordTrack(voices, 2)).toBe(false);
    // The first event of the extra track is not a program (no chords)
    expect(hasChordTrack([...voices, [{ cmd: 'note', channel: 2 }]], 2)).toBe(false);
    // Defensive: non-array input
    expect(hasChordTrack(undefined, 2)).toBe(false);
  });
});

// Real complex material supplements the structural stub tests: parse and expand events only, without creating an AudioContext or downloading soundfonts.
const originalSample = readFileSync(
  new URL('../samples/09-lanterns-on-the-tide.abc', import.meta.url),
  'utf8',
);

describe('sample 09 original tune: multi-voice and mixed meter regression', () => {
  it('[SPEC-PLAY-06] no parse warnings, four voices with 49 bars each and consistent per-bar durations', () => {
    const tunes = parseOnly(originalSample);
    expect(tunes).toHaveLength(1);
    const tune = tunes[0];
    expect(tune.warnings ?? []).toEqual([]);
    expect(collectVoices(tune)).toEqual([
      { index: 0, name: '旋律' },
      { index: 1, name: '应答' },
      { index: 2, name: '织体' },
      { index: 3, name: '低音' },
    ]);
    const bars = Array.from({ length: 4 }, () => [] as number[]);
    const durations = [0, 0, 0, 0];
    const multipliers = [1, 1, 1, 1];
    const meters = new Set<string>();
    for (const line of tune.lines) {
      for (const [voiceIndex, staff] of (line.staff ?? []).entries()) {
        expect(staff.voices).toHaveLength(1);
        for (const meter of staff.meter?.value ?? []) {
          meters.add(`${meter.num}/${meter.den}`);
        }
        for (const item of staff.voices?.[0] ?? []) {
          if (item.el_type === 'note') {
            // abcjs keeps tuplet durations separately in tripletMultiplier; grace notes take no extra time from the main note.
            const note = item as AbcElem;
            if (note.startTriplet !== undefined) {
              multipliers[voiceIndex] = note.tripletMultiplier ?? 1;
            }
            durations[voiceIndex] += item.duration * multipliers[voiceIndex];
            if (note.endTriplet) {
              multipliers[voiceIndex] = 1;
            }
          } else if (item.el_type === 'bar' && durations[voiceIndex] > 0) {
            bars[voiceIndex].push(durations[voiceIndex]);
            durations[voiceIndex] = 0;
          }
        }
      }
    }
    expect([...meters].sort()).toEqual(['3/4', '4/4', '6/8']);
    expect(durations).toEqual([0, 0, 0, 0]);
    for (const voiceBars of bars) {
      expect(voiceBars).toHaveLength(49);
      voiceBars.forEach((duration, index) => {
        // Written bars 26–33 are 4/4, the rest 6/8 or 3/4 (durations in whole-note units).
        expect(duration, `written bar ${index + 1}`).toBeCloseTo(index >= 25 && index < 33 ? 1 : 0.75);
      });
    }
  });

  it('[SPEC-PLAY-04] [SPEC-PLAY-05] first/second endings and six tempo sections expand to a performance of about 108 seconds', () => {
    const tune = parseOnly(originalSample)[0];
    const firstNote = tune.lines.flatMap((line) => line.staff?.[0].voices?.[0] ?? [])
      .find((item) => item.el_type === 'note');
    expect(firstNote).toBeDefined();
    const audio = tune.setUpAudio({});
    const firstOccurrences = audio.tracks[0].filter(
      (event) => event.cmd === 'note' && event.startChar === firstNote?.startChar,
    );
    expect(firstOccurrences).toHaveLength(2);
    // A expands to 16 bars, the other five sections 8 bars each; the reference time is computed per section beat unit, not from a single BPM.
    const expectedSeconds = 16 * 120 / 66 + 8 * 120 / 72 + 8 * 180 / 90
      + 8 * 240 / 108 + 8 * 120 / 66 + 8 * 120 / 56;
    // Same gauge as CreateSynth.prime: the tempo's beat unit is not always a quarter note, so 240 / BPM cannot be used directly.
    const secondsPerWholeNote = tune.millisecondsPerMeasure() / 1000 / tune.getBarLength();
    expect(audio.totalDuration * secondsPerWholeNote).toBeCloseTo(expectedSeconds, 3);
    for (const track of audio.tracks.slice(0, 4)) {
      const end = Math.max(...track.map((event) => event.cmd === 'note' ? event.start + event.duration : 0));
      expect(end * secondsPerWholeNote).toBeCloseTo(expectedSeconds, 3);
    }
  });

  it('[SPEC-PLAY-06] [SPEC-PLAY-10] automatic chords form their own track; muting answer and texture does not affect melody and bass', () => {
    const audio = parseOnly(originalSample)[0].setUpAudio({});
    expect(audio.tracks).toHaveLength(5);
    expect(hasChordTrack(audio.tracks, 4)).toBe(true);
    const muted = parseOnly(originalSample)[0].setUpAudio({ voicesOff: [1, 2], chordsOff: true });
    expect(muted.tracks).toHaveLength(4);
    expect(hasChordTrack(muted.tracks, 4)).toBe(false);
    expect(muted.totalDuration).toBeCloseTo(audio.totalDuration);
    muted.tracks.forEach((track, index) => {
      const notes = track.filter((event) => event.cmd === 'note');
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.some((note) => note.volume > 0)).toBe(index === 0 || index === 3);
    });
  });
});

// Playback-side soundfont regression (SPEC-ENV-07): only the piano directory is bundled locally, and the synth requests soundfont samples inside init
// from the expanded output's instrument, silently skipping missing instruments when placing - remapping the sequence (sequenceCallback) alone is not enough,
// the expanded output itself must be unified to piano while the original tune object keeps the material's directives (basis for MIDI export, SPEC-EXP-05).
describe('piano-unified playback view (SPEC-ENV-07)', () => {
  /** Instrument index of each track's first program event (music tracks always have one); null for tracks without a program. */
  function trackInstruments(audio: AudioTracks): Array<number | null> {
    return audio.tracks.map((track) => {
      const program = track.find((item) => item.cmd === 'program');
      return program && program.cmd === 'program' ? program.instrument : null;
    });
  }

  it('[SPEC-ENV-07] all instrument directives in the expanded output are unified to piano, the original tune object keeps the material directives', () => {
    // The in-voice %%MIDI program (non-piano) in sample 03 and the tune-level %%MIDI program 73 in sample 09 are the two known paths
    for (const name of ['03-voices-midi.abc', '09-lanterns-on-the-tide.abc']) {
      const source = readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8');
      const tune = parseOnly(source)[0];
      const original = trackInstruments(tune.setUpAudio({}));
      expect(original.some((instrument) => instrument !== 0)).toBe(true);
      const flattened = pianoOnlyTuneView(tune).setUpAudio({});
      for (const track of flattened.tracks) {
        for (const item of track) {
          if ('instrument' in item) {
            expect(item.instrument).toBe(0);
          }
        }
      }
      // The playback view must not modify the original tune: instrument directives in the material are kept as is
      expect(trackInstruments(tune.setUpAudio({}))).toEqual(original);
    }
  });
});
