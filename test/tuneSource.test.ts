// @vitest-environment jsdom
import { renderAbc, TimingCallbacks } from 'abcjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTuneCatalog } from '../src/core/tunes';
import { sourceEvent, sourceRanges, validateSourceTarget } from '../src/webview/tuneSource';
import { voiceSignature } from '../src/webview/playback';

beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 20, height: 10 }) });
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 20 });
});

const first = 'X:1\nT:第一首\nK:C\nCDEF|';
const second = 'X:2\nT:第二首\nK:G\n|:GABc:|';

describe('whole-file mapping with real rendering and timing', () => {
  it.each(['\n', '\r\n', '\r'])('[SPEC-DOC-06] with %j line endings, repeats and tempo changes of a later tune map only to that tune\'s notes', (eol) => {
    const source = `\uFEFF \n% 中文\uD840\uDC00\nM:4/4\nL:1/8\n${first}\n\n${second}`.replaceAll('\n', eol);
    const selected = createTuneCatalog(source).tunes[1];
    const element = document.createElement('div');
    document.body.append(element);
    const tune = renderAbc(element, selected.input.text)[0];
    for (const qpm of [90, 180]) {
      const timer = new TimingCallbacks(tune, { qpm });
      const events = timer.noteTimings.filter((event) => event.type === 'event');
      expect(events).toHaveLength(8);
      expect(events.flatMap((event) => sourceRanges(event, selected.input).map((range) => source.slice(range.start, range.end))).join('')).toBe('GABcGABc');
      expect(sourceEvent(events, selected.input, source.indexOf('GABc'))?.milliseconds).toBe(0);
      expect(sourceEvent(events, selected.input, source.indexOf('M:'))).toBeUndefined();
      expect(sourceEvent(events, selected.input, source.indexOf('CDEF'))).toBeUndefined();
      timer.stop();
    }
    element.remove();
  });

  it('[SPEC-PLAY-12] an error in the first tune does not block validating the second tune candidate; non-notes and inter-tune blanks cannot start playback', () => {
    const source = `X:1\nK:wrong\n???\n\n${second}`;
    const catalog = createTuneCatalog(source);
    expect(validateSourceTarget(catalog.tunes[1], source.indexOf('GABc'))).toBe(true);
    expect(validateSourceTarget(catalog.tunes[1], source.indexOf('T:第二首'))).toBe(false);
    expect(validateSourceTarget(catalog.tunes[1], source.indexOf('\n\n'))).toBe(false);
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

describe('reliable signature of notated voices', () => {
  function signature(abc: string): string | null {
    const root = document.createElement('div');
    document.body.append(root);
    const tune = renderAbc(root, abc)[0];
    const result = voiceSignature(tune, abc);
    root.remove();
    return result;
  }
  const voices = 'X:1\nV:top name="旋律"\nV:low name="伴奏"\nK:C\n[V:top] CDEF|\n[V:low] C,4|';
  it('[SPEC-SET-04] signs with real V:, names and actual track order; renaming / re-identifying / reordering all change it', () => {
    const original = signature(voices);
    expect(original).toBe(JSON.stringify([['top', '旋律'], ['low', '伴奏']]));
    expect(signature(voices.replaceAll('top', 'high'))).not.toBe(original);
    expect(signature(voices.replace('旋律', '新名称'))).not.toBe(original);
    expect(signature(voices.replace('X:1\n', 'X:1\n%%score low top\n'))).toBe(JSON.stringify([['low', '伴奏'], ['top', '旋律']]));
    expect(signature(voices.replace('[V:top]', 'V:top\n').replace('[V:low]', 'V:low\n'))).toBe(original);
  });
  it('[SPEC-SET-04] the default single voice uses the internal identifier; annotation chord text creates no fake voice', () => {
    expect(signature('X:1\nK:C\n% [V:fake]\n"[V:other]"CDEF|')).toBe(JSON.stringify([[null, null]]));
    expect(signature('X:1\nV:@implicit\nK:C\nCDEF|')).toBe(JSON.stringify([['@implicit', null]]));
    expect(signature('X:1\nT:[V:title]\n%%begintext\n[V:text]\n%%endtext\nK:C\nCDEF|\nw:[V:lyrics]')).toBe(JSON.stringify([[null, null]]));
    expect(signature(voices.replace('K:C', 'V:unused\nK:C'))).toBeNull();
    expect(signature('X:1\nV:solo\nK:C\nCDEF|')).toBe(JSON.stringify([['solo', null]]));
  });
  it('[SPEC-SET-04] multiple tracks that cannot be verified one to one return unknown', () => {
    expect(voiceSignature({ lines: [{ staff: [{ voices: [[], []] }] }] } as unknown as Parameters<typeof voiceSignature>[0], voices)).toBeNull();
  });
});
