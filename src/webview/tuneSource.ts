import { renderAbc, TimingCallbacks, type NoteTimingEvent } from 'abcjs';
import { toSourceRange, type MappedText } from '../core/sourceMap';
import type { PreviewTune } from '../core/tunes';

/** SPEC-DOC-06 / PLAY-11: abcjs coordinates are kept as-is and converted only at the message bridge boundary. */
export function sourceRanges(event: NoteTimingEvent, input: MappedText): Array<{ start: number; end: number }> {
  const starts = event.startCharArray ?? [];
  const ends = event.endCharArray ?? [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < Math.min(starts.length, ends.length); index += 1) {
    const range = toSourceRange(input, starts[index], ends[index]);
    if (range !== undefined && !ranges.some((other) => other.start === range.start && other.end === range.end)) ranges.push(range);
  }
  return ranges;
}

export function sourceEvent(timings: NoteTimingEvent[], input: MappedText, offset: number): NoteTimingEvent | undefined {
  return timings.filter((event) => event.type === 'event' && sourceRanges(event, input).some((range) => offset >= range.start && offset < range.end))
    .reduce<NoteTimingEvent | undefined>((first, event) => first === undefined || event.milliseconds < first.milliseconds ? event : first, undefined);
}

/** SPEC-PLAY-12: validates only the candidate tune and real timing; creates no synth, prepares no soundfont and leaves the active score alone. */
export function validateSourceTarget(candidate: PreviewTune, offset: number): boolean {
  if (!candidate.reliable) return false;
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;visibility:hidden;pointer-events:none';
  container.setAttribute('aria-hidden', 'true');
  document.body.append(container);
  let timer: TimingCallbacks | undefined;
  try {
    const tune = renderAbc(container, candidate.input.text)[0];
    if (tune === undefined) return false;
    timer = new TimingCallbacks(tune, {});
    return sourceEvent(timer.noteTimings, candidate.input, offset) !== undefined;
  } catch (error) {
    console.error('ABC Desk: source target validation failed', error);
    return false;
  } finally {
    timer?.stop();
    container.remove();
  }
}
