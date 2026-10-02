/**
 * 曲目解析（SPEC-EXP-02）：把导出源文本拆分为可独立导出的曲目列表。
 *
 * 每个曲目的 abc 是自包含文本：含自身 `X:` 行，首曲之前的文件级 `%%` 指令
 * 已由 abcjs 并入其中（实证于 abc_parse_book.js：tune.abc = directives + tune），
 * 因此不要另拼 TuneBook.header，否则指令会重复。
 * 判空使用与预览空状态一致的判据（SPEC-STATE-05）：
 * 空白文本也会解析出一首空曲目，不能以曲目数量或文本长度判空。
 */
import type { TuneObject } from 'abcjs';
import { loadAbcjs } from './abcjs';

/** 导出用曲目：可直接独立渲染 / 生成的完整文本。 */
export interface ExportTune {
  /** 文档内序号（从 1 开始）。 */
  sequence: number;
  /** `X:` 字段值；缺省为空字符串。 */
  id: string;
  /** `T:` 字段值；缺省为空字符串。 */
  title: string;
  /** 曲目在源文本中的起始偏移（SPEC-EXP-02：预选光标所属曲目的依据）。 */
  startPos: number;
  /** 曲目完整文本（含 `X:` 行；文件级 `%%` 指令已并入），不含其他曲目。 */
  abc: string;
}

/** 解析导出源文本（SPEC-EXP-02）：返回按出现顺序的曲目列表。 */
export async function listTunes(abcText: string): Promise<ExportTune[]> {
  const abcjs = await loadAbcjs();
  const book = new abcjs.TuneBook(abcText);
  return book.tunes.map((tune, index) => ({
    sequence: index + 1,
    id: tune.id,
    title: tune.title,
    startPos: tune.startPos,
    abc: tune.abc,
  }));
}

/**
 * 谱面是否含可显示的音符（SPEC-STATE-05 判据）：休止符（rest）也是 note 条目，
 * 合法全休止符不算空白内容（SPEC-EXP-08），只有完全无音符材料才不生成导出。
 */
export function tuneHasNotes(tune: TuneObject): boolean {
  for (const line of tune.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const item of voice) {
          if (item.el_type === 'note') {
            return true;
          }
        }
      }
    }
  }
  return false;
}
