/**
 * Tune parsing (SPEC-EXP-02): split the export source text into independently exportable tunes.
 *
 * Each tune's abc is self-contained: it has its own `X:` line, and file-level `%%` directives before the first tune
 * are already merged in by abcjs (verified in abc_parse_book.js: tune.abc = directives + tune),
 * so TuneBook.header must not be prepended again or the directives would be duplicated.
 * Emptiness uses the same criterion as the preview empty state (SPEC-STATE-05):
 * blank text also parses into one empty tune, so tune count or text length cannot decide emptiness.
 */
import type { TuneObject } from 'abcjs';
import { loadAbcjs } from './abcjs';

/** Tune for export: complete text that can be rendered / generated on its own. */
export interface ExportTune {
  /** Index within the document (1-based). */
  sequence: number;
  /** `X:` field value; empty string when absent. */
  id: string;
  /** `T:` field value; empty string when absent. */
  title: string;
  /** Start offset of the tune in the source text (SPEC-EXP-02: used to preselect the tune under the cursor). */
  startPos: number;
  /** Full tune text (with the `X:` line; file-level `%%` directives merged in), excluding other tunes. */
  abc: string;
}

/** Parse the export source text (SPEC-EXP-02): returns the tunes in order of appearance. */
export async function listTunes(abcText: string): Promise<ExportTune[]> {
  const abcjs = await loadAbcjs();
  const book = new abcjs.TuneBook(abcText);
  return book.tunes.map((tune, index) => ({
    sequence: index + 1,
    id: tune.id,
    title: tune.title,
    startPos: tune.startPos,
    abc: tune.abc,
  }));
}

/**
 * Whether the score contains displayable notes (SPEC-STATE-05 criterion): rests are also note entries,
 * so a valid whole-measure rest is not empty content (SPEC-EXP-08); only a total absence of note material skips the export.
 */
export function tuneHasNotes(tune: TuneObject): boolean {
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
