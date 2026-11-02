import * as vscode from 'vscode';
import {
  mergePracticeRecords,
  parsePracticeRecord,
  practiceStorageKey,
  type PracticeRecord,
} from '../core/practice';

/**
 * Workspace-state access for practice records (SPEC-SET-02 / 06 / 08, decisions P04 / P05):
 * - stored in the extension's workspaceState keyed by file URI; no project files are written;
 * - the memory toggle is read on every access; when off nothing is read or written, but the current preview is left untouched;
 * - no workspace (empty window / single file) and unsaved documents are never persisted;
 * - records are deleted only through the reset entry inside the preview; a failed read falls back to defaults without cleanup.
 */
export class PracticeStore {
  constructor(private readonly state: vscode.Memento | undefined) {}

  /** Memory toggle (SPEC-SET-06): defaults to on when the setting is missing. */
  private enabled(): boolean {
    const configuration = vscode.workspace.getConfiguration?.('abcdesk');
    return configuration?.get<boolean>('rememberPracticeSettings', true) ?? true;
  }

  /** Persistable scope (P04): toggle on, a workspace exists and the document is saved. */
  persistable(uri: string): boolean {
    return this.state !== undefined && this.enabled() &&
      (vscode.workspace.workspaceFolders?.length ?? 0) > 0 &&
      !uri.startsWith('untitled:');
  }

  read(uri: string): PracticeRecord | undefined {
    if (this.state === undefined || !this.enabled()) return undefined;
    return parsePracticeRecord(this.state.get<unknown>(practiceStorageKey(uri)));
  }

  /** Save the merged record (P05: last write wins); not persisted without a workspace / unsaved / toggle off. */
  save(uri: string, record: PracticeRecord): void {
    if (!this.persistable(uri)) return;
    void this.state?.update(practiceStorageKey(uri), record);
  }

  /** Reset this file (SPEC-SET-07): delete all tune and UI records of the file. */
  clear(uri: string): void {
    if (this.state === undefined || !this.enabled() || uri.startsWith('untitled:')) return;
    void this.state.update(practiceStorageKey(uri), undefined);
  }

  /** Migrate (SPEC-LIFE-03 / 04, SET-08): when the target already has a record, do not overwrite, mix or delete the source. */
  migrate(from: PracticeRecord | undefined, to: string): void {
    if (from === undefined || !this.persistable(to)) return;
    if (this.read(to) !== undefined) return;
    this.save(to, from);
  }
}

/** Record equivalence: avoids writing back unchanged data after restore and clobbering another window's update. */
export function samePracticeRecord(first: PracticeRecord, second: PracticeRecord): boolean {
  return canonical(first) === canonical(second);
}

function canonical(record: PracticeRecord): string {
  const tunes = [...record.tunes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((tune) => ({ id: tune.id, signature: tune.signature, settings: { ...tune.settings, mutedVoices: [...tune.settings.mutedVoices].sort((a, b) => a - b) } }));
  return JSON.stringify({ version: record.version, ui: record.ui, tunes });
}

/** Keep the original record when the merge is equivalent so an unchanged report does not trigger a write. */
export function mergePracticeIfChanged(base: PracticeRecord | undefined, incoming: PracticeRecord): PracticeRecord {
  const merged = mergePracticeRecords(base, incoming);
  return base !== undefined && samePracticeRecord(base, merged) ? base : merged;
}
