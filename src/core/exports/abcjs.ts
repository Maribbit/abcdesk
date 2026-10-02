/**
 * abcjs 惰性加载（SPEC-EXP-04）：导出与预览 / 播放各自独立准备，不复用预览渲染实例；
 * 动态 import 使 abcjs 只在首次导出时初始化，不拖慢扩展激活。
 */

/** abcjs 模块命名空间类型（`import('abcjs')` 的结果）。 */
export type AbcjsModule = typeof import('abcjs');

let loading: Promise<AbcjsModule> | undefined;

/** 加载 abcjs（进程内只初始化一次）；兼容 CJS interop 下包在 default 上的导出形态。 */
export function loadAbcjs(): Promise<AbcjsModule> {
  loading ??= import('abcjs').then(
    (module) => (module as { default?: AbcjsModule }).default ?? (module as AbcjsModule),
  );
  return loading;
}
