/** SPEC-DOC-06: UTF-16 mapping from parse input back to the original text; never mutates abcjs objects or the source document. */
export interface CharRange {
  start: number;
  end: number;
}

export interface MappedText {
  text: string;
  /** Range in the original text for each UTF-16 code unit; synthesized characters use -1. */
  starts: number[];
  ends: number[];
  /** Inherited headers have an origin but cannot serve as note positions for the current tune. */
  linkable: boolean[];
}

export function normalizeSource(source: string): MappedText {
  const result = emptyMappedText();
  for (let index = 0; index < source.length; index += 1) {
    if (index === 0 && source[index] === '\uFEFF') continue;
    const start = index;
    let char = source[index];
    if (char === '\r') {
      char = '\n';
      if (source[index + 1] === '\n') index += 1;
    }
    result.text += char;
    result.starts.push(start);
    result.ends.push(index + 1);
    result.linkable.push(true);
  }
  return result;
}

export function emptyMappedText(): MappedText {
  return { text: '', starts: [], ends: [], linkable: [] };
}

export function appendSource(
  target: MappedText,
  source: MappedText,
  start: number,
  end: number,
  linkable = true,
): void {
  target.text += source.text.slice(start, end);
  // Avoid spreading large arrays into calls so long scores do not exceed the engine's argument limit.
  for (let index = start; index < end; index += 1) {
    target.starts.push(source.starts[index]);
    target.ends.push(source.ends[index]);
    target.linkable.push(linkable && source.linkable[index]);
  }
}

export function appendSynthetic(target: MappedText, text: string): void {
  target.text += text;
  for (let index = 0; index < text.length; index += 1) {
    target.starts.push(-1);
    target.ends.push(-1);
    target.linkable.push(false);
  }
}

/** Only contiguous, non-empty ranges fully inside the tune source are accepted; invalid offsets are not clamped. */
export function toSourceRange(input: MappedText, start: number, end: number): CharRange | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > input.text.length) {
    return undefined;
  }
  for (let index = start; index < end; index += 1) {
    if (!input.linkable[index] || input.starts[index] < 0) return undefined;
    if (index > start && input.starts[index] !== input.ends[index - 1]) return undefined;
  }
  return { start: input.starts[start], end: input.ends[end - 1] };
}
