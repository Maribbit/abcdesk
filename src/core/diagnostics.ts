/** SPEC-STATE-06: summary / details and reliable source positions for parse warnings; consumes abcjs warnings only, never re-parses ABC. */
import { toSourceRange, type CharRange, type MappedText } from './sourceMap';

export interface ParseDiagnostic {
  /** Raw warning message (abcjs HTML highlighting and position prefix removed). */
  message: string;
  /** Raw context excerpt of the warning line; empty string when the third party provides none. */
  detail: string;
  /** Reliable source range; when missing the item cannot be located and stays in the preview details only. */
  range?: CharRange;
}

/** Fixed abcjs warn() prefix `Music Line:<line>:<col>: ` (both 1-based). */
const WARNING_POSITION = /^Music Line:(\d+):(\d+): /;
/** Maximum diagnostics kept per render: malformed input must not bloat messages or Problems. */
export const MAX_PARSE_DIAGNOSTICS = 32;

/** Present the third-party raw message as safe text: strip highlight markup and decode entities, no translation. */
function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Split one abcjs warning into position prefix, readable summary and line context.
 * abcjs warn() fixes the format as `Music Line:N:C: <message>:  <line excerpt with HTML>`;
 * the context may be absent and the message itself may contain ": ", so only the last separator before the HTML markup is used.
 */
export function parseAbcWarning(raw: string): { message: string; detail: string; line: number; column: number } | undefined {
  const match = WARNING_POSITION.exec(raw);
  if (match === null) return undefined;
  const rest = raw.slice(match[0].length);
  const mark = rest.lastIndexOf('<span');
  const split = mark < 0 ? -1 : rest.lastIndexOf(':  ', mark);
  const message = plainText(split < 0 ? rest : rest.slice(0, split)).trim();
  if (message === '') return undefined;
  const detail = mark < 0 ? '' : plainText(rest.slice(mark)).trim();
  return { message, detail, line: Number(match[1]), column: Number(match[2]) };
}

/** Line / column are 1-based and must fall on real, contiguously mapped tune source; otherwise no position is given. */
function warningRange(input: MappedText, line: number, column: number): CharRange | undefined {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return undefined;
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const next = input.text.indexOf('\n', start);
    if (next < 0) return undefined;
    start = next + 1;
  }
  const next = input.text.indexOf('\n', start);
  const length = (next < 0 ? input.text.length : next) - start;
  const offset = column - 1;
  if (offset >= length) return undefined;
  return toSourceRange(input, start + offset, start + offset + 1);
}

/** Collect parse diagnostics for the current render input: keep summary and details when there is no position or the mapping is unreliable, never fabricate line numbers (SPEC-STATE-06). */
export function collectParseDiagnostics(warnings: readonly string[], input: MappedText): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of warnings) {
    if (diagnostics.length >= MAX_PARSE_DIAGNOSTICS) break;
    const parsed = parseAbcWarning(raw);
    if (parsed === undefined) {
      // Third party gave no position: the summary still goes to the preview details, but not to Problems and no line number is invented.
      const message = plainText(raw).trim();
      if (message !== '') diagnostics.push({ message, detail: '' });
      continue;
    }
    const key = `${parsed.line}:${parsed.column}:${parsed.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const range = warningRange(input, parsed.line, parsed.column);
    diagnostics.push({ message: parsed.message, detail: parsed.detail, ...(range === undefined ? {} : { range }) });
  }
  return diagnostics;
}
