/** SPEC-DOC-06：解析输入到原文的 UTF-16 映射，不修改 abcjs 的对象或源文档。 */
export interface CharRange {
  start: number;
  end: number;
}

export interface MappedText {
  text: string;
  /** 每个 UTF-16 码元在原文的范围；合成字符使用 -1。 */
  starts: number[];
  ends: number[];
  /** 继承头部虽有来源，但不能作为当前曲目的音符定位依据。 */
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
  // 不用展开运算符传大数组，避免长谱超过引擎参数数目限制。
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

/** 只接受连续、非空、完整属于曲目原文的范围；不夹取无效偏移。 */
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
