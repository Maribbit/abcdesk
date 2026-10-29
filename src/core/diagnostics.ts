/** SPEC-STATE-06：解析告警的摘要 / 详情与可靠源码位置；只消费 abcjs 告警，不二次解析 ABC。 */
import { toSourceRange, type CharRange, type MappedText } from './sourceMap';

export interface ParseDiagnostic {
  /** 原始告警消息（已去掉 abcjs 的 HTML 高亮与位置前缀）。 */
  message: string;
  /** 告警行的原始上下文摘录；空串表示第三方未提供。 */
  detail: string;
  /** 可靠来源区间；缺失即无法可靠定位，只留在预览详情。 */
  range?: CharRange;
}

/** abcjs warn() 的固定前缀 `Music Line:<行>:<列>: `（行、列均为 1-based）。 */
const WARNING_POSITION = /^Music Line:(\d+):(\d+): /;
/** 单次渲染最多保留的诊断数：异常输入不撑大消息与 Problems。 */
export const MAX_PARSE_DIAGNOSTICS = 32;

/** 第三方原始消息按文本安全呈现：剥掉高亮标记并还原实体，不做翻译。 */
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
 * 拆分一条 abcjs 警告：位置前缀、可读摘要与行上下文。
 * 格式由 abcjs 的 warn() 固定为 `Music Line:N:C: <消息>:  <带 HTML 的行摘录>`；
 * 上下文可能缺失，消息本身也可能含 ": "，因此只取 HTML 标记前的最后一个分隔符。
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

/** 行 / 列为 1-based，且只能落在真实、可连续映射的曲目原文上；否则不给出位置。 */
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

/** 收集当前渲染输入的解析诊断：无位置或映射不可靠时保留摘要与详情，不编造行号（SPEC-STATE-06）。 */
export function collectParseDiagnostics(warnings: readonly string[], input: MappedText): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of warnings) {
    if (diagnostics.length >= MAX_PARSE_DIAGNOSTICS) break;
    const parsed = parseAbcWarning(raw);
    if (parsed === undefined) {
      // 第三方未给出位置：摘要仍进入预览详情，但不进入 Problems、不编造行号。
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
