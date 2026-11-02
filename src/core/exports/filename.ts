/**
 * Suggested export file name (SPEC-EXP-07): an editable suggestion derived from the source document and tune info.
 *
 * Naming rules: a saved source uses the source file's base name; an unsaved new document uses the tune title (Untitled when absent);
 * a multi-tune document appends the selected tune's index and title so different tunes do not share a default name.
 */

/** Characters forbidden in file names (`<>:"/\|?*`). */
const INVALID_STEM_CHARS = '<>:"/\\|?*';

/** Length cap of the sanitized base name: it is only an editable suggestion; overly long names are truncated to stay within common file system limits. */
const MAX_STEM_LENGTH = 80;

/** Sanitize a file base name (SPEC-EXP-07): replace illegal and control characters with spaces, collapse whitespace and truncate. */
export function sanitizeFileNameStem(value: string): string {
  let cleaned = '';
  for (const char of value) {
    cleaned += isInvalidFileNameChar(char) ? ' ' : char;
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, MAX_STEM_LENGTH).trimEnd();
}

/** Control characters (C0, including tab and newline) or file-system reserved characters. */
function isInvalidFileNameChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || INVALID_STEM_CHARS.includes(char);
}

/** Inputs for the suggested file name (all derived by the caller from the source document and the confirmed tune). */
export interface ExportFileNameInput {
  /** Base name of the saved source document (without extension); omitted for an unsaved new document. */
  documentStem?: string;
  /** Title of the exported tune; empty string when absent. */
  tuneTitle: string;
  /** Total number of tunes in the source document (index and title are appended when greater than 1). */
  tuneCount: number;
  /** Index of the exported tune (1-based). */
  tuneSequence: number;
  /** Target extension (without the dot). */
  extension: string;
}

/**
 * Suggest an export file name (SPEC-EXP-07):
 * - a saved source uses the source file's base name; an unsaved new document uses the tune title (`Untitled` when absent);
 * - a multi-tune document appends index and title to tell exports apart; the title is not repeated if the base name already contains it.
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
