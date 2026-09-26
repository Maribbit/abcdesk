/**
 * 目标解析（SPEC-CMD-04 / 05 / 06）：宿主无关的候选选择逻辑。
 *
 * extension 侧从 VS Code 状态（命令参数、活动编辑器、预览映射）构造候选后传入；
 * 本模块不得 import vscode（见 docs/conventions.md 目录分层边界）。
 */

/** 命令 / 预览的候选目标，由调用方按调用前的 VS Code 状态构造。 */
export interface TargetCandidate {
  /** 文档标识（URI 字符串）：同名不同路径的文件必须按标识区分，不按显示名匹配。 */
  uri: string;
  /** VS Code 语言模式 ID，如 `abc`。 */
  languageId: string;
  /** 是否为尚未保存的新文档（untitled）；未保存 ABC 新文档是有效目标（SPEC-CMD-06）。 */
  isUntitled: boolean;
}

/** 判断候选是否为有效 ABC 目标：语言模式为 abc，或非未保存文档且以 .abc 结尾。 */
export function isAbcTarget(candidate: TargetCandidate): boolean {
  if (candidate.languageId === 'abc') {
    return true;
  }
  return !candidate.isUntitled && candidate.uri.toLowerCase().endsWith('.abc');
}

/**
 * 选择打开预览的目标（SPEC-CMD-04 / 05）：
 * - 明确目标（编辑器 / 资源管理器菜单传入的文件）优先；
 * - 目标无效时不回退到其他文件，返回 undefined；
 * - 无显式目标时使用调用前的活动上下文。
 *
 * 学习记录、其他语言文件或无编辑器时视为无目标：返回 undefined，
 * 调用方不得回退到最近使用的预览（SPEC-CMD-05）。
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
