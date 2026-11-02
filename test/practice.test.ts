import { describe, expect, it } from 'vitest';
import {
  MAX_MUTED_VOICES,
  MAX_PRACTICE_TUNES,
  PRACTICE_SCHEMA_VERSION,
  defaultPracticeUiPreferences,
  mergePracticeRecords,
  parsePracticeRecord,
  practiceStorageKey,
  type PracticeRecord,
  type PracticeTuneRecord,
} from '../src/core/practice';

const settings = { speed: 100, loop: false, chordsMuted: false, mutedVoices: [3, 1] };
const tune: PracticeTuneRecord = { id: 'tune-a', signature: '[[0,"Piano"]]', settings };
const record = (tunes: PracticeTuneRecord[] = [tune]): PracticeRecord => ({
  version: PRACTICE_SCHEMA_VERSION,
  ui: defaultPracticeUiPreferences(),
  tunes,
});

describe('practice record model', () => {
  it('[SPEC-SET-08] normalizes order and duplicates, keeps lightweight settings and writes no ABC', () => {
    expect(parsePracticeRecord(record())).toEqual({
      version: PRACTICE_SCHEMA_VERSION,
      ui: { keyboardCollapsed: false, keyboardMode: 'tune' },
      tunes: [{ id: 'tune-a', signature: '[[0,"Piano"]]', settings: { speed: 100, loop: false, chordsMuted: false, mutedVoices: [1, 3] } }],
    });
    expect(practiceStorageKey('file:///book.abc')).toBe('abcdesk.practice.v1:file:///book.abc');
  });

  it('[SPEC-SET-04] mute overrides are not kept without a reliable voice signature', () => {
    const parsed = parsePracticeRecord(record([{ ...tune, signature: null }]));
    expect(parsed?.tunes[0]).toMatchObject({ signature: null, settings: { mutedVoices: [], speed: 100 } });
  });

  it('[SPEC-SET-08] falls back as a whole on shape, range or uniqueness mismatch without deleting the record', () => {
    const bad: unknown[] = [
      null,
      { ...record(), version: 2 },
      { ...record(), ui: { keyboardCollapsed: 'no', keyboardMode: 'tune' } },
      { ...record(), ui: { keyboardCollapsed: false, keyboardMode: 'all' } },
      { ...record(), tunes: 'x' },
      record([{ ...tune, id: '' }]),
      record([{ ...tune, id: 'x'.repeat(201) }]),
      record([tune, { ...tune }]),
      record([{ ...tune, signature: 3 } as unknown as PracticeTuneRecord]),
      record([{ ...tune, settings: { ...settings, speed: 24 } }]),
      record([{ ...tune, settings: { ...settings, speed: 201 } }]),
      record([{ ...tune, settings: { ...settings, speed: 99.5 } }]),
      record([{ ...tune, settings: { ...settings, loop: 'no' } as unknown as PracticeTuneRecord['settings'] }]),
      record([{ ...tune, settings: { ...settings, mutedVoices: [0.5] } }]),
      record([{ ...tune, settings: { ...settings, mutedVoices: [-1] } }]),
      record([{ ...tune, settings: { ...settings, mutedVoices: Array.from({ length: MAX_MUTED_VOICES + 1 }, () => 1) } }]),
      record(Array.from({ length: MAX_PRACTICE_TUNES + 1 }, (_, index) => ({ ...tune, id: `t${index}` }))),
    ];
    for (const value of bad) expect(parsePracticeRecord(value)).toBeUndefined();
    expect(parsePracticeRecord(record([{ ...tune, id: 'x'.repeat(200) }]))).toBeDefined();
  });

  it('[SPEC-SET-08] commit merge overwrites the same tune with the new record, keeps unmentioned tunes and caps the total', () => {
    const base = record([
      { ...tune, id: 'a', settings: { ...settings, speed: 80 } },
      { ...tune, id: 'b', settings: { ...settings, speed: 90 } },
    ]);
    const incoming = record([{ ...tune, id: 'a', settings: { ...settings, speed: 120, loop: true } }]);
    incoming.ui = { keyboardCollapsed: true, keyboardMode: 'full' };
    const merged = mergePracticeRecords(base, incoming);
    expect(merged.ui).toEqual({ keyboardCollapsed: true, keyboardMode: 'full' });
    expect(merged.tunes.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(merged.tunes[0].settings).toMatchObject({ speed: 120, loop: true });
    expect(merged.tunes[1].settings.speed).toBe(90);
    expect(mergePracticeRecords(undefined, incoming).tunes).toEqual(incoming.tunes);
    const many = record(Array.from({ length: MAX_PRACTICE_TUNES }, (_, index) => ({ ...tune, id: `old-${index}` })));
    const overflow = record([{ ...tune, id: 'new' }]);
    expect(mergePracticeRecords(many, overflow).tunes).toHaveLength(MAX_PRACTICE_TUNES);
  });
});
