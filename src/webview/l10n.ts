/**
 * webview 文案资源（SPEC-L10N-02 第三条路径）：
 * 显式随扩展打包、按 VS Code 显示语言选择，不依赖宿主自动翻译 DOM。
 *
 * 语言来源为 HTML 根元素的 lang（由扩展侧按 vscode.env.language 写入）；
 * 缺失翻译回退英文，不显示资源键（SPEC-L10N-01）。
 */

const EN: Record<string, string> = {
  'render-failed': 'Could not render the score. The ABC source may contain errors.',
  loop: 'Loop',
  play: 'Play',
  pause: 'Pause',
  'cancel-prepare': 'Cancel playback',
  stop: 'Stop',
  preparing: 'Preparing audio…',
  'click-to-play': 'Click the preview to start playback',
  'prepare-timeout': 'Audio preparation timed out. Play again to retry.',
  'audio-failed': 'Audio preparation failed. Play again to retry.',
  'update-pending': 'File updated — pause to apply and reset the position',
  'stale-score': 'The latest content cannot be previewed; the score below is an older version, for reference only.',
  'empty-file': 'The file has no music content yet.',
  'reveal-source': 'Go to source',
  'no-notes': 'The score has no playable notes.',
  'resume-follow': 'Resume following',
  'play-from-here': 'Play from Here',
  'select-note-first': 'Place the cursor on a note, or select one on the score.',
  'keyboard-caption': 'Score hints, including muted voices',
  'keyboard-region': 'Piano keyboard — score hints, including muted voices',
  'keyboard-range': 'Range',
  'keyboard-mode-tune': 'Tune',
  'keyboard-mode-full': 'Full 88 keys',
  'keyboard-collapse': 'Collapse',
  'keyboard-expand': 'Expand',
  'keyboard-no-pitch': 'The score has no pitches to hint at.',
  'keyboard-out-of-range': 'Some notes are outside A0–C8; no key hints for them.',
  'keyboard-hint-left': 'A hint note is to the left',
  'keyboard-hint-right': 'A hint note is to the right',
  'speed-label': 'Speed',
  'speed-reset': 'Reset to 100%',
  'speed-hint-beat': 'Quarter note = {0}',
  'progress-label': 'Progress',
  'voices-summary': 'Voices',
  'voices-summary-muted': '{0} voice(s) muted',
  'voices-summary-chords': 'chords muted',
  'voices-summary-voices-and-chords': '{0} voice(s) and chords muted',
  'voices-pause-adjust': 'Pause to adjust voices',
  'voice-label': 'Voice {0}',
  'voices-chords': 'Auto chords',
  'applying-speed': 'Applying speed…',
};

const ZH_CN: Record<string, string> = {
  'render-failed': '无法渲染谱面。ABC 源码可能包含错误。',
  loop: '循环',
  play: '播放',
  pause: '暂停',
  'cancel-prepare': '取消起播',
  stop: '停止',
  preparing: '正在准备音频…',
  'click-to-play': '点击预览开始播放',
  'prepare-timeout': '音频准备超时，可重新播放。',
  'audio-failed': '音频准备失败，可重新播放。',
  'update-pending': '文件已更新，暂停后应用并重置位置',
  'stale-score': '最新内容暂不可预览；下方为旧版本，仅供参考。',
  'empty-file': '文件尚无音乐内容',
  'reveal-source': '转到源码编辑',
  'no-notes': '乐谱中没有可播放的音符。',
  'resume-follow': '恢复跟随',
  'play-from-here': '从此处播放',
  'select-note-first': '把光标移到音符上，或在谱面点选音符。',
  'keyboard-caption': '乐谱提示，含静音声部',
  'keyboard-region': '钢琴键盘，乐谱提示（含静音声部）',
  'keyboard-range': '音域',
  'keyboard-mode-tune': '乐曲',
  'keyboard-mode-full': '完整 88 键',
  'keyboard-collapse': '收起',
  'keyboard-expand': '展开',
  'keyboard-no-pitch': '乐谱中没有可提示的音高。',
  'keyboard-out-of-range': '有音符超出 A0–C8，未显示对应按键提示。',
  'keyboard-hint-left': '左侧有提示音',
  'keyboard-hint-right': '右侧有提示音',
  'speed-label': '速度',
  'speed-reset': '恢复原速',
  'speed-hint-beat': '四分音符 = {0}',
  'progress-label': '进度',
  'voices-summary': '声部',
  'voices-summary-muted': '已静音 {0} 个声部',
  'voices-summary-chords': '已静音和弦伴奏',
  'voices-summary-voices-and-chords': '已静音 {0} 个声部与和弦伴奏',
  'voices-pause-adjust': '暂停以调整声部',
  'voice-label': '声部 {0}',
  'voices-chords': '和弦伴奏',
  'applying-speed': '正在应用速度…',
};

export function t(key: string): string {
  const language = document.documentElement.lang.toLowerCase();
  if (language.startsWith('zh')) {
    return ZH_CN[key] ?? EN[key] ?? key;
  }
  return EN[key] ?? key;
}
