# 决策记录

轻量格式：每条含 日期 / 决策 / 理由；后续新决策追加在文件头部（时间倒序）。

## 2026-10-29 练习设置记忆范围与多窗口策略（P04 / P05）

- 决策（用户确认）：记忆范围仅限当前工作区，记录保存在扩展的 `workspaceState`；无工作区（空窗口 / 单文件）时设置只保留会话内，不写入任何持久存储；跨工作区不自动迁移记录，同一文件在另一工作区按无记录（默认值）处理。多窗口写入采用按文件分键存储、静默后写覆盖：不同文件互不影响，同一文件被多个窗口同时修改时以最后写入为准，不弹通知、不做实时同步、不主动合并同一文件的新旧记录。过期记录不自动清理：无效记录读取时安全回退默认值但不删除；单文件记录只由“重置本文件练习设置”清除，记录随工作区生命周期管理。
- 理由：当前工作区范围与设计 §5 的 `workspaceState` 选择一致，避免空窗口与跨工作区把不同练习环境的同名路径混在一起；无工作区也没有稳定的工作区身份，写入只会制造无法预期清理的孤立记录。按文件分键把多窗口冲突限制在真正同一文件的设置上，符合“不要求跨窗口实时同步”的既定边界；静默后写覆盖对只保存轻量设置而言代价可接受，且不需要新增通知 / 冲突对话框。不自动清理避免文件暂时移出工作区或重命名过程中误删仍有用的记录，符合 SET-08 的“无效记录安全回退”而非“删除”。
- 影响：持久实现以文件 URI 为键、工作区状态为范围；跨工作区行为进入 SET 人工验收；`docs/plan.md` 的 P04 / P05 阻断解除；记录清理只经 SET-07 的显式重置入口，不新增公开命令。

## 2026-10-25 解析诊断与 Problems 发布

- 决策：诊断只消费 abcjs `tune.warnings`（格式 `Music Line:<行>:<列>: <消息>:  <HTML 行摘录>`，行列 1-based、相对本曲输入），不二次解析 ABC。webview 把告警拆成摘要与行上下文（剥掉 HTML 与实体、不翻译、不显示 `Music Line:` 前缀），仅当行列能经 MappedText → toSourceRange 连续映射回曲目原文时上报可靠区间；继承头部（linkable=false）、合成字符、越界或无位置前缀的告警只留在状态区详情，不编造行号。宿主以 `context.version` / `revision` 与最近推送严格比对，晚到的渲染结果直接丢弃；每次渲染全量覆盖，空列表 `delete`；可靠迁移时删除旧 URI 后在新 URI 重发，迁移冲突 / 来源不可用 / 面板关闭时清除。“查看问题”只在存在可靠诊断时显示，点击才执行内置 `workbench.action.problems.focus`；不新增命令、不自动打开 Problems、不弹通知。单次最多 32 条。
- 理由：abcjs 内部 `warningObjects` 的 `startChar` 未暴露到 TuneObject，`warnings` 字符串是唯一稳定可得的位置来源；行列必须再映射回原文才能进 Problems，否则违反 STATE-06“无法可靠定位时不编造行号”。严格版本比对沿用异步任务失效规则（STATE-02 / PERF-07），避免旧任务晚到恢复已修复的错误。全量覆盖让“修复后清除”无需增量 diff。按钮只在有可靠条目时出现，避免提供无内容可看的入口。
- 影响：新增 `src/core/diagnostics.ts`（`parseAbcWarning` / `collectParseDiagnostics` / `MAX_PARSE_DIAGNOSTICS`）；`messages.ts` 增 `diagnostics` 与 `show-problems` 白名单及形状校验；`main.ts` 采集告警、状态区摘要 / 详情与上报；`previewPanel.ts` 新增 `createDiagnosticCollection('abcdesk')` 与按条目生命周期发布 / 清理；l10n 增 `ABC parse warning: {0}`（中英）与 webview 三键；新增 `test/diagnostics.test.ts`，扩展 messages / previewWebview / previewPanel 三处测试。F5 验收待执行（交接见 `docs/manual-checks.md`）。

## 2026-10-02 文件生命周期事件与来源状态机

- 决策：绑定迁移以可靠事件为唯一依据——`onDidRenameFiles` 的新旧对（重命名 / 移动）、`onDidSaveTextDocument` 的对象身份（untitled 首次保存 = 同一 TextDocument 对象 URI 原地更新，接续；非 untitled 的 URI 变化 = 另存为，原预览仍绑原文件）、`onDidCloseTextDocument`（untitled 真正放弃转来源不可用；文件类触发磁盘复核）；每个绑定文件另建文件名转义的内容匹配 `FileSystemWatcher`（create / change / delete），覆盖外部进程写入与原子替换。核验统一走 300ms 防抖（SOURCE_CHECK_DEBOUNCE_MS）+ `fs.stat` 存在性复核 + 世代序号（换键 / 迁移 / 关闭时递增作废在途结果）；有可用编辑器缓冲区（`workspace.textDocuments` 按 URI 命中，插件缓存旧正文不算）时不判不可用，仅提示磁盘缺失并继续按缓冲区预览；无缓冲区且不可读才进入来源不可用，恢复时重读文件并与最近推送内容比对才换版。身份接续统一为"内容未变只更新身份"：continued 消息回显最近推送版本号，webview 据此保留暂停位置、设置与映射；内容是身份判定，容忍重开文档对象的版本号回归；内容变化按常规换版推送并归零。host 的播放 / 起播命令入口对只读来源状态直接拒绝。
- 理由：SPEC-LIFE-03 明确禁止凭"先关闭后打开、同名、相同正文"推断迁移，`onDidRenameFiles` 工作区事件提供可靠新旧对；单次 delete 通知不代表永久丢失（编辑器保存的写临时 + 重命名、外部原子替换都会出现短暂删除），防抖 + 存在性复核 + 世代作废过滤假删除与乱序（SPEC-LIFE-08）。SPEC-LIFE-06 的"插件缓存的旧正文不算可用缓冲区"不否定 VS Code 中真实打开的缓冲区——有缓冲区时必须继续预览、保留未保存修改，只为磁盘缺失提供提示。
- 影响：previewPanel.ts 新增 notifyFilesRenamed / notifyDocumentSaved / notifyDocumentClosed、continueBinding / reopenBinding / markMigrated / refreshTargetBinding、checkSource / attachWatcher / scheduleSourceCheck、enterUnavailable / resumeBinding 与 source-state / continued 协议字段；extension.ts 订阅三个工作区事件；main.ts / tunePicker.ts 实现只读状态页（迁移 / 不可用锁定播放、定位、设置与切曲，恢复解锁）与"打开迁移后的预览"入口；版本簿记统一为 entry.version（最近推送），不再直接比较 document.version。LIFE-08 的实测记录以本条策略为准；真实文件系统事件下的行为复核在 `docs/manual-checks.md` 的 LIFE 批次交接登记。

## 2026-10-02 多曲目预览身份与解析适配

- 决策（用户确认）：跨版本仅以新旧均唯一、非空且不变的真实 `X:` 匹配，不按标题、旧下标或正文相似度猜测。无 `X:` 单曲更新后也进入重选；正常单曲隐藏选择器，待确认时显示“确认此曲目”。同快照选择使用局部索引，音乐设置只在当前预览内隔离，不实现 SET 跨会话持久化。
- 理由：错误对应曲目比要求重新确认更危险。abcjs `TuneBook.id` 对缺失 X: 的文本不可靠；真实实证还发现 CRLF 偏移误差、普通公共头部字段被忽略，因此预览以规范化 LF 的自包含曲目输入加分段原文映射适配，不修改源文件、不重复拼接已经继承的指令。
- 边界：公共头部遵守 ABC 2.1 文件级字段范围及 abcjs 支持的指令；未识别的音乐片段明确限制映射与自动选曲，不暗中跳过。切曲停音后向宿主获取最新快照再匹配，旧选择、音频和源码消息以实例 / 快照 / 选曲 / 请求代次作废。普通查阅不切曲，显式源码起播先核验目标音符；独立导出不跟随预览选曲。
- 影响：DOC-01～06、会话内 SET-03 / 04 / 05、PLAY 与 STATE 交互；人工听验收仍单独登记。

## 2026-10-02 导出实现（Node 侧独立生成 / stub DOM 渲染 SVG / 快照复核）

- 决策：导出 MIDI / SVG 两命令共用一条流程（src/extension/exports.ts），在扩展宿主（Node）侧直接生成、不复用预览渲染实例：MIDI 走 `parseOnly` + `synth.getMidiFile(tune, { midiOutputType: 'binary' })`（无 DOM 依赖）；SVG 用最小 DOM stub（createElementNS / setAttribute / appendChild / getBBox 估算等）驱动 `renderAbc` 后序列化（渲染与序列化全程同步、不跨 await 交错，结束即还原全局 DOM），排版基准固定 staffwidth 740、补首个白底 rect、height 向上取整、currentColor → #000000、滤除 on* 事件属性；abcjs 动态 import 惰性加载，仅首次导出时初始化。曲目文本直接取 `TuneBook.tune.abc`：实证其已并入文件级 `%%` 指令（abc_parse_book.js `tune.abc = directives + tune`），不得再另拼 `header`（会重复指令）。判空沿用预览判据 `el_type === 'note'`（全休止符也是 note，不算空白）。流程：锁定来源（预览在前台取绑定文档，否则活动编辑器）→ 读快照（打开文档以缓冲区为准、含未保存修改）→ 曲目确认（单曲直出；多曲目 QuickPick 按光标所属曲目预选）→ 通知式进度可取消 → 原生保存对话框 → 写前复核（不覆盖源文件、预览来源仍打开、文本未变，否则取消并提示）。文件名：文档基本名 ‖ 曲名 ‖ Untitled，清洗控制字符与 `<>:"/\|?*`、80 截断；多曲目追加序号与曲名（与基本名重复时不重复）。
- 理由：SPEC-EXP-01 / 04 要求导出与预览独立准备——预览关闭或落后不影响导出，前两处均以提示（而非阻止）说明实际导出对象；纯 Node 生成避免 webview 往返与渲染时序耦合。快照复核链落实 CMD-13“执行时文档快照”语义：变化即取消并提示重试，不静默导出旧内容（SPEC-EXP-03、PERF-09）。stub DOM 能力面经 Node 原型实跑验证（与浏览器渲染对照过形状 / 颜色）后忠实移植。指令并入 tune.abc 为实证结论，拼 header 会致 `%%MIDI` 等重复。
- 影响：新增 src/core/exports/（abcjs / tunes / filename / svg-dom / svg / midi 六模块）与 src/extension/exports.ts；extension.ts 注册两命令并删除“未实现”占位循环（8 命令全部真实注册）；previewPanel.ts 增 isPreviewOpen / isPreviewStale；l10n 增 12 键（中英同步）；新增 test/exports.test.ts（18 例：曲目解析 / 判空 / 命名 / MIDI 与 SVG 生成及边界）；manifest 不变（命令与标题早已声明）；EXP 域验收为 manual（manual-checks 已登记 8 条，本批无新增）。

## 2026-10-01 循环开关实现（sync 字形 / stop→seek→start 回绕 / 五段等距）

- 决策：循环开关落地为传输组常驻切换钮（`#loop`，`sync` 字形）＋控制器 `loopEnabled` 标志；自然结束（`handleEnded`）且开关开启时按 `stop → seek(0) → start → syncTimer(0)` 回绕继续，保持播放相位与播放高亮，不清状态、不调 `onTimeline(null)`——回绕不算自然结束，待更新内容仍待停止 / 暂停时按 STATE-07 应用。开关只改行为（默认关、不启播、不修改 ABC），跨停止与换版保留（会话级；SET-03 持久化时并入）。ON 态经 `aria-pressed` + `--vscode-toolbar-activeBackground` 底色呈现（回退 hover 色），样式规则置于 hover 之后靠同特异性后置胜出。图标节奏扩为 `% ⟳ ⟲ ▶ ⏹` 五者墨迹等距 18px：`#speed-group` 右距 1.4→2.4px；传输组内改逐对 margin（gap 归零、`#play` 左 1.45px、`#stop` 左 2.2px）——两对间距因字形墨迹收缩不同而取值不同，gap 无法逐对控制。本条的间距数字取代“顶栏排列调整”条目的 1.4px / 2.2px。
- 理由：回绕顺序必须 stop 在 seek 之前——自然结束后 abcjs 不清 `isRunning`（僵尸运行态），直接 seek 会经 `_kickOffSound` 起播、行为不可控；已结束的源 stop 不再派发 ended，可安全清理。相位保持 `playing` 使 STATE-07“循环回到边界不算自然结束”自然成立，无需新分支。字形经 14px 实况模拟对比选定：`debug-restart` 与重置 `refresh` 同为单环箭头、并排无法区分，`debug-rerun` / `debug-restart-frame` 形状过复杂；`sync` 双箭头环是循环 / 重复的通用语汇（🔁）且小尺寸辨识度最好。间距数值经无头 Chrome 4 倍放大像素实测校准（四段均 18.00px，标尺自检通过），与上批同法。
- 影响：audio.ts（字段、get / set、handleEnded 分支、类头注释）；main.ts（按钮查询、连线、刷新函数同步 aria-pressed）；previewPanel.ts（HTML 按钮、aria-pressed 样式、间距数值）；l10n.ts（`loop` 键，中英）；manual-checks PLAY-03 判据扩展；spec 正文不改（PLAY-03 已含“循环默认关闭、开关本身不启动播放、回边界不触发换版”，实现细节照 P06 先例入本条）。

## 2026-10-01 顶栏排列调整（速度左置）与 % ⟳ ▶ ⏹ 等距节奏

- 决策：控制区排列改为“速度 → 播放 / 停止 → 声部 → 从此处播放”（原为“播放 / 停止 → 速度、声部 → 从此处播放”）；稳定分组由三组改为四组：速度组（`#speed-group`）、播放 / 停止组（新增 `#transport-group`）、声部组、从此处播放组。百分号、重置、播放、停止四个控件的墨迹间距统一为 18px：列间距改由分组 `margin-right` 显式控制——`#speed-group` 右侧 1.4px、`#transport-group` 组内 gap 2.2px（`#speed-control` 组内 4px gap 照旧）、`#speed-reset` 左距 5.15px。
- 理由：F5 反馈——速度调节先于播放更贴合练习流，且四者原被组边界割裂（实测 %→⟳ 12.75px、▶→⏹ 23.75px，播放 / 停止还位于速度左侧）。等距取墨迹（字形边缘）口径，与此前“顶点到灰边”的测量习惯一致；盒距口径会因图标盒含 3px 透明边框 + 3px 内距而系统性偏离观感。速度与播放 / 停止分持两组而非合并：合并后换行最小单元约 205px，极窄面板会连带隐藏播放 / 停止，与 SPEC-PLAY-13“不藏关键控件”冲突。数值经无头 Chrome 4 倍放大像素实测校准（候选 17 / 18 / 19px 择优取 18，验证 % ⟳ ▶ ⏹ 三项均 18.0px）。
- 影响：previewPanel.ts（HTML 组序与四组结构、`#controls` 列间距机制、三条间距数值）；spec PLAY-13 分组列表同步改写为（“速度”“循环、播放 / 暂停、停止”“声部”“从此处播放、更多”）；main.ts 与 manual-checks 无新增判据；“顶栏细化”条目的三组分组表述以本条为准。

## 2026-10-01 顶栏图标 hover “偏大”根因（background 简写重置 background-clip）

- 决策：hover / disabled 底色改用 `background-color`（不再用 `background` 简写）；几何定为内距 3px + 3px 透明边框（灰底 20×20、可视圆角 4px、命中区 26×26 不变；停止字形仍为 `debug-stop`）。
- 理由：`background:` 简写会在 hover 规则里把 `background-clip: padding-box` 重置回 `border-box`，灰底一直画满 26×26 命中区——这正是用户实测“顶点到灰边 9px vs 原生 6px”的来源，也解释了前两轮收紧内距（3→2px、20→18 盒）为何观感无改善（可见几何因内容左边距恒为 6px 实际未变）。本轮以无头浏览器 4 倍放大像素测量定位并验证：修复前灰底 26 / 右隙 7.75px；修复后 20 / 4.75px；VS Code 原生模拟 22 / 5.00px——对齐。真实字形墨迹（TTF 实测）比 SVG 网格估计更大：14px 时约 [2.75, 12.25]、16px 时 [3, 14]。
- 影响：previewPanel.ts（`.codicon` 注释、hover / disabled 声明、内距与边框数值）；main.ts 不变；manual-checks 无新增判据。“顶栏图标反馈续”条目中 18×18 / 2px 的数字由本条取代。

## 2026-10-01 顶栏图标反馈续（hover 内距 / 停止字形）

- 决策（两项，F5 反馈落实）：
  1) hover 可视面由 20×20 再收紧为 18×18、可视圆角 3px：字形 14px 下内距取 2px；4px 透明边框 + `background-clip: padding-box` 维持命中区 26×26 不变。换算依据：原生 22px 盒 / 16px 字形按比例到本顶栏 14px 字形约为 19px 盒，取 18px 落实“观感与原生一致、略紧一档”（用户两轮实测认为内距偏大）。
  2) 停止字形由 `stop` 换为 `debug-stop`：`stop` 实为“圆圈内含 ✕”的取消语义（用户反馈“更像关闭”）；`debug-stop` 为方形描边，符合停止的通用认知，且与 `play`（描边三角）/ `debug-pause`（双竖条）同族。
- 理由：内距观感应以“字形与盒的比例”为准（等比例放大对照核对，3px 内距在 14px 字形下松于原生比例）；媒体控制的 ▶ ⏸ ⏹ 里“方形”是停止的既定图形，✕ 系在 VS Code 语义里是取消 / 关闭（调试工具栏亦以 `debug-stop` 表达停止）。
- 影响：previewPanel.ts（`.codicon` 几何与注释、停止按钮字形类）；main.ts 不变（只设置 title / aria / disabled）；manual-checks 无新增判据。同日“顶栏图标反馈细化”条目中的 20×20 / 4px 数字由本条取代。

## 2026-10-01 顶栏图标反馈细化（hover 矩形 / 准备态 / 停止可用性）

- 决策（三项，F5 反馈落实）：
  1) hover 矩形收紧：可视面 20×20、可视圆角 4px（VS Code 工具栏实测 padding 3px + 16px 图标盒 = 22×22、cornerRadius-small = 4px；本顶栏字形 14px 按 padding 3px 同口径）；3px 透明边框 + `background-clip: padding-box` 把命中区保持 26×26 不变；hover 底色改用原生 `--vscode-toolbar-hoverBackground`（原 25% 灰留作回退值）。同日“顶栏图标尺寸口径”条目的内距 6×7 / 命中区 28×26 数字由本条取代（字形 14px 口径不变）。
  2) 准备态静态化：取消 `codicon-modifier-spin` 旋转动画（用户反馈旋转在圆角矩形背景上突兀）；`loading` 字形保留静态，忙碌语义由字形 + 本地化提示 + 状态行“正在准备音频…”承担。
  3) 停止按钮空闲置灰：`stopButton.disabled = phase === 'idle'`；preparing / playing / paused 均可用——准备期的“停止 = 取消并归零”是 SPEC-PLAY-01 的取消入口，不能随置灰撤掉。
- 理由：hover 矩形只包住图标是 VS Code 工具栏的观感基准（实测 padding 3px、action-label 圆角取 cornerRadius-small）；命中区经透明边框维持不变，不牺牲可点性。准备时长通常很短，动画收益小、干扰大；空闲时停止无可执行内容（L10N-04“只呈现当前真实可用的操作”，A11Y-06 名称同步）。
- 影响：previewPanel.ts（`.codicon` 几何、hover 色、通用 `:disabled` 底色，删除 speed-reset 专属 disabled 规则）；main.ts（图标去 spin、`stopButton.disabled`）；manual-checks PLAY-03 判据增补“空闲时停止置灰”。

## 2026-10-01 顶栏图标尺寸口径（14px）

- 决策：顶栏图标按钮字形定为 14px（内距 6×7，命中区 28×26），并入“与正文文字混排的紧凑动作行”的统一口径；键盘 dock 的收起 / 展开为文字按钮，不适用本口径。
- 理由：本机 VS Code workbench CSS 实测：独立动作图标（标题栏 / 编辑器工具栏 / 标签动作）16px；与文字混排的紧凑条 12～14px（状态栏 12px、标题栏 command center 动作 14px、notebook 单元状态栏 14px）。顶栏图标与 13px 文字混排，此前 16px 观感偏重（用户反馈），取 14px 与正文同层级；命中区仍不小于 24px（设计红线）。
- 影响：previewPanel.ts 的 `#controls button.codicon` 字号与内距；“顶栏动作图标化”条目的尺寸部分由本条明确（未来若出现纯图标工具栏再取 16px）。

## 2026-10-01 声部开关语义反转（勾选＝发声）

- 决策：声部菜单复选框改为“勾选＝该声部发声、未勾选＝静音”（默认全选＝全播放），自动和弦伴奏开关同规则；静音摘要仍按静音计数；存储层（SET-04 静音覆盖）不变；声部菜单（details＋checkbox：多选、需暂停、动态数量）与键盘音域（原生 select：单选、即时生效、纯视觉）的形态差异保持——都优先原生控件、由语义驱动形态，本条统一的是“选中＝启用”的方向语义。
- 理由：多选过滤的心智模型是“勾选的进入结果、未选的不生效”，旧语义要反着读、易误操作；反转后与键盘音域“选中即采用”一致（用户反馈落实）。PLAY-06 规格正文只写“发声开关”、未绑定方向，反转后更贴合，不须改规格。
- 影响：main.ts 取反勾选映射四处并更新注释；manual-checks PLAY-06 判据增补“（勾选＝发声、未勾选即静音）”。

## 2026-10-01 顶栏动作图标化（codicons 捆绑）

- 决策：顶栏采用“图标承担动作、文字承担状态与领域语义”的混合形态（用户确认）：播放 / 暂停 / 取消起播、停止、恢复原速改为图标按钮（`play`、`debug-pause`、`loading`＋spin、`stop`、`refresh`）；速度输入、声部菜单与“从此处播放”保持文字（静音摘要、起播禁用原因属文字状态）；图标按钮用 VS Code 工具栏形态（透明底、`--vscode-icon-foreground`、悬停浅灰、圆角 4px），命中区不小于原文字按钮（不挤小点击区域）；语义由 `title` 与可访问名称承载，文案沿用既有 l10n 键（无新增）；图标资源捆绑 `@vscode/codicons`（devDependency）：构建时把 codicon.css / codicon.ttf / LICENSE / LICENSE-CODE 与自撰 THIRD_PARTY_NOTICES 拷贝到 out/codicons/（图标内容 CC-BY-4.0、仓库代码 MIT），webview 经 asWebviewUri 加载；同日撤销“顶栏布局与无障碍细化”的 #play min-width 补丁（图标宽度固定，文案切换抖动不再存在）。
- 理由：▶ / ⏸ / ⏹ 属通用媒体符号、图标化近零学习成本，换来紧凑与中英文宽度稳定；非通用动作图标化要靠悬停猜测，保留文字更易发现；与 VS Code 惯例（标题栏 / 调试工具栏均为图标＋提示）及项目先例（CMD-15 / 17）一致；“取消起播”不再有常驻文字，由 spinner 形态、本地化提示、状态行“正在准备音频…”与空格 / 停止同语义兜底。
- 影响：previewPanel.ts（codicon.css 链接、三个按钮图标与工具栏样式、撤 min-width）；main.ts（图标类与 title 同步）；package.json / esbuild.config.mjs（devDependency + 构建拷贝）；新增 media/codicons/THIRD_PARTY_NOTICES.txt；PLAY-01、PERF-05、A11Y-06 与 manual-checks PLAY-01 的“显示‘取消起播’”措辞改为“以‘取消起播’语义呈现（图标 + 提示）”；PLAY-13 分组与其余判据不变。

## 2026-09-27 顶栏布局与无障碍细化（P06 后续批次）

- 决策：对顶栏做一轮细化（全部落既有规格，不新增条目）：①控件按稳定分组包裹为三组——播放 / 暂停＋停止、速度＋声部、从此处播放（循环与“更多”实现后就位于对应组），组内不换行、仅组间断行；②状态行 #playback-status 从控件行移出、独占一行置于进度条之后，无文案时隐藏不占位；③声部菜单 Esc 关闭并把焦点还给触发钮（落实 A11Y-05，此前菜单无 Esc 处理），展开时右缘越出视口则翻转为右对齐（CSS 加宽度上限防御），不做点击外部关闭（设计未要求；Esc 与再点触发钮已覆盖退出）；④#play 设 min-width 5.5em，消除“播放 / 暂停 / 取消起播”切换的宽度抖动（按中文最宽文案预留，英文长文案相位仍有小幅增宽）；⑤进度条整行高度 18→24px、拖动中加 .abcdesk-dragging（滑块放大、轨道加粗、抓取光标）；⑥按钮 / summary / 下拉 / 声部复选统一 focus-visible 焦点环（--vscode-focusBorder）；⑦低高度（max-height 400px，暂订实测项）压缩顶栏内距。
- 理由：人工审查对照 SPEC-PLAY-13 与设计 §3 发现：控件无序混排、状态文本与提示挤在控件行、出现 / 消失时推挤控件；声部菜单窄面板下右缘溢出、Esc 无处理属可感知缺口；进度命中区偏小、播放按钮宽度随文案抖动、焦点环仅速度框与进度条有（按钮全靠浏览器默认）。分组只改换行粒度、不藏控件，符合“不把循环、速度、声部收入二级菜单”的既有口径；分组容器同时为后续控件留好落位。
- 影响：previewPanel.ts（HTML 分组容器与状态行移位；CSS：控件间距与分组类、播放按钮最小宽、状态行独占行、进度高度与拖动反馈、菜单宽度上限、低高度压缩、统一焦点环）；main.ts（状态行 hidden 切换、菜单 Esc / 面板右缘约束、进度拖动类的加 / 删）。判据落既有 SPEC-PLAY-13 / A11Y-04 / 05 / 06 / 07 与 manual-checks 现有条目，规格正文不改。

## 2026-09-27 仅钢琴音色的实现方式（播放视图包装展开产物）

- 决策：SPEC-ENV-07 的“播放时统一钢琴音色”经**播放视图**实现：initSynth 向合成器传入 `pianoOnlyTuneView(tune)`——以 `Object.create(tune)` 为原型、只覆盖 `setUpAudio` 的视图，把展开产物中全部 program / note 事件的 instrument 统一为 0（钢琴）；`sequenceCallback` 的音序映射统一保留为收口。原曲目对象不被修改。
- 理由：用户报告“静音部分声部后旋律 / 应答只有少量音符发声”。根因是 abcjs 的音色样本请求发生在 `init` 内部、按展开产物的 instrument 归组（早于 `sequenceCallback` 与缓冲生成），而本地仅内置钢琴目录：材料中的 `%%MIDI program`（03 的 1 / 33、09 的 73）让对应声部在 init 请求不存在的音色目录、并在放置（placeNote）时被静默跳过——只改音序映射会造成“请求集合与实际放置”错配（实测：03 全静默、09 静默 482/1344）。没有直接改写原曲目的 `formatting.midi` 与声部指令元素，是因为 MIDI 导出要求保留材料中的乐器指令（SPEC-EXP-05）；视图其余方法经原型链沿用，拍号 / 弱起 / 拍数行为不变。
- 影响：playback.ts 新增 `pianoOnlyTuneView`；audio.ts 的 initSynth 改用视图、头注释与 sequenceCallback 注释更新；playback.test.ts 新增 03 / 09 回归（展开产物全钢琴 + 原对象保持材料指令）；manual-checks ENV-07 判据增补“全部音符发声、无 404”。

## 2026-09-27 播放控件速度 / 进度 / 声部的交互口径（P06 细化）

- 决策：P06 三项细化与实现口径一次性确认（用户确认，四问均取推荐项）：
  1) 速度控件为数字输入框（25～200、步进 5）＋「恢复原速」按钮：Enter / 失焦 / 原生步进后提交，提交才重建音频（不逐字符），Esc 取消本次编辑并还原当前值；越界输入夹取到 25 / 200，空值或非数字还原为当前值（不引入错误态）。
  2) 进度条键盘操作与点击同一提交路径：方向键 ±1%、PageUp / PageDown ±10%、Home / End 首尾，每次按键立即定位（不引入两段式预览）。
  3) 焦点保持原位：速度框提交后焦点留在输入框；点击进度条后焦点移到滑块（方向键立即可用）；声部菜单用原生 `details` / `summary` ＋ `checkbox` 键盘；进度条为 `role=slider`、`aria-valuetext` 形如「0:12 / 3:24」、`aria-label` 取 l10n「进度」。
- 理由：速度是练习核心参数，输入框支持精确键入与原生命中区上下键微调，四问推荐项都站在「操作可预期、状态最少」一侧：越界夹取贴近用户意图、非数字还原避免错误态；进度键盘与点击同路径避免第二套「待提交」状态；焦点不跳便于连续调整（速度 / 声部）。
- 影响：play.md PLAY-04 / 05 / 06 细化落地（规格正文不改，本记录为实现口径），plan.md 阻断表 P06 置为已确认；manual-checks 三条判据增补可测点。

## 2026-09-27 变速与声部静音的实现口径

- 决策：速度经 abcjs 的 warp 机制实现（与官方 SynthController.setWarp 同一套公式）：合成器以顶层参数 `millisecondsPerMeasure = 自然值 × 100/warp` 重建音频，演奏时序以 `qpm = 拍数 / 该值` 重建；保位置一律用「乐曲比例」（含反复的演奏位置＝当前毫秒 / 含反复总长），不用秒数；变速 / 静音都需重建音频缓冲（abcjs 预渲染，无运行时变速与静音 API），重建期间相位保持不变，播放中变速完成后自动续播、暂停 / 空闲时静默重建（下次播放生效）。声部静音用 `voicesOff` 声部索引数组 + `chordsOff`（abcjs 实际以音量 0 静音，听感属 M0 人工听验项）；自动和弦伴奏轨的识别＝展开产物中「额外轨首个 program 指令的 channel 等于声部数」（和弦轨存在且仅在曲目含可解析和弦时）；声部名取 `staff.title[同行内声部序]`（谱面实际标注 V:name），无名回退「声部 N」；速度与静音在会话内跨版本保留（换版不清空，索引失配交由音频层自然忽略；SET 域持久化另批）。
- 理由：公式与保位置机制对齐 abcjs 官方实现，避免自创换算；「乐曲比例」对含反复曲目是唯一能定位第二次反复的坐标（SPEC-PLAY-05 要求）；跨版本保留静音与速度减少练习中的重复操作，且静音只是发声层参数、不影响谱面与键盘提示（SPEC-PLAY-09）。
- 影响：audio.ts 新增速度 / 声部 / 进度状态与重建流程、暴露时序刷新回调（变速重建时序后 main 需重取 getTimings，否则「从此处播放」毫秒尺度错位）；新增 webview 纯逻辑模块 playback.ts 承载速度解析 / 夹取、时间格式化、声部收集、和弦轨识别与带拍换算判据。

## 2026-09-27 编辑器轮廓标记随当前目标同步

- 决策：编辑器侧轮廓标记从“点选驱动、不随查阅光标移动”改为“随当前目标音符同步”：预览点选与源码光标命中（后发生者胜）都更新轮廓区间，目标清除、内容变化或面板关闭时一并清除；目标区间由 webview 在目标变化时回传（新增消息 `target-ranges`，空数组表示清除，映射不可靠 / 联动停用时跳过），宿主据此同步轮廓装饰；`abcdesk.goToSource` 的落点也改为当前目标区间，无目标时不套用旧偏移。
- 理由：用户人工使用中发现——先在预览点选音符（代码里出现蓝框），再把光标移到代码中的另一音符，蓝框仍留在旧音符上、指向已不是目标的位置；统一目标模型（见同日“点选与查阅统一为‘当前目标音符’”）后，代码侧标记应与谱面填充、虚线框、键盘反射一样指向当前目标或随目标清除。另：停止 / 暂停时移动源码光标会让轮廓自然跟到停止位置，信息比“最后一次点选”更符合预期。
- 影响：play.md PLAY-11 该段改写，manual-checks PLAY-11 判据更新；messages.ts 新增 `target-ranges` 消息与校验（复用区间数组上限与逐项重构建），messages.test.ts 补充用例；previewPanel.ts 以 `targetRanges`（原 `lastNoteRange`）驱动轮廓装饰与 `goToSource` 落点，`revealRange` 不再自行记录区间；main.ts 在 `applyTarget` 变化时回传区间（按序列化去重，避免光标在同一音符内移动的重复消息）。2026-09-26“点击联动的编辑器侧标记方式”中“新点击替换旧标记、内容变化清除、不随查阅光标移动”的驱动口径被本条取代。

## 2026-09-27 点选与查阅统一为“当前目标音符”

- 决策：预览点选与源码光标命中维护同一“当前目标音符”（后发生者胜）：谱面用填充 + 包围虚线框呈现同一目标（不再分为“只有点选填充 / 只有查阅框”两套标记），键盘反射与“从此处播放”按钮及 `abcdesk.playFromSelectedNote` 命令都取这一目标；点到非音符元素、光标离开音符（或位于其他曲目）、换版重渲染时目标清除；按钮禁用原因改为无目标音符 / 有待更新 / 旧谱参考，原因按实际停用状态取（联动停用优先于无目标提示）；命令标题保持“从所选音符播放（预览）”不变——“预览”标明取位自预览侧维护的目标，不再意味着只认预览点选。
- 理由：用户人工使用中发现两套语义会不一致：在代码里点选音符出现“联动选中”（查阅虚线框），但“从此处播放”要么因未点选而禁用、要么仍指向早前在预览里点选的另一个音符；谱面填充、虚线框、键盘反射与起播位置可能各指一处，与“从这里播放”的自然预期相悖。统一为单一目标后四者始终指向同一音符。
- 影响：main.ts 把 selectedNote / readingOffset 合并为 targetOffset 与统一 applyTarget；目标填充改由 `abcdesk-target` 类管理，更新目标时清理 abcjs 原生选中类残留并按渲染快照还原其写入的填充属性；updatePlayFromHereButton 的禁用原因优先级调整；play.md PLAY-11 / 12 / 15、cmd.md CMD-08 改写，manual-checks PLAY-11 / 12 判据更新，cmd 占位测试描述更新；webview 提示与宿主文案更新（`select-note-first` / `no-selection`，另加无预览情况的新文案）。2026-09-26“两个起播命令的可见入口”中“对预览所选音符起播、未点选音符禁用”的取位与禁用描述被本条取代。

## 2026-09-27 移除预览内的文件名状态行

- 决策：删除 webview 内的文件名状态行（#status）及其“尚未保存”文案键；顶栏只保留播放控件。文件名与未保存状态由预览面板标签承载（标题为 `文件名` / `文件名（尚未保存）`，随每次文档推送更新，中文文案已在 l10n/bundle.l10n.zh-cn.json）。
- 理由：用户人工使用中发现与 VS Code 标签名重复。面板标签已实时显示名称与未保存标记，行内信息无任何独有内容（#status 是 webview 侧 fileName / isUntitled 与 'unsaved' 文案的唯一消费者），删除后顶栏更矮、谱面可视区更大；SPEC-CMD-06 的“预览标明尚未保存”由标签标题继续满足。
- 影响：previewPanel.ts（#topbar 内删 #status 与对应 CSS、头注释）；main.ts 删状态行更新与元素引用；l10n 删 'unsaved'；文档消息中的 fileName / isUntitled 字段保留（属宿主↔webview 契约，ENV-04 校验覆盖）。同日“控制区粘在预览顶部”决策中“状态行与播放控件合并”的部分被本条取代，顶栏保持粘住不变。

## 2026-09-27 控制区粘在预览顶部

- 决策：把文件名状态行与播放控件合并为一条 sticky 顶栏（`#topbar`，top: 0、z-index 高于谱面与键盘），长谱滚动时保持可见可点；键盘继续贴底，滚动仍走整页；自动滚动的顶部预留量改为顶栏实际高度（顶栏换行变高时随之更新）；低高度回退时顶栏仍保持粘住（键盘按现有例外回文档流）。
- 理由：用户人工使用中报告 Play / Stop / Play from Here 滚动后超出视口、点不到。设计稿 §3（已确认）本就定为“顶部控制区、中央独立滚动谱面、底部可收起键盘，控制区与展开的键盘保持可见”——键盘批次把键盘做成贴底后，控制区仍是文档流，属实现偏离设计；修回顶部而非贴键盘上方：键盘保持已调校的无多余按钮形态，后续循环 / 速度 / 进度等控件在顶栏扩展，低高度处理也更简单。
- 影响：previewPanel.ts 结构（#topbar 包裹 #status + #controls）与 CSS；main.ts 的 scrollIntoViewIfNeeded 顶部预留；play.md 与 manual-checks 的 PLAY-13 增补条款。此前 #status 单独 sticky 而 #controls 滚动中被盖住，合栏后两者同步常驻。

## 2026-09-27 查阅 / 点选反射到键盘

- 决策：新增 SPEC-PLAY-15——源码光标或预览点选命中音符时，键盘上对应琴键以查阅蓝（#1a73e8，与查阅虚线框同族）突出；播放高亮保持橙（#d84315），同键同时命中时播放色优先（CSS 中播放规则保持在反射规则之后）；反射与查阅标记共用同一映射（findTimingEvent），随其在离开音符、点到非音符、换版重渲染时一并清除；v1 不自动滚动键盘、不显示视口外方向提示（有意区别于播放提示，避免光标移动频繁带动键盘滚动；实测需要再补“必要时带进视野”）。
- 理由：用户人工使用中要求“点选代码或预览的音符时键盘反映当前点选的键”，便于对着琴键找位置；与播放高亮必须并存且可区分，与谱面查阅标记共用同一识别路径可避免两套映射不一致。
- 影响：keyboard.ts 增加 setPointedPitches / clearPointedPitches 与 abcdesk-key-pointed 类；main.ts 在 handleScoreClick / applyReadingMarker / resetLinkageState 接线；previewPanel.ts 增加键色规则；play.md 新增 SPEC-PLAY-15 并在 PLAY-11 加交叉引用；manual-checks 增加对应条目。

## 2026-09-27 移除“隐藏提示”入口

- 决策：删除“隐藏提示 / 显示提示”按钮、占位文案与相关状态（webview 侧 hintsHidden / setHintsHidden、按钮与占位 DOM、三个 l10n 文案键全部移除）；键盘提示的显隐由“收起”承担（收起后 dock 条只留说明与展开入口）；移除 SPEC-PLAY-07 并清理各规格为其写的附加条款。
- 理由：用户人工使用中发现 Hide hints 与 Collapse 语义重复：Collapse 已覆盖“练习时不看键盘提示”的主要场景，Hide hints 独有的能力只剩“连谱面一起隐藏”（预览因此基本空白，无登记的使用场景）。与其保留两个容易混淆的相邻状态，不如只留语义单一的收起；D0 线框与 SET-05 中的提示显隐记忆一并作废（记忆批次不再实现该项）。
- 影响：play.md 删除 SPEC-PLAY-07（编号保留空位、后续不重排，避免引用漂移）；PLAY-13 分组、STATE-03 / 08、LIFE-06、PERF-06、A11Y-03、EXP-06、L10N-04、SET-05 的隐藏提示附加条款删除或改写；manual-checks 删除 PLAY-07 条目并同步其余条目判据；早期键盘与 dock 决策条目中提及隐藏提示的内容为历史记录，以本条为准。

## 2026-09-27 谱面容器宽度溢出的两处修复

- 决策：`#score` 增加 `box-sizing: border-box`；谱面 SVG 以 `#score > svg { width: 100% !important; height: auto !important; }` 覆盖 abcjs 内联宽高、按 viewBox 比例跟住容器宽；body 同时 `overflow-x: hidden`（预览无全局横滚需求：谱面贴容器宽、键盘内部横滚）。
- 理由：人工验证发现几乎无范围的全局横向滚动条、且键盘 dock 右侧露出谱行右端（键盘看似偏左）。经浏览器 harness 实测确认根因：abcjs responsive 模式往谱面容器写内联 `width:100%`（配合 padding-bottom 宽高比技巧），content-box 下再加我们的 `padding: 12px` 实际占宽 = 容器宽 + 24px，溢出撑起全局横滚；dock 按容器宽 stretch 比溢出区窄，横向滚动后 dock 右侧未覆盖竖条露出 `#score` 溢出段的白底与谱行右端。SVG 宽高覆盖则兜住渲染后容器变窄（abcjs 只监听 window resize）的另一类溢出。
- 影响：修复后实测无任何元素右缘超出文档可视宽，dock / 谱面 / SVG 右缘对齐；查阅框 / 跟随滚动按 getBoundingClientRect 实测几何自动适配；键盘内部横滚与方向提示不受影响。

## 2026-09-27 时序事件音高依赖 setUpAudio 先行

- 决策：webview 播放引擎在采用新曲目后、构建 TimingCallbacks 之前先调用一次 tune 的 setUpAudio({})（abcjs 未声明的内部能力，经结构类型访问并 try/catch 兜底），保证时序事件携带 midiPitches；合成器初始化随后以其自身参数重跑，音高值不受乐器参数影响。
- 理由：人工验证发现键盘音域报"没有可提示的音高"、播放时琴键不变色。根因：abcjs 只经 setUpAudio（合成 / MIDI 路径）把 midiPitches 写到音符元素上，而 TimingCallbacks 建构即经 setTiming/setupEvents 克隆该数据——我们在渲染后、首次播放前建时序，克隆到的是空数组；晚补不会回填已克隆的事件。
- 影响：audio.ts 新增 preparePitchData；键盘音域与播放高亮的数据源恢复为时序事件（collectPitches 不变）；该顺序约束属 abcjs 内部行为，若后续 abcjs 改变时序构建方式需重新核实。

## 2026-09-27 键盘 dock 贴底的布局形态

- 决策：键盘改为独立 dock 粘在预览底部：body 为 flex 纵列（min-height: 100vh），谱面区 flex 拉伸把 dock 顶到视口底边（短文档也贴底），键盘本身 position: sticky; bottom: 0（长文档滚动中始终贴底）；dock 无盒子边框与多余按钮，只有一条弱化 dock 条（左："乐谱提示，含静音声部"说明与无音高 / 超范围状态；右：音域下拉与透明底收起 / 展开按钮，字号比正文小一级）；dock 底色随明暗主题（浅 #f1f3f5 / 暗 #262a31），琴键去掉白底容器直接铺在 dock 上。滚动仍走整页；跟随滚动的视口底边扣除 dock 高度，"恢复跟随"浮动入口底边经 --abcdesk-dock-height 变量避开键盘。低高度（暂订 max-height: 400px，M0 实测项）时键盘回文档流随内容整体滚动（D0 低高度例外）。收起时 dock 条只留说明与展开入口。
- 理由：人工验证对照 chatmusic 调校版反馈：分栏盒子 + 蓝色按钮头部"不像键盘"；chatmusic 的形态就是贴底扁平键条、控件不在键盘上。sticky + flex 拉伸在短 / 长文档下都贴底，且不需引入内滚动容器（避免跟随滚动、键盘滚动键等行为回归）；D0 线框的音域 / 收起控件保留但弱化为 dock 条，规格语义（PLAY-08 / 09 / 13）不变。
- 影响：previewPanel.ts 布局与键盘 CSS 重写（新增 #score-region 包裹层、#keyboard-meta dock 条，移除 #keyboard-title / #keyboard-header）；keyboard.ts 移除标题元素、收起时隐藏音域选择；l10n 删除 keyboard-title 键；main.ts 跟随滚动扣除 dock 高度、新增 dock 高度 ResizeObserver；人工检查 PLAY-07 / 08 / 09 判据不变，低高度阈值为暂订实测项。

## 2026-09-26 键盘可视化与隐藏提示的落地口径

- 决策：键盘默认"乐曲"音域模式——取当前曲目整首记谱材料音高（含静音声部）的最小～最大 MIDI 音，居中扩展至至少两个八度（24 半音）并夹取到 A0–C8（21–108）；"完整 88 键"模式显示全部 A0–C8；超出范围的音高不折返到其他八度，在键盘区用一行说明列出。全休止符等无音高材料显示默认两八度参照音域（C3–C5）并说明没有可提示的音高。隐藏提示时谱面与键盘整体移除、保留控制区与状态信息，"提示已隐藏"以内容区占位呈现，入口为控制区按钮切换为"显示提示"；恢复时还原原有展开 / 收起与音域模式状态。方向提示为键盘滚动容器两侧的浮动箭头（非按钮、aria-hidden），播放不自动横移、不把手动浏览拉回。音域控件用原生下拉框（乐曲 / 完整 88 键）。
- 理由：PLAY-07 / 08 / 09 已定行为，但"音域边界算法、方向提示、非按钮形式的无障碍说明"等实现口径属设计 §3 待落实清单，由本批次落地；对照 chatmusic 参考实现（88 键常显、琴键可点击试听、自动横移）按规格做减法：默认只显示材料音域、琴键纯可视、播放不自动滚动。
- 影响：实现为 src/webview/keyboard.ts（音域 / 展开 / 键表 / 尺寸算法为纯函数，由 SPEC-PLAY-08 真实测试覆盖；视图类负责 DOM）+ main.ts 与 previewPanel.ts 接线；人工检查 PLAY-07 / 08 / 09 判据不变；展开 / 收起、音域模式与提示显隐的跨会话恢复留待设置记忆批次（SPEC-SET-05）。

## 2026-09-26 转到源码编辑在来源标签关闭后重新打开

- 决策："转到源码编辑"（命令、预览标题栏按钮、状态页按钮）在来源标签已关闭但文件仍可读取时按绑定 URI 重新打开该文件并显式转移焦点，预览继续绑定该文件：磁盘内容有变化时按常规换版规则推送，未变化不推送以保留播放位置；仅文件被删除 / 无法读取时说明原因，不自动新建同路径文件。点击谱面的源码定位在标签关闭时仍不重新打开（保持 SPEC-PLAY-11"不因播放打开已关闭的源码页"与 SPEC-LIFE-05"仅关闭源码标签不关闭预览、仍能单独练习"）。
- 理由：用户对照 VS Code 内置 markdown 预览的"Open Source File"发现差异——内置入口会重新打开已关闭的来源；D0 设计"来源文档可用时'转到源码编辑'仍可打开它"中"可用"指文件可读取而非标签处于打开状态，此前实现把已关闭的文档对象直接交给打开调用、落入不可用兜底，属实现偏差（M0 实测发现）。
- 影响：SPEC-CMD-12 表述细化并补充依据；实现为前台预览绑定 URI 回退（activeBoundUri）+ 按 URI 重新打开与按内容差异重新推送（lastPushedAbc）；CMD-12 绑定测试仍为占位（宿主行为待集成测试）。

## 2026-09-26 预览面板返回源码的标题栏入口

- 决策：预览面板标题栏提供"转到源码编辑"图标按钮（`editor/title` 菜单贡献、可见条件 `activeWebviewPanelId == abcdesk.preview`，复用 `abcdesk.goToSource`，图标 `$(go-to-file)`），与源码侧"打开预览到侧边"的标题栏按钮互为对应；状态页（空文件、旧谱参考等）原有的"转到源码编辑"按钮保留不变（SPEC-STATE-05 / 08）。
- 理由：用户请求（对照 VS Code 内置 markdown 预览标题栏的"Open Source File"，多标签并存时从预览直达其来源文档更实用）；属导航类编辑器入口而非播放控件，与"原生标题栏保留打开预览等编辑器入口"的既定原则一致；D0 未登记该入口，按"先登记后实现"补充登记。
- 影响：新增 SPEC-CMD-17 并由 manifest 测试真实覆盖；`abcdesk.goToSource` 增加 icon 贡献；CMD-03 的标题栏断言改为按命令过滤，容纳第二个标题栏入口；不新增命令与默认组合键。

## 2026-09-26 两个起播命令的可见入口

- 决策：预览控制区实现 D0 既定的常驻"从此处播放"按钮（控制区分组第三组，"更多"加入前与低频操作同组）：对预览所选音符起播，与 `abcdesk.playFromSelectedNote` 命令共用起播路径与原因说明；未点选音符、有待更新或旧谱参考时禁用并在按钮上说明原因。"从光标播放"增加 `.abc` 编辑器右键菜单入口（`editor/context` 菜单贡献，只加入口、不新增命令）。
- 理由：用户反馈两个起播命令仅经命令面板难以发现；预览按钮位置为 D0 已定布局（线框图"从此处播放 / 更多"组、设计 §3"无有效定位时禁用并说明原因"），"跟随所选音符"浮动方案因未选中时功能不可见、抢占相邻音符点击命中、移动靶的 Tab / 读屏体验与稳定布局规则未采纳；源码侧标题栏图标违反已确认的"主要播放控件位于 webview 内，不分散到原生标题栏"，改用与资源管理器右键入口同族的编辑器右键入口。
- 影响：SPEC-PLAY-12 补充按钮存在性与禁用规则、SPEC-PLAY-14 补充等待交互期间点击按钮按新请求替换、新增 SPEC-CMD-16（编辑器右键入口）并绑定测试；manual-checks PLAY-12 / 14 判据更新；实现为 webview 控制区按钮 + 新消息 `play-from-selection-request`（SPEC-ENV-04 校验）与 package.json 菜单贡献。

## 2026-09-26 查阅框随面板尺寸变化重新测量

- 决策：预览面板尺寸变化后用 ResizeObserver（观察谱面容器）按当前几何重新测量并重绘查阅框，保证框始终贴合音符；保持覆盖层方案（不进入 abcjs 的 SVG）。
- 理由：人工验证发现：abcjs 的 `responsive: 'resize'` 不重排版，而是以 viewBox + 容器宽高比让 SVG 纯 CSS 缩放（`setResponsiveWidth`），音符的屏幕几何随缩放变化；覆盖层用固定像素坐标，缩放后不跟随、框漂离音符，直到下次点击 / 光标事件才复算。
- 影响：SPEC-PLAY-11 补充尺寸变化后的重贴合表述；manual-checks PLAY-11 判据补充；实现为 main.ts 的阅读偏移状态（readingOffset）与 ResizeObserver 重绘（refreshReadingBoxes）。

## 2026-09-26 两个起播命令标题的消歧

- 决策：`abcdesk.playFromCursor` 与 `abcdesk.playFromSelectedNote` 的标题以括注标明位置来源、保留核名与命令 ID：中文"从光标播放（源码）" / "从所选音符播放（预览）"，英文 "Play from Cursor (Source)" / "Play from Selected Note (Preview)"。
- 理由：命令面板全局可见，原标题未交代光标 / 所选音符位于源码还是预览侧，单独看与相互对照都难以快速区分；括注写法与既有"打开音乐预览（侧边）"一致。曾考虑按上下文拆分命令 category 或按 when 从面板隐藏：前者破坏 SPEC-CMD-02 的统一分组前缀，后者降低可发现性且与"调用时说明原因"（SPEC-CMD-05 / 11）冲突，均未采纳。
- 影响：SPEC-CMD-02 补充标题消歧规则并由真实测试覆盖（占位转正）；SPEC-CMD-07、docs/spec/doc.md 与 docs/manual-checks.md 中的标题引用同步；实现为 package.nls.json 与 package.nls.zh-cn.json 的双语标题更新。

## 2026-09-26 预览侧点选与查阅标记改为音符包围框

- 决策：预览谱面的点选 / 查阅标记从"沿音符字形描蓝色虚线"改为"音符簇包围虚线框"（覆盖层绘制，不进入 abcjs 的 SVG、不阻断点击命中；和弦为一框、tie 展开的各簇各自成框）；点击选中的音符填充由 abcjs 原生亮红（#ff0000）改为柔和蓝（CSS 覆盖 abcjs-note_selected 的 fill），与播放高亮的填充换色（#d84315）形状与颜色双重区分。标记语义不变：点谱面回显、光标移动跟随、播放中只更新不抢滚动。
- 理由：人工验证反馈：字形描边在小尺寸音符上观感差且不够明显；包围框与编辑器侧标记语言一致；原生亮红偏刺眼且与播放的橙红填充接近，易混淆。
- 影响：SPEC-PLAY-11 补充谱面侧标记表述；manual-checks PLAY-11 判据补充；实现为 main.ts 覆盖层框 + CSS（.abcdesk-reading-box / .abcjs-note_selected 覆盖色）。

## 2026-09-26 点击联动的编辑器侧标记方式

- 决策：点击谱面音符仍设置真实编辑器选区（保留"选中对应源码片段"语义与可复制性），并叠加专用轮廓装饰（主题色虚线描边 + 概览标尺刻度）标出该片段；新点击替换旧标记，文档内容变化 / 联动停用 / 面板关闭时清除（与 lastNoteRange 同步）。不修改用户编辑器设置、不试图关闭 VS Code 原生同文高亮（occurrencesHighlight / selectionHighlight），仅以形状与颜色与原生效果区分。
- 理由：人工验证发现仅复用原生选区视觉时，与 VS Code 同文高亮（同样的音符文字出现灰色扩散）难以区分；同文灰影为 VS Code 原生行为，扩展无法按范围关闭。专属轮廓（描边 vs 填充）在可辨识性与既有交互语义之间取平衡；"仅轮廓、不设选区"方案需削弱已登记的选中语义，未采纳。
- 影响：SPEC-PLAY-11 补充编辑器侧标记表述；manual-checks PLAY-11 判据补充；实现为 previewPanel 新增装饰类型（linkedNote）与随可见编辑器 / 文档变化的同步清除。

## 2026-09-26 P02 反复音符默认起播落点

- 决策：起播定位落在反复段落内的音符时，默认取该音符按演奏时序的第一次出现处起播；不提供落点选择界面，映射不可靠时仍按 PLAY-12 禁用并说明原因。
- 理由：行为直观、与谱面从上到下与演奏从头到尾的直觉一致；同一元素在展开后的时间轴中可能多次出现，取首现值唯一且稳定。
- 影响：SPEC-PLAY-12 补全落点规则、解除 P02 阻断；plan.md 阻断表 P02 标记为已确认；实现需按时序展开顺序记录每个音符的首次出现位置。

## 2026-09-26 预览谱面纸张外观

- 决策：预览谱面按纸张外观固定呈现（白色谱纸、黑色谱面与文字），不随主题反色或变色；页面其余 UI 继续使用 `--vscode-*` 跟随主题；行为登记为 SPEC-A11Y-09。
- 理由：abcjs 默认以 `currentColor` 绘制谱面以"自动跟随暗色模式"，与本预览的纸张设计冲突——暗色主题下谱线继承浅色前景色、在白纸上对比度不足（实测近似"蒙雾"）；固定纸张外观与 D0 已确认的导出 SVG"白底黑谱"一致，避免预览与导出两套外观。
- 影响：谱面区固定前景色为黑；主题适配由 manual 验证覆盖（SPEC-A11Y-09）。

## 2026-09-26 初始化审阅调整

- 决策：仓库结构与工具解耦——不使用 `.qoder/` 等工具专属目录；铁律与流程统一以 `docs/conventions.md` 为唯一入口（`docs/plan.md` 引用已同步）。
- 决策：`README.md` 采用中英双语（英文在前），其余 `docs/` 文档维持中文约定。
- 决策：依赖版本策略——`@types/vscode` 保持 1.75.0 精确锁定对齐开发基线；TypeScript 与 Vitest 保持当前 major（7.0 与 5.0 均为刚发布的 major 升级，暂不跟进）；`esbuild` 升至 ^0.28.2，`@types/node` 对齐运行时至 ^22（开发机与目标环境均为 Node 22）。
- 理由：初始结构与工具无关，避免工具目录成为规范载体；README 面向双语读者，文档内部保持中文一致；依赖以“稳定且匹配运行时”优先，不做版本追逐。
- 影响：调整后 `npm run check` 与 `npm run build` 全绿。

## 2026-09-26 项目初始化

- 决策：仓库采用三层文档结构——`docs/plan.md`（方向）、`docs/spec/`（唯一验收契约）、`docs/conventions.md`（流程）；`docs/archive/` 冻结 D0 文档仅作追溯。
- 决策：规格↔测试双向绑定——测试标题前置 `[SPEC-域-序号]`，未实现用 `it.todo` 占位，manual 条目登记于 `docs/manual-checks.md`；`scripts/spec-check.mjs` 纳入 `npm run check`。
- 决策：工具链沿用旧仓库习惯——TypeScript strict、ESLint flat config（typescript-eslint）、Vitest、esbuild 双 bundle（extension CJS + webview IIFE）。
- 决策：规格蒸馏采用"示范域先行"——CMD 域全量蒸馏（SPEC-CMD-01～14），SET 域先蒸馏首条（SPEC-SET-01），其余域建档并将补全顺序登记在 `docs/plan.md`。
- 决策：`engines.vscode` 取 `^1.75.0` 为开发基线（`@types/vscode` 同步精确锁定 1.75.0），终值待 E03 实测后回填。
- 理由：控制初始化体量，同时让方向（plan）、验收（spec）与实现（test）互相锁定，避免开发过程偏离 D0 已确认设计。
- 影响：骨架阶段不实现任何命令行为；`docs/archive/` 不参与验收。
