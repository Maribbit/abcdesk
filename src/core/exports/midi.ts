/**
 * MIDI export (SPEC-EXP-05): generate a standard MIDI file from the ABC source material,
 * without applying player practice settings (speed percentage, voice mutes, loop, etc.) and without audio synthesis.
 */
import { loadAbcjs } from './abcjs';
import { tuneHasNotes } from './tunes';

/** Export a single tune as MIDI (SPEC-EXP-05); returns undefined when there is no note content, never writes an empty file (SPEC-EXP-08). */
export async function generateMidiBytes(abcText: string): Promise<Uint8Array | undefined> {
  const abcjs = await loadAbcjs();
  const tunes = abcjs.parseOnly(abcText);
  const tune = tunes[0];
  if (tune === undefined || !tuneHasNotes(tune)) {
    return undefined;
  }
  const result: unknown = abcjs.synth.getMidiFile(tune, { midiOutputType: 'binary' });
  if (result instanceof Uint8Array) {
    return result;
  }
  // Guard against abcjs version differences: when returned as a string source it is a per-tune array of byte arrays
  if (Array.isArray(result) && result[0] instanceof Uint8Array) {
    return result[0];
  }
  throw new Error('abcjs did not return binary MIDI data');
}
