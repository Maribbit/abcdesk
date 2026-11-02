import { describe, expect, it } from 'vitest';
import { collectParseDiagnostics, MAX_PARSE_DIAGNOSTICS, parseAbcWarning } from '../src/core/diagnostics';
import { appendSource, appendSynthetic, emptyMappedText, normalizeSource } from '../src/core/sourceMap';

const warning = (line: number, column: number, message: string, context = 'SPACE') =>
  `Music Line:${line}:${column}: ${message}:  <span style="text-decoration:underline;font-size:1.3em;font-weight:bold;">${context}</span>`;

describe('parse diagnostics positions and details', () => {
  it('[SPEC-STATE-06] splits the position prefix, localized summary and raw line context', () => {
    const parsed = parseAbcWarning(warning(4, 1, "Can't add words before the first line of music"));
    expect(parsed).toEqual({
      message: "Can't add words before the first line of music",
      detail: 'SPACE',
      line: 4,
      column: 1,
    });
  });

  it('[SPEC-STATE-06] entities and HTML in third-party messages are rendered as safe text', () => {
    const parsed = parseAbcWarning(warning(2, 3, 'Unknown character &lt; kept', 'a&amp;b'));
    expect(parsed?.message).toBe('Unknown character < kept');
    expect(parsed?.detail).toBe('a&b');
  });

  it('[SPEC-STATE-06] a warning without a position prefix keeps its summary but gives no position', () => {
    const input = normalizeSource('X:1\nK:C\nCDEF|');
    const diagnostics = collectParseDiagnostics(['Some parser note without a position'], input);
    expect(diagnostics).toEqual([{ message: 'Some parser note without a position', detail: '' }]);
    expect(diagnostics[0]?.range).toBeUndefined();
  });

  it('[SPEC-STATE-06] a warning with a reliable position maps to the tune source', () => {
    const source = 'X:1\nK:C\nCDEF|';
    const diagnostics = collectParseDiagnostics([warning(3, 2, 'Unknown character ignored')], normalizeSource(source));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({ start: source.indexOf('D'), end: source.indexOf('D') + 1 });
  });

  it('[SPEC-STATE-06] out-of-range line or column, synthesized headers and inherited headers never invent a position', () => {
    const source = 'X:1\nK:C\nCDEF|';
    const input = normalizeSource(source);
    expect(collectParseDiagnostics([warning(9, 1, 'out of range')], input)[0]?.range).toBeUndefined();
    expect(collectParseDiagnostics([warning(3, 99, 'column out of range')], input)[0]?.range).toBeUndefined();
    expect(collectParseDiagnostics([warning(0, 0, 'synthetic position')], input)[0]?.range).toBeUndefined();

    const inherited = emptyMappedText();
    appendSource(inherited, input, 0, 8, false);
    appendSource(inherited, input, 8, input.text.length);
    expect(collectParseDiagnostics([warning(1, 1, 'inherited header')], inherited)[0]?.range).toBeUndefined();

    const synthetic = emptyMappedText();
    appendSynthetic(synthetic, '\n');
    appendSource(synthetic, input, 0, input.text.length);
    expect(collectParseDiagnostics([warning(1, 1, 'synthetic line')], synthetic)[0]?.range).toBeUndefined();
  });

  it('[SPEC-STATE-06] duplicate warnings keep one entry and the total is capped', () => {
    const input = normalizeSource(`${'X:1\nK:C\n'.repeat(1)}${Array.from({ length: 40 }, () => 'C').join('|')}`);
    const duplicate = warning(3, 1, 'duplicated');
    expect(collectParseDiagnostics([duplicate, duplicate], input)).toHaveLength(1);
    const many = Array.from({ length: 40 }, (_, index) => warning(3, index + 1, `item ${index}`));
    expect(collectParseDiagnostics(many, input)).toHaveLength(MAX_PARSE_DIAGNOSTICS);
  });
});
