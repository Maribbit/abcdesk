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

/** SPEC-DOC-02~05: keeps only the state inside the current preview; no audio, DOM or host dependency. */
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

  /** Returns whether an immediate re-render is needed; re-delivering the same snapshot changes neither position nor selection. */
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
    // A temporarily blank document or a document-level structural failure does not treat the old record as deleted; a valid index is migrated item by item.
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
    // Explicitly selecting a reliable standalone fragment establishes a new identity baseline inside the current index.
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
   * Reliable migration (SPEC-LIFE-03): once the host has confirmed the new URI belongs to the same practice, update the identity
   * so later snapshots are still treated as the same document - keep the selection and settings instead of clearing it as a new one.
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
   * Restore the saved tune records of this file (SPEC-SET-02 ~ 04): matched only by a real and unique X:;
   * the recorded voice signature is marked pending - if it differs from the current list the mutes are cleared with a notice.
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

  /** Export persistable tune records (SPEC-SET-08): real X: and lightweight settings only; mutes are dropped when the signature is unreliable. */
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
          // Same shape and validation as persistence: mutes sorted by index and deduplicated; no mutes when the signature is unreliable
          mutedVoices: record.signature === null
            ? []
            : [...new Set(record.settings.mutedVoices)].sort((first, second) => first - second),
        },
      });
    }
    return exported;
  }

  /** Reset this file (SPEC-SET-07): clear all tune records; the caller handles the current selection and playback state separately. */
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
