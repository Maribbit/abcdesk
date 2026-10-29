/**
 * SPEC-SET-02 ~ 08：跨会话练习设置的记录模型、校验与合并。
 *
 * 只保存文件 / 曲目 / 声部标识与轻量设置，不写 ABC、学习记录或播放位置；
 * 记录以文件 URI 为键保存在扩展的 workspaceState（P04 决议），
 * 多窗口按文件分键、静默后写覆盖（P05 决议）。校验失败时整体回退默认值，
 * 不删除原始记录（无效记录安全回退，不自动清理）。
 */

export const PRACTICE_SCHEMA_VERSION = 1;
export const MAX_PRACTICE_TUNES = 256;
export const MAX_MUTED_VOICES = 64;
export const MAX_TUNE_ID_LENGTH = 200;
export const MAX_VOICE_SIGNATURE_LENGTH = 4096;
export const SPEED_MIN = 25;
export const SPEED_MAX = 200;

export type KeyboardMode = 'tune' | 'full';

/** 曲目级音乐设置（SPEC-SET-03 / 04）：声部静音仅在签名核验一致时恢复。 */
export interface PracticeSettings {
  speed: number;
  loop: boolean;
  chordsMuted: boolean;
  mutedVoices: number[];
}

/** 曲目记录：id 取自真实且唯一的 X:（SPEC-SET-03），signature 为有序声部清单。 */
export interface PracticeTuneRecord {
  id: string;
  signature: string | null;
  settings: PracticeSettings;
}

/** 文件级界面偏好（SPEC-SET-05）：速度等音乐设置按曲目另存。 */
export interface PracticeUiPreferences {
  keyboardCollapsed: boolean;
  keyboardMode: KeyboardMode;
}

export interface PracticeRecord {
  version: typeof PRACTICE_SCHEMA_VERSION;
  ui: PracticeUiPreferences;
  tunes: PracticeTuneRecord[];
}

export function defaultPracticeUiPreferences(): PracticeUiPreferences {
  return { keyboardCollapsed: false, keyboardMode: 'tune' };
}

/** 记录键（P05 决议）：按文件分键，多窗口改不同文件互不影响。 */
export function practiceStorageKey(uri: string): string {
  return `abcdesk.practice.v${PRACTICE_SCHEMA_VERSION}:${uri}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function parseUi(value: unknown): PracticeUiPreferences | undefined {
  const ui = object(value);
  if (ui === undefined || typeof ui.keyboardCollapsed !== 'boolean') return undefined;
  if (ui.keyboardMode !== 'tune' && ui.keyboardMode !== 'full') return undefined;
  return { keyboardCollapsed: ui.keyboardCollapsed, keyboardMode: ui.keyboardMode };
}

function parseSettings(value: unknown): PracticeSettings | undefined {
  const settings = object(value);
  if (settings === undefined || !isIntegerIn(settings.speed, SPEED_MIN, SPEED_MAX)) return undefined;
  if (typeof settings.loop !== 'boolean' || typeof settings.chordsMuted !== 'boolean') return undefined;
  if (!Array.isArray(settings.mutedVoices) || settings.mutedVoices.length > MAX_MUTED_VOICES) return undefined;
  const muted = new Set<number>();
  for (const voice of settings.mutedVoices) {
    if (!isIntegerIn(voice, 0, 1023)) return undefined;
    muted.add(voice);
  }
  return {
    speed: settings.speed,
    loop: settings.loop,
    chordsMuted: settings.chordsMuted,
    mutedVoices: [...muted].sort((first, second) => first - second),
  };
}

/**
 * 校验并规范化持久记录（SPEC-SET-08）：形状、范围、标识唯一性任一不符即整体回退；
 * 声部签名为 null（无法可靠识别）时不保留静音覆盖——恢复时无法核验同一清单。
 */
export function parsePracticeRecord(value: unknown): PracticeRecord | undefined {
  const record = object(value);
  if (record === undefined || record.version !== PRACTICE_SCHEMA_VERSION) return undefined;
  const ui = parseUi(record.ui);
  if (ui === undefined || !Array.isArray(record.tunes) || record.tunes.length > MAX_PRACTICE_TUNES) return undefined;
  const seen = new Set<string>();
  const tunes: PracticeTuneRecord[] = [];
  for (const item of record.tunes) {
    const tune = object(item);
    if (tune === undefined) return undefined;
    if (typeof tune.id !== 'string' || tune.id === '' || tune.id.length > MAX_TUNE_ID_LENGTH || seen.has(tune.id)) return undefined;
    if (tune.signature !== null && (typeof tune.signature !== 'string' || tune.signature.length > MAX_VOICE_SIGNATURE_LENGTH)) return undefined;
    const settings = parseSettings(tune.settings);
    if (settings === undefined) return undefined;
    tunes.push({
      id: tune.id,
      signature: tune.signature,
      settings: tune.signature === null ? { ...settings, mutedVoices: [] } : settings,
    });
    seen.add(tune.id);
  }
  return { version: PRACTICE_SCHEMA_VERSION, ui, tunes };
}

/**
 * 合并一次提交（P05 决议）：同一曲目以新记录覆盖，未提及的旧曲目保留——
 * 暂时空白 / 解析失败不擦历史，也不做自动清理；界面偏好取最新提交。
 */
export function mergePracticeRecords(base: PracticeRecord | undefined, incoming: PracticeRecord): PracticeRecord {
  const merged = new Map<string, PracticeTuneRecord>();
  for (const tune of incoming.tunes) merged.set(tune.id, tune);
  for (const tune of base?.tunes ?? []) {
    if (!merged.has(tune.id)) merged.set(tune.id, tune);
  }
  return {
    version: PRACTICE_SCHEMA_VERSION,
    ui: incoming.ui,
    tunes: [...merged.values()].slice(0, MAX_PRACTICE_TUNES),
  };
}
