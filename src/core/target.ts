/**
 * Target resolution (SPEC-CMD-04 / 05 / 06): host-independent candidate selection.
 *
 * The extension side builds candidates from VS Code state (command arguments, active editor, preview mapping) and passes them in;
 * this module must not import vscode (see the layer boundaries in docs/conventions.md).
 */

/** Candidate target for a command / preview, built by the caller from the VS Code state before the invocation. */
export interface TargetCandidate {
  /** Document identity (URI string): files with the same name but different paths must be told apart by identity, not display name. */
  uri: string;
  /** VS Code language mode id, e.g. `abc`. */
  languageId: string;
  /** Whether this is a new unsaved (untitled) document; an unsaved ABC document is a valid target (SPEC-CMD-06). */
  isUntitled: boolean;
}

/** Whether a candidate is a valid ABC target: language mode is abc, or a saved document whose name ends with .abc. */
export function isAbcTarget(candidate: TargetCandidate): boolean {
  if (candidate.languageId === 'abc') {
    return true;
  }
  return !candidate.isUntitled && candidate.uri.toLowerCase().endsWith('.abc');
}

/**
 * Choose the target for opening a preview (SPEC-CMD-04 / 05):
 * - an explicit target (file passed from the editor / explorer menu) wins;
 * - an invalid target does not fall back to another file; undefined is returned;
 * - without an explicit target the active context before the invocation is used.
 *
 * Learning notes, files in other languages or no editor at all count as no target: undefined is returned and
 * the caller must not fall back to the most recently used preview (SPEC-CMD-05).
 */
export function choosePreviewTarget(
  explicit: TargetCandidate | undefined,
  active: TargetCandidate | undefined,
): TargetCandidate | undefined {
  const candidate = explicit ?? active;
  if (candidate === undefined || !isAbcTarget(candidate)) {
    return undefined;
  }
  return candidate;
}
