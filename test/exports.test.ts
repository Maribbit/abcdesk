// Hardening tests for the export core modules: tune parsing, file name suggestion and the key behaviors and edge cases of MIDI / SVG generation.
// The EXP domain is verified manually (registered in docs/manual-checks.md); only pure logic that can be verified off-screen is covered here.
import { describe, expect, it } from 'vitest';
import { loadAbcjs } from '../src/core/exports/abcjs';
import { sanitizeFileNameStem, suggestExportFileName } from '../src/core/exports/filename';
import { generateMidiBytes } from '../src/core/exports/midi';
import { generateSvgText } from '../src/core/exports/svg';
import { listTunes, tuneHasNotes } from '../src/core/exports/tunes';

const MULTI_TUNE = `% leading comment
%%MIDI program 40
X:1
T:First Tune
C:Trad.
K:C
CDEF GABc |

X:2
T:Second Tune
K:G
GABc dedB |`;

const MIDI_HEADER = new Uint8Array([0x4d, 0x54, 0x68, 0x64]); // "MThd"

describe('listTunes tune parsing', () => {
  it('multiple tunes return ordered index, X:, title and increasing start offsets', async () => {
    const tunes = await listTunes(MULTI_TUNE);
    expect(tunes.map((tune) => ({ sequence: tune.sequence, id: tune.id, title: tune.title }))).toEqual([
      { sequence: 1, id: '1', title: 'First Tune' },
      { sequence: 2, id: '2', title: 'Second Tune' },
    ]);
    expect(tunes[1].startPos).toBeGreaterThan(tunes[0].startPos);
  });

  it('each tune text is self-contained: has its own X: line and file-level %% directives, and no other tune', async () => {
    const tunes = await listTunes(MULTI_TUNE);
    expect(tunes[0].abc).toContain('X:1');
    expect(tunes[0].abc).not.toContain('Second Tune');
    expect(tunes[1].abc).toContain('X:2');
    expect(tunes[1].abc).not.toContain('First Tune');
    // File-level directives are merged into each tune exactly once (never re-concatenated with the shared header)
    for (const tune of tunes) {
      expect(tune.abc.match(/%%MIDI program 40/g)).toHaveLength(1);
    }
  });

  it('single tune and blank text both return one tune (emptiness must not rely on the tune count)', async () => {
    expect(await listTunes('X:1\nT:Solo\nK:C\nCDEF|')).toHaveLength(1);
    expect(await listTunes('')).toHaveLength(1);
  });
});

describe('tuneHasNotes emptiness check', () => {
  it('true with notes, false for blank text', async () => {
    const abcjs = await loadAbcjs();
    expect(tuneHasNotes(abcjs.parseOnly('X:1\nK:C\nCDEF GABc |]')[0])).toBe(true);
    expect(tuneHasNotes(abcjs.parseOnly('')[0])).toBe(false);
  });

  it('a valid all-rest score is not blank (rests are note entries too)', async () => {
    const abcjs = await loadAbcjs();
    expect(tuneHasNotes(abcjs.parseOnly('X:1\nK:C\nz8 |]')[0])).toBe(true);
  });
});

describe('suggestExportFileName naming suggestion', () => {
  it('a saved single tune uses the source file base name', () => {
    expect(
      suggestExportFileName({
        documentStem: 'tunes',
        tuneTitle: 'Cooley',
        tuneCount: 1,
        tuneSequence: 1,
        extension: 'mid',
      }),
    ).toBe('tunes.mid');
  });

  it('an unsaved new document uses the tune title, or Untitled without one', () => {
    expect(
      suggestExportFileName({ tuneTitle: 'My Reel', tuneCount: 1, tuneSequence: 1, extension: 'svg' }),
    ).toBe('My Reel.svg');
    expect(
      suggestExportFileName({ tuneTitle: '', tuneCount: 1, tuneSequence: 1, extension: 'svg' }),
    ).toBe('Untitled.svg');
  });

  it('multiple tunes append index and title; no repetition when the base name already contains the title', () => {
    expect(
      suggestExportFileName({
        documentStem: 'tunes',
        tuneTitle: 'Second',
        tuneCount: 2,
        tuneSequence: 2,
        extension: 'mid',
      }),
    ).toBe('tunes 2 Second.mid');
    expect(
      suggestExportFileName({
        documentStem: 'Second',
        tuneTitle: 'Second',
        tuneCount: 2,
        tuneSequence: 2,
        extension: 'mid',
      }),
    ).toBe('Second 2.mid');
  });

  it('strips control and reserved characters and collapses whitespace', () => {
    expect(sanitizeFileNameStem('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j');
    expect(sanitizeFileNameStem('tune\nname\t x')).toBe('tune name x');
    expect(sanitizeFileNameStem('   ')).toBe('');
  });

  it('truncates an overlong base name without a trailing space', () => {
    expect(sanitizeFileNameStem('x'.repeat(120))).toBe('x'.repeat(80));
    const spaced = sanitizeFileNameStem(`${'x'.repeat(79)} y`);
    expect(spaced.length).toBeLessThanOrEqual(80);
    expect(spaced.endsWith(' ')).toBe(false);
  });
});

describe('generateMidiBytes', () => {
  it('produces a standard MIDI file (MThd header)', async () => {
    const bytes = await generateMidiBytes('X:1\nT:Tiny\nM:4/4\nL:1/8\nK:C\nCDEF GABc |]');
    expect(bytes?.slice(0, 4)).toEqual(MIDI_HEADER);
  });

  it('the self-contained text of the confirmed 2nd tune in a multi-tune file generates directly', async () => {
    const tunes = await listTunes(MULTI_TUNE);
    const bytes = await generateMidiBytes(tunes[1].abc);
    expect(bytes?.slice(0, 4)).toEqual(MIDI_HEADER);
  });

  it('content without notes produces no file', async () => {
    await expect(generateMidiBytes('')).resolves.toBeUndefined();
  });
});

describe('generateSvgText', () => {
  it('produces standalone SVG text with black notation on white', async () => {
    const svg = await generateSvgText('X:1\nT:Tiny\nM:4/4\nL:1/8\nK:C\nCDEF GABc |]');
    expect(svg).toBeDefined();
    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('#000000');
    expect(svg).not.toContain('currentColor');
    expect(svg).not.toContain('--vscode-');
  });

  it('carries no scripts or event handlers', async () => {
    const svg = await generateSvgText('X:1\nT:Tiny\nK:C\nCDEF |]');
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/\son\w+=/);
  });

  it('a long multi-line score is output in full (content is not truncated)', async () => {
    const body = Array.from({ length: 9 }, () => 'GABc dedB | cBAG FED2 |').join('\n');
    const svg = await generateSvgText(`X:1\nT:Long\nM:4/4\nL:1/8\nK:G\n${body}|]`);
    const height = Number(/<svg[^>]*height="([0-9.]+)"/.exec(svg ?? '')?.[1]);
    expect(height).toBeGreaterThan(400);
  });

  it('content without notes produces no empty shell', async () => {
    await expect(generateSvgText('')).resolves.toBeUndefined();
  });

  it('restores the global DOM environment after export', async () => {
    expect('document' in globalThis).toBe(false);
    await generateSvgText('X:1\nK:C\nCDEF |]');
    expect('document' in globalThis).toBe(false);
  });
});
