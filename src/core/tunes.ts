import { TuneBook } from 'abcjs';
import { appendSource, appendSynthetic, emptyMappedText, normalizeSource, type CharRange, type MappedText } from './sourceMap';

/** SPEC-DOC-01 / 05 / 06: the index belongs to the current document only; ids must come from real X: lines. */
export interface PreviewTune {
  index: number;
  id: string | null;
  title: string;
  start: number;
  end: number;
  reliable: boolean;
  input: MappedText;
}

export interface TuneCatalog {
  source: string;
  tunes: PreviewTune[];
  issues: CharRange[];
  /** When the leading fragment is not reliably identified, later tunes are not treated as the default first tune. */
  initialBlocked: boolean;
}

interface SourceLine { text: string; start: number; end: number; blocked: boolean; malformed: boolean }
const FILE_FIELD = /^[ABCDFGHILMmNORrSUZ]:/;

/** Strip trailing comments for metadata detection only; the render input keeps the original text. */
function fieldValue(line: string): string {
  return line.slice(2).split(/(?<!\\)%/, 1)[0].trim();
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let block: string | undefined;
  let blockStart = 0;
  for (const part of text.split('\n')) {
    const blocked = block !== undefined;
    const begin = /^%%begin(\w+)/i.exec(part);
    const end = /^%%end(\w+)/i.exec(part);
    const malformed = (begin !== null && blocked) || (end !== null && end[1].toLowerCase() !== block);
    if (begin !== null && !blocked) { block = begin[1].toLowerCase(); blockStart = lines.length; }
    if (end !== null && end[1].toLowerCase() === block) block = undefined;
    lines.push({ text: part, start, end: Math.min(text.length, start + part.length + 1), blocked, malformed });
    start += part.length + 1;
  }
  if (block !== undefined) {
    for (const line of lines.slice(blockStart)) line.malformed = true;
  }
  return lines;
}

/** Music-like fragments only flag a limitation; no tune or source notes are invented from them. */
function suspicious(line: string): boolean {
  const text = line.trim();
  if (text === '' || text.startsWith('%')) return false;
  if (/^[A-Za-z]:/.test(text)) return true;
  if (/^[A-Ga-gzZxX0-9,/'^_=|:\][(){}\s.+!~"-]+$/.test(text) || /[|[\]{}"^_=!+~]/.test(text)) return true;
  // Plain explanatory text is not music; indistinguishable words or symbol runs are still reported as unrecognized fragments.
  return !(/^[\p{L}\p{N}\s，。！？：；、,.;:!?()（）‘’“”'-]+$/u.test(text) && /[\p{Script=Han}\s]/u.test(text));
}

/** Text fields are overridden as a whole per field; macros are overridden per left-hand side and cannot remove other macros' defaults. */
function fieldKey(line: string): string | undefined {
  if (!FILE_FIELD.test(line) || line.startsWith('I:')) return undefined;
  if (/^[Um]:/.test(line)) return /^([Um]:)\s*([^=\s]+)\s*=/.exec(line)?.slice(1).join('');
  return line.slice(0, 2);
}

function inheritedHeader(header: SourceLine[], region: SourceLine[], end: number): SourceLine[] {
  const body = region.find((line) => !line.blocked && /^K:/.test(line.text))?.start ?? end;
  const overridden = new Set(region.filter((line) => !line.blocked && line.start < body).map((line) => fieldKey(line.text)));
  let include = true;
  return header.filter((line) => {
    if (!line.blocked && !/^\+:/.test(line.text)) {
      const key = fieldKey(line.text);
      include = key === undefined || !overridden.has(key);
    }
    return include;
  });
}

export function createTuneCatalog(source: string): TuneCatalog {
  const normalized = normalizeSource(source);
  const lines = sourceLines(normalized.text);
  const issues: CharRange[] = [];
  const report = (line: SourceLine): void => {
    const start = normalized.starts[line.start];
    const end = normalized.ends[line.end - 1];
    if (start !== undefined && end !== undefined) issues.push({ start, end });
  };
  for (const line of lines) if (line.malformed) report(line);
  const anchors = lines.filter((line) => !line.blocked && /^X:/.test(line.text));
  const header: SourceLine[] = [];
  let initialBlocked = false;
  if (anchors.length > 0) {
    let continuation = false;
    for (const line of lines) {
      if (line.start >= anchors[0].start) break;
      if (line.blocked || /^%%/.test(line.text) || FILE_FIELD.test(line.text) || (continuation && /^\+:/.test(line.text))) {
        header.push(line);
        continuation = true;
      } else if (suspicious(line.text)) {
        report(line);
        initialBlocked = true;
        continuation = false;
      } else if (line.text.trim() !== '' && !line.text.trim().startsWith('%')) {
        continuation = false;
      }
    }
  }
  // A single fragment without X: follows abcjs support; pure comments / blank text do not produce an empty tune option.
  const meaningful = lines.find((line) => !line.blocked && line.text.trim() !== '' && !line.text.trim().startsWith('%'));
  if (anchors.length === 0 && meaningful !== undefined) {
    // Without X: only leading whitespace / comments are stripped; applicable directives stay as a non-linkable prefix.
    header.push(...lines.filter((line) => line.start < meaningful.start && (line.blocked || /^%%/.test(line.text))));
  }
  if (header.some((line) => line.malformed)) initialBlocked = true;
  const starts = anchors.length > 0 ? anchors : meaningful === undefined ? [] : [meaningful];
  const tunes: PreviewTune[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const first = starts[index];
    const limit = starts[index + 1]?.start ?? normalized.text.length;
    const region = lines.filter((line) => line.start >= first.start && line.start < limit);
    const blank = region.find((line) => line.text.trim() === '');
    const end = blank?.start ?? limit;
    let reliable = !header.some((line) => line.malformed) && !region.some((line) => line.malformed);
    for (const line of region) {
      if (line.start >= end && !line.blocked && suspicious(line.text)) report(line);
      // TuneBook wrongly splits X: inside text blocks and truncates blank lines inside them: refuse to show incomplete output.
      if ((line.blocked && /^X:/.test(line.text)) || (line.blocked && line.text.trim() === '')) {
        report(line);
        reliable = false;
      }
    }
    const explicit = /^X:/.test(first.text);
    const input = emptyMappedText();
    if (explicit) {
      appendSource(input, normalized, first.start, first.end);
      if (!input.text.endsWith('\n')) appendSynthetic(input, '\n');
    }
    for (const line of inheritedHeader(header, region, end)) {
      appendSource(input, normalized, line.start, line.end, false);
      if (!input.text.endsWith('\n')) appendSynthetic(input, '\n');
    }
    if (explicit) appendSource(input, normalized, first.end, Math.max(first.end, end));
    else appendSource(input, normalized, first.start, end);
    // Cross-check the boundary with the real parser; a second section it ignored must not be treated as rendered.
    const book = new TuneBook(input.text);
    if (book.tunes.length !== 1 || (book.tunes[0]?.pure ?? '').trim() !== input.text.trim()) {
      reliable = false;
      report(first);
    }
    const title = region.find((line) => !line.blocked && line.start < end && /^T:/.test(line.text) && fieldValue(line.text) !== '');
    tunes.push({
      index,
      id: explicit ? fieldValue(first.text) || null : null,
      title: title === undefined ? '' : fieldValue(title.text),
      start: normalized.starts[first.start] ?? source.length,
      end: normalized.ends[Math.max(first.start, end - 1)] ?? source.length,
      reliable,
      input,
    });
  }
  if (anchors.length === 0 && issues.length > 0) {
    initialBlocked = true;
    for (const tune of tunes) tune.reliable = false;
  }
  return { source, tunes, issues, initialBlocked };
}

/** Both sides must be unique; X: is not converted to a number so different explicit ids are not merged. */
export function matchTune(previous: TuneCatalog, index: number, next: TuneCatalog): number | null {
  const id = previous.tunes[index]?.id;
  if (id === null || id === undefined || previous.tunes.filter((tune) => tune.id === id).length !== 1) return null;
  const matches = next.tunes.filter((tune) => tune.id === id);
  return matches.length === 1 ? matches[0].index : null;
}

export function tuneAtSource(catalog: TuneCatalog, offset: number): PreviewTune | undefined {
  if (!Number.isSafeInteger(offset) || catalog.issues.some((range) => offset >= range.start && offset < range.end)) return undefined;
  return catalog.tunes.find((tune) => tune.reliable && offset >= tune.start && offset < tune.end);
}
