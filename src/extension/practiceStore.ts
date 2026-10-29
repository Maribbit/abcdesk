import * as vscode from 'vscode';
import {
  mergePracticeRecords,
  parsePracticeRecord,
  practiceStorageKey,
  type PracticeRecord,
} from '../core/practice';

/**
 * 练习记录的工作区状态存取（SPEC-SET-02 / 06 / 08、P04 / P05 决议）：
 * - 以文件 URI 为键保存在扩展的 workspaceState，不写项目文件；
 * - 记忆开关每次读取，关闭时不读不写，但不改动当前预览；
 * - 无工作区（空窗口 / 单文件）与未保存文档不落盘；
 * - 记录只经预览内的重置入口删除，读取失败回退默认值而不清理。
 */
export class PracticeStore {
  constructor(private readonly state: vscode.Memento | undefined) {}

  /** 记忆开关（SPEC-SET-06）：配置缺失时按默认开启。 */
  private enabled(): boolean {
    const configuration = vscode.workspace.getConfiguration?.('abcdesk');
    return configuration?.get<boolean>('rememberPracticeSettings', true) ?? true;
  }

  /** 可落盘范围（P04）：开关开启、有工作区且文档已保存。 */
  persistable(uri: string): boolean {
    return this.state !== undefined && this.enabled() &&
      (vscode.workspace.workspaceFolders?.length ?? 0) > 0 &&
      !uri.startsWith('untitled:');
  }

  read(uri: string): PracticeRecord | undefined {
    if (this.state === undefined || !this.enabled()) return undefined;
    return parsePracticeRecord(this.state.get<unknown>(practiceStorageKey(uri)));
  }

  /** 保存合并后的记录（P05：后写覆盖）；无工作区 / 未保存 / 关闭开关时不落盘。 */
  save(uri: string, record: PracticeRecord): void {
    if (!this.persistable(uri)) return;
    void this.state?.update(practiceStorageKey(uri), record);
  }

  /** 重置本文件（SPEC-SET-07）：删除该文件的全部曲目与界面记录。 */
  clear(uri: string): void {
    if (this.state === undefined || !this.enabled() || uri.startsWith('untitled:')) return;
    void this.state.update(practiceStorageKey(uri), undefined);
  }

  /** 迁移（SPEC-LIFE-03 / 04、SET-08）：目标已有记录时不覆盖、不混合、不删除来源。 */
  migrate(from: PracticeRecord | undefined, to: string): void {
    if (from === undefined || !this.persistable(to)) return;
    if (this.read(to) !== undefined) return;
    this.save(to, from);
  }
}

/** 记录内容等价判断：用于避免恢复后原样回写、覆盖其他窗口的更新。 */
export function samePracticeRecord(first: PracticeRecord, second: PracticeRecord): boolean {
  return canonical(first) === canonical(second);
}

function canonical(record: PracticeRecord): string {
  const tunes = [...record.tunes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((tune) => ({ id: tune.id, signature: tune.signature, settings: { ...tune.settings, mutedVoices: [...tune.settings.mutedVoices].sort((a, b) => a - b) } }));
  return JSON.stringify({ version: record.version, ui: record.ui, tunes });
}

/** 合并前后等价时保留原记录，避免不变的上报触发写入。 */
export function mergePracticeIfChanged(base: PracticeRecord | undefined, incoming: PracticeRecord): PracticeRecord {
  const merged = mergePracticeRecords(base, incoming);
  return base !== undefined && samePracticeRecord(base, merged) ? base : merged;
}
