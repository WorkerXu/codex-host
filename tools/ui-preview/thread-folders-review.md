# 对话工作文件夹界面复审记录

2026-11-17；按 ui-quality-bar.md 和 review-thread-folders-ui.md 的 0–8 项修改。以下 26 张最终截图均经过真实鼠标 / 键盘操作，并逐张打开查看。常规窗口 1280×900，窄窗口 390×740。

## 原生结构与主题来源

- `tools/ui-preview/fixtures/native-composer.html` 来自当日运行中的 Desktop，只读 CDP 导出后去除 Host 注入控件、对话标识并清空编辑器。保留真实 `ComposerLayoutRoot`、ProseMirror、附件区及 footer 结构；原生模型位置的标签和机器 / 项目值使用确定性 fixture。
- `loadDesktopCss` 加载 `CODEX_DESKTOP_CSS` 指定的真实 Desktop 样式；文件为 `/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-reference/codex-desktop.css`。文件系统、保存回复及示例转录是 fixture，不连接真实 Host。
- 文件夹场景不加载浅色 shadow-context，也不注入 preview.css 的近似深色映射。浅 / 深色都由 Desktop 自带 `[data-theme]` 和 `light-dark()` 规则解析。实测深色页面 surface 为 `#181818`、菜单为 `rgb(45, 45, 45)`、错误文字为 `rgb(250, 66, 62)`。
- CSS SHA-256：`45b6cbc843f0dd1b94491ae1ed8ff03fcb9cdf53b16eb10896673037648dd987`。截图及来源校验记录在上述目录的 `manifest.json`；图片不纳入 Git。

## 逐图复查

| 截图 | 对应审查项 | 已修问题与复查结果 |
| --- | --- | --- |
| [01-local-chip-hover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/01-local-chip-hover-light.png>) | 0、7 | 鼠标悬停工作文件夹 chip。统一两个 chip 的字号、间距、圆角及悬停底色，Composer 使用原生 DOM。 |
| [02-local-popover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/02-local-popover-light.png>) | 1、2、3、5、6 | 打开本机菜单。移除浏览器复选框、机器副标题和底部操作；目录名为主、缩写路径为次，保留末级目录和完整 title；添加图标与文字列对齐，浮层向上对齐 chip 左缘。 |
| [03-local-multiselect-hover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/03-local-multiselect-hover-light.png>) | 1、4 | 真实点击多选后悬停「设为主要」。选项即时生效，chip 立即出现 +1；主要标记缩为小标签，动作只在悬停或键盘聚焦时显示。 |
| [04-local-main-keyboard-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/04-local-main-keyboard-light.png>) | 4、键盘 | Tab 后 Enter 设置主要目录。新主要项移到首位，蓝色原生焦点环清楚，原目录仍选中；没有取消 / 应用按钮。 |
| [05-local-completion-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/05-local-completion-light.png>) | 2、5、6 | 键盘输入本机父路径。补全项也使用目录名、缩写路径和图标；内容增长时浮层向上重新定位，输入框焦点不丢失。 |
| [06-remote-browse-hover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/06-remote-browse-hover-light.png>) | 2、5、6、7 | 在开发机输入远程路径，鼠标悬停 sandbox。远程标识留在机器 chip，补全列表不超视口，悬停底色与主列表一致。 |
| [07-existing-note-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/07-existing-note-light.png>) | 4、8 | 已有对话多选并切主要项，Esc 关闭。长路径段落改为短名称、主要标记和居中细分隔线；完整路径保留在 title，焦点返回 chip。 |
| [08-limited-popover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/08-limited-popover-light.png>) | 1、3 | 仅主要目录模式。保留必要能力说明，移除机器 / 对话用途副标题；最后一个已选目录不能取消。 |
| [09-empty-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/09-empty-light.png>) | 空态 | 空目录集合。使用简短空态文字和带图标的添加入口，无空列表或多余底栏。 |
| [10-loading-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/10-loading-light.png>) | 加载态 | 延迟加载。菜单显示中文读取状态并保持 chip 锚点，Esc / 点击外部仍可关闭。 |
| [11-error-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/11-error-light.png>) | 错误态 | 读取失败。将英文后端异常转为可读中文提示，使用 Desktop 危险色，无浏览器弹窗。 |
| [12-save-error-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/12-save-error-light.png>) | 错误态、4 | 即时保存失败。保留原目录和 chip 标签，展示中文错误；修正鼠标悬停与程序焦点造成的双行背景。 |
| [13-narrow-keyboard-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/13-narrow-keyboard-light.png>) | 2、6、7、聚焦 | 390×740 窄窗口，真实 Tab / Enter 打开。两个 chip 同排收缩省略，浮层仅在右侧空间不足时向左限位，保持 12px 视口边距和键盘焦点环。 |
| [01-local-chip-hover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/01-local-chip-hover-dark.png>) | 0、7 | 鼠标悬停工作文件夹 chip。统一两个 chip 的字号、间距、圆角及悬停底色，Composer 使用原生 DOM。 |
| [02-local-popover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/02-local-popover-dark.png>) | 1、2、3、5、6 | 打开本机菜单。移除浏览器复选框、机器副标题和底部操作；目录名为主、缩写路径为次，保留末级目录和完整 title；添加图标与文字列对齐，浮层向上对齐 chip 左缘。 |
| [03-local-multiselect-hover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/03-local-multiselect-hover-dark.png>) | 1、4 | 真实点击多选后悬停「设为主要」。选项即时生效，chip 立即出现 +1；主要标记缩为小标签，动作只在悬停或键盘聚焦时显示。 |
| [04-local-main-keyboard-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/04-local-main-keyboard-dark.png>) | 4、键盘 | Tab 后 Enter 设置主要目录。新主要项移到首位，蓝色原生焦点环清楚，原目录仍选中；没有取消 / 应用按钮。 |
| [05-local-completion-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/05-local-completion-dark.png>) | 2、5、6 | 键盘输入本机父路径。补全项也使用目录名、缩写路径和图标；内容增长时浮层向上重新定位，输入框焦点不丢失。 |
| [06-remote-browse-hover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/06-remote-browse-hover-dark.png>) | 2、5、6、7 | 在开发机输入远程路径，鼠标悬停 sandbox。远程标识留在机器 chip，补全列表不超视口，悬停底色与主列表一致。 |
| [07-existing-note-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/07-existing-note-dark.png>) | 4、8 | 已有对话多选并切主要项，Esc 关闭。长路径段落改为短名称、主要标记和居中细分隔线；完整路径保留在 title，焦点返回 chip。 深色提示使用次要文字色，修正三级色在页面背景上过淡的问题。 |
| [08-limited-popover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/08-limited-popover-dark.png>) | 1、3 | 仅主要目录模式。保留必要能力说明，移除机器 / 对话用途副标题；最后一个已选目录不能取消。 |
| [09-empty-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/09-empty-dark.png>) | 空态 | 空目录集合。使用简短空态文字和带图标的添加入口，无空列表或多余底栏。 |
| [10-loading-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/10-loading-dark.png>) | 加载态 | 延迟加载。菜单显示中文读取状态并保持 chip 锚点，Esc / 点击外部仍可关闭。 |
| [11-error-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/11-error-dark.png>) | 错误态 | 读取失败。将英文后端异常转为可读中文提示，使用 Desktop 危险色，无浏览器弹窗。 |
| [12-save-error-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/12-save-error-dark.png>) | 错误态、4 | 即时保存失败。保留原目录和 chip 标签，展示中文错误；修正鼠标悬停与程序焦点造成的双行背景。 |
| [13-narrow-keyboard-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/round2/13-narrow-keyboard-dark.png>) | 2、6、7、聚焦 | 390×740 窄窗口，真实 Tab / Enter 打开。两个 chip 同排收缩省略，浮层仅在右侧空间不足时向左限位，保持 12px 视口边距和键盘焦点环。 |

## 验证

- `npm run build:typescript`、`npm run build:renderer`、`node tools/ui-preview/build.mjs`：通过。
- 加载真实 Desktop CSS 的 `tests/e2e/renderer-thread-folders.spec.ts`：5 个用例通过，覆盖即时保存、主要目录、完整 title、浮层锚点、Home / End、Esc、远程输入补全、点击外部、最后目录保护、保存失败及加载 / 空 / 错误态。
- 聚焦 Vitest：`renderer-binding-probe.test.ts` 与 `renderer-binding-probe-host-catalog.test.ts`，2 个文件、79 个用例通过。
- `npm run lint`：通过，包含包边界检查。改动文件 Prettier 和 `git diff --check`：通过。
- `npm run typecheck`：仍为此前独立基线已确认的 11 个既存测试类型错误，分布在 external-inject-items、DingTalk、native-at-menu 和 accept2 测试；本轮修改文件无新增错误。

## 实机集成边界

本轮验证 UI 与交互，未把分支安装到运行中的 Desktop，也未执行真实模型轮次或远程沙箱探针。生产集成仍需按 [工作文件夹功能文档](../../docs/architecture/thread-folders.md) 验证真实 Host 的新对话 / 下一轮目录、文件浏览器根目录及委派归属。原生文件夹 picker 绑定、Desktop writable-roots / applied cwd 私有状态和跨机项目 assignment 的既有缺口见同一文档。

未 push、merge 或部署；未读取 `~/.codexhost/runtime/`。
