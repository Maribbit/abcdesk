/**
 * Lazy abcjs loading (SPEC-EXP-04): export is prepared independently of preview / playback and does not reuse the preview render instance;
 * the dynamic import initializes abcjs only on the first export so extension activation is not slowed down.
 */

/** abcjs module namespace type (the result of `import('abcjs')`). */
export type AbcjsModule = typeof import('abcjs');

let loading: Promise<AbcjsModule> | undefined;

/** Load abcjs (initialized once per process); tolerates the CJS interop shape where exports hang off default. */
export function loadAbcjs(): Promise<AbcjsModule> {
  loading ??= import('abcjs').then(
    (module) => (module as { default?: AbcjsModule }).default ?? (module as AbcjsModule),
  );
  return loading;
}
