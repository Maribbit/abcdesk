/**
 * SPEC-SET-02 ~ 08: record model, validation and merging for cross-session practice settings.
 *
 * Only file / tune / voice identifiers and lightweight settings are stored; no ABC, learning notes or playback position.
 * Records are keyed by file URI in the extension's workspaceState (decision P04);
 * multiple windows use separate keys per file with silent last-write-wins (decision P05). A failed validation
 * falls back to defaults as a whole without deleting the original record (safe fallback, no automatic cleanup).
 */

export const PRACTICE_SCHEMA_VERSION = 1;
export const MAX_PRACTICE_TUNES = 256;
export const MAX_MUTED_VOICES = 64;
export const MAX_TUNE_ID_LENGTH = 200;
export const MAX_VOICE_SIGNATURE_LENGTH = 4096;
export const SPEED_MIN = 25;
export const SPEED_MAX = 200;

export type KeyboardMode = 'tune' | 'full';

/** Per-tune musical settings (SPEC-SET-03 / 04): voice mutes are restored only when the signature check matches. */
export interface PracticeSettings {
  speed: number;
  loop: boolean;
  chordsMuted: boolean;
  mutedVoices: number[];
}

/** Tune record: id comes from a real and unique X: (SPEC-SET-03); signature is the ordered voice list. */
export interface PracticeTuneRecord {
  id: string;
  signature: string | null;
  settings: PracticeSettings;
}

/** File-level UI preferences (SPEC-SET-05): musical settings such as speed are stored per tune. */
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

/** Record key (decision P05): keyed per file so that windows editing different files do not interfere. */
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
 * Validate and normalize a persisted record (SPEC-SET-08): any mismatch in shape, range or id uniqueness falls back as a whole;
 * when the voice signature is null (not reliably identifiable) the mute overrides are dropped - they cannot be verified against the same list on restore.
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
 * Merge one submission (decision P05): the same tune is overwritten by the new record, tunes not mentioned are kept -
 * a temporarily blank document or parse failure does not wipe history, and nothing is cleaned up automatically; UI preferences take the latest submission.
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
