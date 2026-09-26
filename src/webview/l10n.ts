/**
 * webview 文案资源（SPEC-L10N-02 第三条路径）：
 * 显式随扩展打包、按 VS Code 显示语言选择，不依赖宿主自动翻译 DOM。
 *
 * 语言来源为 HTML 根元素的 lang（由扩展侧按 vscode.env.language 写入）；
 * 缺失翻译回退英文，不显示资源键（SPEC-L10N-01）。
 */

const EN: Record<string, string> = {
  unsaved: 'Unsaved',
  'render-failed': 'Could not render the score. The ABC source may contain errors.',
};

const ZH_CN: Record<string, string> = {
  unsaved: '尚未保存',
  'render-failed': '无法渲染谱面。ABC 源码可能包含错误。',
};

export function t(key: string): string {
  const language = document.documentElement.lang.toLowerCase();
  if (language.startsWith('zh')) {
    return ZH_CN[key] ?? EN[key] ?? key;
  }
  return EN[key] ?? key;
}
