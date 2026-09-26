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
  play: 'Play',
  pause: 'Pause',
  'cancel-prepare': 'Cancel playback',
  stop: 'Stop',
  preparing: 'Preparing audio…',
  'click-to-play': 'Click the preview to start playback',
  'prepare-timeout': 'Audio preparation timed out. Play again to retry.',
  'audio-failed': 'Audio preparation failed. Play again to retry.',
  'update-pending': 'File updated — will apply when paused',
  'no-notes': 'The score has no playable notes.',
};

const ZH_CN: Record<string, string> = {
  unsaved: '尚未保存',
  'render-failed': '无法渲染谱面。ABC 源码可能包含错误。',
  play: '播放',
  pause: '暂停',
  'cancel-prepare': '取消起播',
  stop: '停止',
  preparing: '正在准备音频…',
  'click-to-play': '点击预览开始播放',
  'prepare-timeout': '音频准备超时，可重新播放。',
  'audio-failed': '音频准备失败，可重新播放。',
  'update-pending': '文件已更新，暂停后应用',
  'no-notes': '乐谱中没有可播放的音符。',
};

export function t(key: string): string {
  const language = document.documentElement.lang.toLowerCase();
  if (language.startsWith('zh')) {
    return ZH_CN[key] ?? EN[key] ?? key;
  }
  return EN[key] ?? key;
}
