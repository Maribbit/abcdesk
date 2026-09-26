# samples：M0 测试材料

人工验证（F5）与后续自动化的 ABC 材料。超大文件与畸形输入（性能批次，archive 计划 §7 第 19 项）后续用生成脚本补充，不手写。

| 文件 | 内容 | 主要验证点 | 关联条目 |
| --- | --- | --- | --- |
| `01-simple.abc` | 最小单曲（含反复） | 渲染出谱、起播冒烟 | 清单 2；PLAY-01 |
| `02-multi-tune.abc` | 三首曲目 | 多曲目选择器、默认第一首、手动切曲 | DOC-01 / 02 / 03 |
| `03-voices-midi.abc` | 双声部 + `%%MIDI program` | 声部控制、乐器指令统一钢琴音色并标注 | PLAY-06、ENV-07 |
| `04-repeats-tempo.abc` | 反复记法 + 曲中变速 | 播放序列、速度控制（变速语义待 P01） | PLAY-03 / 04 |
| `05-errors.abc` | 语法错误与告警 | 诊断位置与严重性、失败占位、普通告警不阻塞 | STATE-03、L10N-05 |
| `06-untrusted.abc` | 标题 / 注解含 HTML 注入片段 | 一律按文本渲染、无脚本执行 | ENV-03 |
| `07-long-etude.abc` | 48 小节长曲 | 谱面滚动、播放跟随滚动、联动性能基线 | PLAY-11 / 13、PERF-01 |
| `08-chinese.abc` | 中文标题与歌词 | 文本渲染、歌词布局、中文环境 | ENV-03、L10N-01 |

"清单"指 `docs/archive/vscode-extension-plan.md` §7 验证清单；条目见 `docs/spec/`。
