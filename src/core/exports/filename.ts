/**
 * 导出文件名建议（SPEC-EXP-07）：由来源文档与曲目信息推导可修改的建议名。
 *
 * 命名规则：已保存来源使用源文件基本名；未保存新文档使用曲名（无曲名则 Untitled）；
 * 多曲目文档附加本次所选曲目的序号与可用曲名，避免不同曲目默认重名。
 */

/** 文件名禁用字符（`<>:"/\|?*`）。 */
const INVALID_STEM_CHARS = '<>:"/\\|?*';

/** 清洗后的建议基本名长度上限：仅作可修改建议，超长截断避免超出常见文件系统限制。 */
const MAX_STEM_LENGTH = 80;

/** 清洗文件名基本名（SPEC-EXP-07）：非法字符与控制字符替换为空格，压缩空白并截断。 */
export function sanitizeFileNameStem(value: string): string {
  let cleaned = '';
  for (const char of value) {
    cleaned += isInvalidFileNameChar(char) ? ' ' : char;
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, MAX_STEM_LENGTH).trimEnd();
}

/** 控制字符（C0，含制表与换行）或文件系统保留字符。 */
function isInvalidFileNameChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || INVALID_STEM_CHARS.includes(char);
}

/** 建议文件名的输入信息（均由调用方从来源文档与已确认曲目推导）。 */
export interface ExportFileNameInput {
  /** 已保存来源文件的文档基本名（不含扩展名）；未保存的新文档不传。 */
  documentStem?: string;
  /** 导出曲目的标题；无标题为空字符串。 */
  tuneTitle: string;
  /** 来源文档中的曲目总数（大于 1 时附加序号与曲名）。 */
  tuneCount: number;
  /** 导出曲目的序号（从 1 开始）。 */
  tuneSequence: number;
  /** 目标扩展名（不含点）。 */
  extension: string;
}

/**
 * 建议导出文件名（SPEC-EXP-07）：
 * - 已保存来源使用源文件基本名；未保存新文档使用曲名（无曲名则 `Untitled`）；
 * - 多曲目文档附加序号与曲名以区分导出对象；基本名已含该曲名时不重复。
 */
export function suggestExportFileName(input: ExportFileNameInput): string {
  const title = sanitizeFileNameStem(input.tuneTitle);
  const base = sanitizeFileNameStem(input.documentStem ?? '') || title || 'Untitled';
  const parts = [base];
  if (input.tuneCount > 1) {
    parts.push(String(input.tuneSequence));
    if (title !== '' && title !== base) {
      parts.push(title);
    }
  }
  return `${parts.join(' ')}.${input.extension}`;
}
