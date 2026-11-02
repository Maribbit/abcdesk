import { parseOnly } from 'abcjs';
import { describe, expect, it } from 'vitest';
import { appendSource, appendSynthetic, emptyMappedText, normalizeSource, toSourceRange } from '../src/core/sourceMap';
import { createTuneCatalog, matchTune, tuneAtSource } from '../src/core/tunes';
import { TuneSession, defaultMusicSettings } from '../src/core/tuneSession';

const first = 'X:1\nT:同名\nK:C\nCDEF|';
const second = 'X:2\nT:同名\nK:G\nGABc|';
const book = `${first}\n\n${second}`;
const snapshot = (abc = book, version = 1) => ({ uri: 'file:///tunes.abc', version, abc });

function noteRanges(text: string): Array<{ startChar: number; endChar: number }> {
  return parseOnly(text)[0].lines.flatMap((line) => (line.staff ?? []).flatMap((staff) => (staff.voices ?? []).flat()))
    .filter((item) => item?.el_type === 'note') as Array<{ startChar: number; endChar: number }>;
}

describe('tune catalog and mapping', () => {
  it('[SPEC-DOC-01] keeps order, duplicate names, missing titles and empty X:; blanks create no tunes', () => {
    expect(createTuneCatalog(book).tunes.map(({ id, title, index }) => ({ id, title, index }))).toEqual([
      { id: '1', title: '同名', index: 0 }, { id: '2', title: '同名', index: 1 },
    ]);
    expect(createTuneCatalog('X:\nK:C\nC|').tunes[0]).toMatchObject({ id: null, title: '', reliable: true });
    expect(createTuneCatalog(' \n% comment\n').tunes).toEqual([]);
    expect(createTuneCatalog('T:Solo\nK:C\nC|').tunes[0].id).toBeNull();
  });

  it.each(['\n', '\r\n', '\r'])('[SPEC-DOC-06] with %j line endings, BOM, CJK text and surrogate pairs the second tune\'s source range is exact', (eol) => {
    const source = `\uFEFF \n% 中文 \uD840\uDC00\nM:3/4\nL:1/16\n%%MIDI program 40\n${book}`.replaceAll('\n', eol);
    const catalog = createTuneCatalog(source);
    expect(catalog.issues).toEqual([]);
    for (const tune of catalog.tunes) {
      expect(tune.reliable).toBe(true);
      const notes = noteRanges(tune.input.text);
      const expected = tune.id === '1' ? 'CDEF' : 'GABc';
      expect(notes.map((note) => {
        const range = toSourceRange(tune.input, note.startChar, note.endChar)!;
        return source.slice(range.start, range.end);
      }).join('')).toBe(expected);
      expect(tune.input.text.match(/%%MIDI program 40/g)).toHaveLength(1);
      expect(parseOnly(tune.input.text)[0].getMeterFraction()).toEqual({ num: 3, den: 4 });
    }
    expect(tuneAtSource(catalog, source.indexOf('M:'))).toBeUndefined();
    expect(tuneAtSource(catalog, source.indexOf('GABc'))?.id).toBe('2');
  });

  it('[SPEC-DOC-06] local fields override the shared defaults and do not leak into the next tune', () => {
    const catalog = createTuneCatalog(`M:3/4\nL:1/16\nU:H=!fermata!\nI:staffwidth 500\n${first.replace('K:C', 'M:2/4\nL:1/8\nK:C')}\n\n${second}`);
    const tunes = catalog.tunes.map((tune) => parseOnly(tune.input.text)[0]);
    expect(tunes.map((tune) => tune.getMeterFraction())).toEqual([{ num: 2, den: 4 }, { num: 3, den: 4 }]);
    const durations = tunes.map((tune) => tune.lines[0].staff![0].voices![0]!.find((item) => item.el_type === 'note'));
    expect(durations.map((note) => note && 'duration' in note ? note.duration : null)).toEqual([0.125, 0.0625]);
  });

  it('[SPEC-DOC-06] shared text fields and continuation lines are overridden wholesale by local fields; U/I/directives override per key', () => {
    const source = 'C:公共作曲者\n+:公共续行\nN:公共注释\nU:H=!fermata!\nU:J=!trill!\nI:linebreak $\n%%staffwidth 500\n' +
      first.replace('K:C\nCDEF|', 'C:本曲作曲者\nN:本曲注释\nU:H=!accent!\n%%staffwidth 600\nK:C\nHCJDEF|') + '\n\n' + second;
    const catalog = createTuneCatalog(source);
    const [local, inherited] = catalog.tunes.map((tune) => parseOnly(tune.input.text)[0]);
    expect(local.metaText.composer).toBe('本曲作曲者');
    expect(local.metaText.notes).toBe('本曲注释');
    expect(inherited.metaText.composer).toContain('公共作曲者');
    expect(inherited.metaText.notes).toBe('公共注释');
    expect(catalog.tunes[0].input.text).not.toContain('公共续行');
    expect(local.formatting.staffwidth).toBe(600);
    expect(inherited.formatting.staffwidth).toBe(500);
    const notes = local.lines.flatMap((line) => (line.staff ?? []).flatMap((staff) => (staff.voices ?? []).flat()))
      .filter((note) => note?.el_type === 'note');
    expect(notes[0]).toMatchObject({ decoration: ['accent'] });
    expect(notes[1]).toMatchObject({ decoration: ['trill'] });
    expect(catalog.tunes[0].input.text).toContain('I:linebreak $');
  });

  it.each(['\n', '\r\n', '\r'])('[SPEC-DOC-06] leading blanks/comments without X: do not shift the actual notes %j', (eol) => {
    const source = '\uFEFF \n% 注释\n\nK:C\nCDEF|'.replaceAll('\n', eol);
    const catalog = createTuneCatalog(source);
    expect(catalog.initialBlocked).toBe(false);
    expect(catalog.tunes[0].reliable).toBe(true);
    expect(noteRanges(catalog.tunes[0].input.text).map((note) => {
      const range = toSourceRange(catalog.tunes[0].input, note.startChar, note.endChar)!;
      return source.slice(range.start, range.end);
    }).join('')).toBe('CDEF');
  });

  it('[SPEC-DOC-06] unclosed / mismatched directive blocks cannot silently output partial tunes; plain notes create no tune', () => {
    for (const abc of ['X:1\nK:C\nC|\n%%begintext\n说明', 'X:1\n%%begintext\n说明\n%%endps\nK:C\nC|']) {
      const catalog = createTuneCatalog(abc);
      expect(catalog.issues.length).toBeGreaterThan(0);
      expect(catalog.tunes[0].reliable).toBe(false);
    }
    expect(createTuneCatalog(`${first}\n\n练习说明：请慢练。\n\n${second}`).issues).toEqual([]);
    const source = `${first}\n\n"Am"GABc|\n\n${second}`;
    expect(tuneAtSource(createTuneCatalog(source), source.indexOf('GABc'))).toBeUndefined();
    expect(createTuneCatalog(source).issues.length).toBeGreaterThan(0);
  });

  it('[SPEC-DOC-06] synthesized characters, inherited headers and non-contiguous ranges are not mapped', () => {
    const source = normalizeSource('M:3/4\r\nCDEF');
    const mapped = emptyMappedText();
    appendSource(mapped, source, 0, 6, false);
    appendSynthetic(mapped, '\n');
    appendSource(mapped, source, 6, source.text.length);
    expect(toSourceRange(mapped, 0, 1)).toBeUndefined();
    expect(toSourceRange(mapped, 6, 7)).toBeUndefined();
    expect(toSourceRange(mapped, 7, 8)).toEqual({ start: 7, end: 8 });
    expect(toSourceRange(mapped, -1, 1)).toBeUndefined();
    expect(toSourceRange(mapped, 8, 7)).toBeUndefined();
    expect(toSourceRange(mapped, 0, 100)).toBeUndefined();
  });

  it('[SPEC-DOC-06] leading music without X: is not skipped automatically; later explicit tunes stay selectable', () => {
    const catalog = createTuneCatalog(`T:Missing\nK:C\nCDEF|\n\n${second}`);
    expect(catalog.initialBlocked).toBe(true);
    expect(catalog.issues.length).toBeGreaterThan(0);
    expect(catalog.tunes[0]).toMatchObject({ id: '2', reliable: true });
    const session = new TuneSession();
    session.receive(snapshot(catalog.source), false);
    expect(session.selected).toBeNull();
    expect(session.select(0)).toBe(true);
  });

  it('[SPEC-DOC-06] suspected music after a blank line is not treated as rendered, nor are tunes split by title', () => {
    const source = `${first}\n\nT:Missing\nK:C\nABcd|\n\n${second}`;
    const catalog = createTuneCatalog(source);
    expect(catalog.tunes).toHaveLength(2);
    expect(catalog.issues.length).toBeGreaterThan(0);
    expect(tuneAtSource(catalog, source.indexOf('ABcd'))).toBeUndefined();
    expect(catalog.tunes[1].reliable).toBe(true);
    expect(createTuneCatalog('K:C\nCDEF|\n\nK:G\nGABc|').tunes[0].reliable).toBe(false);
  });

  it('[SPEC-DOC-06] a fake X: inside a text block does not become a tune; the affected tune is explicitly unavailable', () => {
    const catalog = createTuneCatalog(`X:1\n%%begintext\nX:fake\n%%endtext\nK:C\nC|\n\n${second}`);
    expect(catalog.tunes.map((tune) => tune.id)).toEqual(['1', '2']);
    expect(catalog.tunes.map((tune) => tune.reliable)).toEqual([false, true]);
  });

  it('[SPEC-DOC-06] local errors do not filter out tunes; an all-rest tune has real note entries', () => {
    const catalog = createTuneCatalog(`X:1\nK:invalid\n???\n\nX:2\nK:C\nz4|`);
    expect(catalog.tunes).toHaveLength(2);
    expect(noteRanges(catalog.tunes[1].input.text)).toHaveLength(1);
  });
});

describe('strict identity and session switching', () => {
  it('[SPEC-DOC-05] reordering matches by unique X:, not by same name or old index', () => {
    const previous = createTuneCatalog(book);
    expect(matchTune(previous, 0, createTuneCatalog(`${second}\n\n${first}`))).toBe(1);
    expect(matchTune(previous, 0, createTuneCatalog(second))).toBeNull();
    expect(matchTune(previous, 0, createTuneCatalog(first.replace('X:1', 'X:3')))).toBeNull();
  });

  it.each([first.replace('X:1\n', ''), book.replace('X:2', 'X:1')])('[SPEC-DOC-05] missing or duplicate X: does not match across versions', (abc) => {
    expect(matchTune(createTuneCatalog(abc), 0, createTuneCatalog(abc))).toBeNull();
  });

  it('[SPEC-DOC-02] a new preview defaults to the first tune, repeating the same snapshot does not reset, reopening returns to the first tune', () => {
    const session = new TuneSession();
    expect(session.receive(snapshot(), false)).toBe(true);
    expect(session.selected).toBe(0);
    session.select(1);
    expect(session.receive(snapshot(), false)).toBe(false);
    expect(session.selected).toBe(1);
    const reopened = new TuneSession();
    reopened.receive(snapshot(), false);
    expect(reopened.selected).toBe(0);
  });

  it('[SPEC-DOC-04] the catalog is frozen during playback; switching tunes applies the latest document first, then matches', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    const request = session.beginSelection(1)!;
    session.receive(snapshot(`${second}\n\n${first}`, 2), true);
    expect(session.current?.id).toBe('1');
    expect(session.catalog.tunes[0].id).toBe('1');
    expect(session.completeSelection(request.id, snapshot())).toBe(true);
    expect(session.selected).toBe(0);
    expect(session.current?.id).toBe('2');
  });

  it('[SPEC-DOC-03] repeating the current selection has no effect; cancelled or superseded selection responses are void', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    expect(session.beginSelection(0)).toBeUndefined();
    const request = session.beginSelection(1)!;
    session.cancelSelection();
    expect(session.completeSelection(request.id, snapshot())).toBe(false);
    const newer = session.beginSelection(1)!;
    expect(session.completeSelection(request.id, snapshot())).toBe(false);
    expect(session.completeSelection(newer.id, snapshot())).toBe(true);
  });

  it('[SPEC-DOC-05] updating a single tune without X: requires explicit confirmation', () => {
    const session = new TuneSession();
    session.receive(snapshot('K:C\nCDEF|'), false);
    session.receive(snapshot('K:C\nGABc|', 2), false);
    expect(session.selected).toBeNull();
    expect(session.select(0)).toBe(true);
  });

  it('[SPEC-SET-03] [SPEC-DOC-03] per-tune settings do not cross over; switching back within the same snapshot restores settings but not position', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.remember({ speed: 70, loop: true, chordsMuted: true, mutedVoices: [0] }, 'voice');
    session.select(1);
    expect(session.settingsFor('voice').settings).toEqual(defaultMusicSettings());
    session.select(0);
    expect(session.settingsFor('voice').settings.speed).toBe(70);
  });

  it('[SPEC-SET-04] a voice change clears only the whole mute set, not speed, loop or accompaniment settings', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.remember({ speed: 70, loop: true, chordsMuted: true, mutedVoices: [0, 1] }, 'old');
    session.receive(snapshot(book + '\n% update', 2), false);
    expect(session.settingsFor('new')).toEqual({
      settings: { speed: 70, loop: true, chordsMuted: true, mutedVoices: [] }, voicesChanged: true,
    });
    expect(session.settingsFor('old').settings.mutedVoices).toEqual([0, 1]);
  });

  it.each(['new', null])('[SPEC-SET-04] without old mute overrides a voice change or unknown signature still notifies: %j', (signature) => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.remember(defaultMusicSettings(), 'old');
    session.receive(snapshot(book + '\n% update', 2), false);
    expect(session.settingsFor('old').voicesChanged).toBe(false);
    const restored = session.settingsFor(signature);
    expect(restored).toEqual({ settings: defaultMusicSettings(), voicesChanged: true });
    session.remember(restored.settings, signature);
    expect(session.settingsFor(signature).voicesChanged).toBe(false);
  });

  it('[SPEC-DOC-05] a temporary blank does not erase records; a number reappearing after explicit deletion inherits nothing', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.remember({ ...defaultMusicSettings(), speed: 60 }, 'v');
    session.receive(snapshot('', 2), false);
    session.receive(snapshot(book, 3), false);
    expect(session.current?.id).toBe('1');
    expect(session.settingsFor('v').settings.speed).toBe(60);
    session.receive(snapshot(second, 4), false);
    session.receive(snapshot(book, 5), false);
    session.select(0);
    expect(session.settingsFor('v').settings.speed).toBe(100);
  });

  it('[SPEC-LIFE-03] a reliable migration updates only the identity; snapshot, paused version and settings records carry over', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.remember({ ...defaultMusicSettings(), speed: 60 }, 'v');
    session.receive(snapshot(book + '\n% pending', 2), true);
    session.rekey('file:///moved.abc');
    expect(session.snapshot?.uri).toBe('file:///moved.abc');
    expect(session.pending?.uri).toBe('file:///moved.abc');
    // The new version after migration is still the same document: settings records carry over instead of being cleared
    session.receive({ uri: 'file:///moved.abc', version: 2, abc: book + '\n% pending' }, false);
    expect(session.current?.id).toBe('1');
    expect(session.settingsFor('v').settings.speed).toBe(60);
  });

  it('[SPEC-SET-02] [SPEC-SET-03] tune settings are restored by real X:; unmatched records are not applied', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.restore([
      { id: '2', signature: 'v2', settings: { speed: 60, loop: true, chordsMuted: false, mutedVoices: [1] } },
      { id: 'missing', signature: 'other', settings: { speed: 40, loop: false, chordsMuted: false, mutedVoices: [] } },
    ]);
    expect(session.settingsFor('v1').settings).toEqual(defaultMusicSettings());
    session.select(1);
    expect(session.settingsFor('v2')).toEqual({
      settings: { speed: 60, loop: true, chordsMuted: false, mutedVoices: [1] },
      voicesChanged: false,
    });
    // Restored records are also checked against the ordered voice list: on mismatch only mutes are cleared with a notice
    expect(session.settingsFor('changed')).toEqual({
      settings: { speed: 60, loop: true, chordsMuted: false, mutedVoices: [] },
      voicesChanged: true,
    });
  });

  it('[SPEC-SET-04] when the voice signature cannot be confirmed on restore, mutes are cleared with a notice', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.restore([{ id: '1', signature: null, settings: { speed: 80, loop: false, chordsMuted: true, mutedVoices: [] } }]);
    expect(session.settingsFor(null)).toEqual({
      settings: { speed: 80, loop: false, chordsMuted: true, mutedVoices: [] },
      voicesChanged: true,
    });
  });

  it('[SPEC-SET-08] export contains only real X: and lightweight settings; reset clears every tune record', () => {
    const session = new TuneSession();
    session.receive(snapshot(), false);
    session.remember({ speed: 60, loop: true, chordsMuted: false, mutedVoices: [2, 0] }, 'v1');
    session.select(1);
    session.remember({ speed: 80, loop: false, chordsMuted: true, mutedVoices: [] }, null);
    const exported = session.exportRecords();
    expect(exported.map((entry) => entry.id)).toEqual(['1', '2']);
    expect(exported[0]).toMatchObject({ signature: 'v1', settings: { speed: 60, mutedVoices: [0, 2] } });
    // No mutes are kept without a reliable signature, so the next restore does not misapply them
    expect(exported[1]).toMatchObject({ signature: null, settings: { mutedVoices: [] } });
    session.clearRecords();
    expect(session.exportRecords()).toEqual([]);
    expect(session.settingsFor('v1').settings).toEqual(defaultMusicSettings());
  });
});
