import { describe, expect, it } from 'vitest';
import { collectParseDiagnostics, MAX_PARSE_DIAGNOSTICS, parseAbcWarning } from '../src/core/diagnostics';
import { appendSource, appendSynthetic, emptyMappedText, normalizeSource } from '../src/core/sourceMap';

const warning = (line: number, column: number, message: string, context = 'SPACE') =>
  `Music Line:${line}:${column}: ${message}:  <span style="text-decoration:underline;font-size:1.3em;font-weight:bold;">${context}</span>`;

describe('解析诊断的位置与详情', () => {
  it('[SPEC-STATE-06] 拆分位置前缀、本地化摘要与原始行上下文', () => {
    const parsed = parseAbcWarning(warning(4, 1, "Can't add words before the first line of music"));
    expect(parsed).toEqual({
      message: "Can't add words before the first line of music",
      detail: 'SPACE',
      line: 4,
      column: 1,
    });
  });

  it('[SPEC-STATE-06] 第三方消息中的实体与 HTML 按文本安全呈现', () => {
    const parsed = parseAbcWarning(warning(2, 3, 'Unknown character &lt; kept', 'a&amp;b'));
    expect(parsed?.message).toBe('Unknown character < kept');
    expect(parsed?.detail).toBe('a&b');
  });

  it('[SPEC-STATE-06] 无位置前缀的告警保留摘要但不给出位置', () => {
    const input = normalizeSource('X:1\nK:C\nCDEF|');
    const diagnostics = collectParseDiagnostics(['Some parser note without a position'], input);
    expect(diagnostics).toEqual([{ message: 'Some parser note without a position', detail: '' }]);
    expect(diagnostics[0]?.range).toBeUndefined();
  });

  it('[SPEC-STATE-06] 有可靠位置的告警映射到曲目原文', () => {
    const source = 'X:1\nK:C\nCDEF|';
    const diagnostics = collectParseDiagnostics([warning(3, 2, 'Unknown character ignored')], normalizeSource(source));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({ start: source.indexOf('D'), end: source.indexOf('D') + 1 });
  });

  it('[SPEC-STATE-06] 行或列越界、合成头部与继承头部都不编造位置', () => {
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

  it('[SPEC-STATE-06] 重复告警只保留一条且总数受限', () => {
    const input = normalizeSource(`${'X:1\nK:C\n'.repeat(1)}${Array.from({ length: 40 }, () => 'C').join('|')}`);
    const duplicate = warning(3, 1, 'duplicated');
    expect(collectParseDiagnostics([duplicate, duplicate], input)).toHaveLength(1);
    const many = Array.from({ length: 40 }, (_, index) => warning(3, index + 1, `item ${index}`));
    expect(collectParseDiagnostics(many, input)).toHaveLength(MAX_PARSE_DIAGNOSTICS);
  });
});
