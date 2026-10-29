import { createTuneCatalog, matchTune, type PreviewTune, type TuneCatalog } from './tunes';
import type { PracticeTuneRecord } from './practice';

export interface TuneSnapshot { uri: string; version: number; abc: string }
export interface MusicSettings { speed: number; loop: boolean; chordsMuted: boolean; mutedVoices: number[] }
export const defaultMusicSettings = (): MusicSettings => ({ speed: 100, loop: false, chordsMuted: false, mutedVoices: [] });
interface PracticeRecord { settings: MusicSettings; signature: string | null; revalidate: boolean }
export interface TuneSelectionRequest { id: number; snapshot: TuneSnapshot; catalog: TuneCatalog; index: number }

export function sameSnapshot(first: TuneSnapshot | undefined, second: TuneSnapshot): boolean {
  return first?.uri === second.uri && first.version === second.version && first.abc === second.abc;
}

/** SPEC-DOC-02～05：只保存当前预览内状态；无音频、DOM 或宿主依赖。 */
export class TuneSession {
  snapshot: TuneSnapshot | undefined;
  catalog: TuneCatalog = createTuneCatalog('');
  selected: number | null = null;
  pending: TuneSnapshot | undefined;
  selectionRequest: TuneSelectionRequest | undefined;
  private requestSequence = 0;
  private initialized = false;
  private identityCatalog: TuneCatalog | undefined;
  private identitySelection: number | null = null;
  private records = new Map<number, PracticeRecord>();

  get current(): PreviewTune | undefined { return this.selected === null ? undefined : this.catalog.tunes[this.selected]; }

  /** 返回是否应立即重渲染；同快照重复投递不改变位置或选曲。 */
  receive(snapshot: TuneSnapshot, defer: boolean): boolean {
    if (sameSnapshot(this.snapshot, snapshot)) return false;
    if (this.snapshot?.uri === snapshot.uri && snapshot.version < this.snapshot.version) return false;
    if (this.pending?.uri === snapshot.uri && snapshot.version < this.pending.version) return false;
    if (defer || this.selectionRequest !== undefined) {
      this.pending = snapshot;
      return false;
    }
    this.apply(snapshot);
    return true;
  }

  apply(snapshot: TuneSnapshot, choice?: TuneSelectionRequest): void {
    if (sameSnapshot(this.snapshot, snapshot)) {
      if (choice !== undefined) this.select(choice.index);
      this.pending = undefined;
      return;
    }
    const catalog = createTuneCatalog(snapshot.abc);
    const sameDocument = this.snapshot === undefined || this.snapshot.uri === snapshot.uri;
    const previous = sameDocument ? this.identityCatalog : undefined;
    let selected: number | null = null;
    if (choice !== undefined) {
      selected = sameSnapshot(choice.snapshot, snapshot) ? choice.index : matchTune(choice.catalog, choice.index, catalog);
    } else if (!this.initialized || !sameDocument) {
      selected = !catalog.initialBlocked && catalog.tunes.length > 0 ? 0 : null;
    } else if (previous !== undefined && this.identitySelection !== null) {
      selected = matchTune(previous, this.identitySelection, catalog);
    }
    // 临时空白或文档级结构失败不把旧记录当作已删除；有效目录则逐项迁移。
    const usable = catalog.tunes.length > 0 && !catalog.initialBlocked && catalog.tunes.some((tune) => tune.reliable);
    if (!sameDocument) this.records.clear();
    if (usable) {
      const records = new Map<number, PracticeRecord>();
      if (previous !== undefined) {
        for (const [index, record] of this.records) {
          const next = matchTune(previous, index, catalog);
          if (next !== null) records.set(next, { ...record, revalidate: true });
        }
      }
      this.records = records;
      this.identityCatalog = catalog;
      this.identitySelection = selected;
    }
    this.snapshot = snapshot;
    this.catalog = catalog;
    this.selected = selected !== null && catalog.tunes[selected] !== undefined ? selected : null;
    this.pending = undefined;
    this.initialized = true;
  }

  select(index: number): boolean {
    if (!this.catalog.tunes[index]?.reliable) return false;
    this.selected = index;
    // 显式选择可靠的独立片段，建立当前目录内的新身份基准。
    if (this.identityCatalog !== this.catalog) {
      this.records.clear();
      this.identityCatalog = this.catalog;
    }
    this.identitySelection = index;
    return true;
  }

  beginSelection(index: number): TuneSelectionRequest | undefined {
    if (this.snapshot === undefined || !this.catalog.tunes[index]?.reliable || this.selected === index) return undefined;
    const request = { id: ++this.requestSequence, snapshot: this.snapshot, catalog: this.catalog, index };
    this.selectionRequest = request;
    return request;
  }

  completeSelection(id: number, snapshot: TuneSnapshot): boolean {
    const request = this.selectionRequest;
    if (request?.id !== id) return false;
    const latest = this.pending !== undefined && this.pending.version > snapshot.version ? this.pending : snapshot;
    this.selectionRequest = undefined;
    this.apply(latest, request);
    return true;
  }

  cancelSelection(): void {
    this.requestSequence += 1;
    this.selectionRequest = undefined;
  }

  /**
   * 可靠迁移（SPEC-LIFE-03）：宿主已确认新 URI 与当前文档属于同一练习时更新身份标识，
   * 使后续快照仍视为同一文档——保留选曲与设置记录，不当作新文档清空。
   */
  rekey(uri: string): void {
    if (this.snapshot !== undefined && this.snapshot.uri !== uri) {
      this.snapshot = { ...this.snapshot, uri };
    }
    if (this.pending !== undefined && this.pending.uri !== uri) {
      this.pending = { ...this.pending, uri };
    }
  }

  remember(settings: MusicSettings, signature: string | null): void {
    if (this.selected === null || this.identityCatalog !== this.catalog) return;
    this.records.set(this.selected, { settings: { ...settings, mutedVoices: [...settings.mutedVoices] }, signature, revalidate: false });
  }

  /**
   * 恢复本文件已保存的曲目记录（SPEC-SET-02 ~ 04）：只按真实且唯一的 X: 匹配，
   * 记录的声部签名标记为待核验——与当前清单不符时清除静音并提示。
   */
  restore(records: readonly PracticeTuneRecord[]): void {
    const byId = new Map<string, PracticeTuneRecord>();
    for (const record of records) byId.set(record.id, record);
    for (const [index, tune] of this.catalog.tunes.entries()) {
      if (!tune.reliable || tune.id === null) continue;
      const record = byId.get(tune.id);
      if (record === undefined) continue;
      this.records.set(index, {
        settings: { ...record.settings, mutedVoices: [...record.settings.mutedVoices] },
        signature: record.signature,
        revalidate: true,
      });
    }
  }

  /** 导出可持久化的曲目记录（SPEC-SET-08）：只含真实 X: 与轻量设置，签名不可靠时不留静音。 */
  exportRecords(): PracticeTuneRecord[] {
    const exported: PracticeTuneRecord[] = [];
    const seen = new Set<string>();
    for (const [index, record] of [...this.records].sort(([first], [second]) => first - second)) {
      const tune = this.catalog.tunes[index];
      if (tune === undefined || !tune.reliable || tune.id === null || seen.has(tune.id)) continue;
      seen.add(tune.id);
      exported.push({
        id: tune.id,
        signature: record.signature,
        settings: {
          ...record.settings,
          // 持久形状与校验一致：静音按编号排序去重；签名不可靠时不留静音
          mutedVoices: record.signature === null
            ? []
            : [...new Set(record.settings.mutedVoices)].sort((first, second) => first - second),
        },
      });
    }
    return exported;
  }

  /** 重置本文件（SPEC-SET-07）：清空全部曲目记录；当前选曲与播放状态由调用方另行处理。 */
  clearRecords(): void {
    this.records.clear();
  }

  settingsFor(signature: string | null): { settings: MusicSettings; voicesChanged: boolean } {
    const record = this.selected === null ? undefined : this.records.get(this.selected);
    if (record === undefined) return { settings: defaultMusicSettings(), voicesChanged: false };
    const changed = record.revalidate && (signature === null || record.signature === null || signature !== record.signature);
    const settings = { ...record.settings, mutedVoices: changed ? [] : [...record.settings.mutedVoices] };
    return { settings, voicesChanged: changed };
  }
}
