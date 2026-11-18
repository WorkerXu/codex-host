# 分区合并视图界面记录

2026-11-18。预览使用真实 Desktop CSS（`ui-reference/codex-desktop.css`，Desktop 26.1111.21308）和只读 CDP 捕获的分区 DOM，按 ui-quality-bar.md 逐张检查。截图位于仓库外 `/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/`，1280×960、2× 缩放，仅截取 306px 侧栏。

## 原生结构与主题来源

- `native-sidebar-section-remote.html`：运行中 Desktop 的「AI工作台」分区容器（远端项目，5 行）。`native-sidebar-project-local.html`：同一侧栏「项目」区里的本机「AI工作台」项目区块（3 行）。两者都由只读 CDP 导出后替换为确定性标题、假 thread / host ID、移除真实图片与机器名；保留真实包装层、`data-app-action-*` 属性和 Tailwind 类名。
- 预览在运行时把本机项目插入分区列表，补上分区内 `data-app-action-sidebar-project-show-all="true"`（捕获的本机项目仍带「项目」区的分页状态），并把缺图换成中性 Agent 图标。
- 浅色由 Desktop CSS 默认变量解析，深色通过 `data-theme="dark"` + `color-scheme` 使用真实 `--color-surface`（`#212121`）和文字变量；侧栏背景为 `--color-surface`，行悬停/选中、状态点、图标均来自原生类名。

## 合并视图（默认）

| 截图 | 逐图检查与修掉的问题 |
| --- | --- |
| [01-merged-light.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/01-merged-light.png) | 两个项目的 8 行按时间交错排列（远端 1 → 本机 1 → 远端 2 …），项目头与左侧导轨完全隐藏，预览行距统一（每行 29px + 1px 间隔，与原生列表同一套间距）。修复了被 `display: contents` 提升的分隔线伪元素造成的首行后 12px 空隙。 |
| [01-merged-dark.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/01-merged-dark.png) | 深色使用真实 `--color-surface`，文字、图标、未读环和选中行对比正常；行首无项目缩进，左侧没有多余空白或裁切。 |
| [02-hover-header-light.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/02-hover-header-light.png) | 分区头悬停出现原生「选项」「新建聊天」和新增的 24px 列表树按钮；三者同高、右对齐，未裁切。 |
| [02-hover-header-dark.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/02-hover-header-dark.png) | 深色未悬停状态：新图标使用三级文字色，与原生图标亮度一致，无多余背景。 |
| [03-hover-toggle-light.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/03-hover-toggle-light.png) | 新按钮悬停背景改用原生 `--color-background-secondary-ghost-hover`，24×24、6px 圆角，与相邻按钮的命中区和圆角一致；右侧留 8px 不触边。行首缩进已移除，图标与分区标题的左边距关系自然。 |
| [03-hover-toggle-dark.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/03-hover-toggle-dark.png) | 深色悬停背景可辨但不抢眼，图标不丢对比。 |

## 显示项目分组（原样恢复）

| 截图 | 逐图检查 |
| --- | --- |
| [04-grouped-light.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/04-grouped-light.png) | 两个项目头、图标、远端机器标签、状态点和原生行顺序全部恢复；分区头按钮保持按下态。没有残留 `order`、隐藏标记或压扁后的间距。 |
| [04-grouped-dark.png](/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-sidebar-sections/04-grouped-dark.png) | 深色项目头、状态点、按下态按钮均使用原生变量；项目之间恢复到原生间距。 |

## 交互与测量

- 真实鼠标点击切换：`aria-pressed` 由 `false → true → false`，`data-codexhost-merged-state` 对应 `merged → grouped → merged`。
- 真实键盘：聚焦按钮后 Enter 同样切回合并视图。
- 合并视图 8 行 top 差值全部为 30px（预览中行高 29px + 1px 间隔）；行图标 `left = 68px`，与真实 Desktop「最近」区原生行相同，分组态恢复 `92px`。视觉顺序为 远端 1、本机 1、远端 2、本机 2、远端 3、本机 3、远端 4、远端 5，对应 catalog 时间交错。
- 新按钮尺寸 24×24，`aria-label="显示项目分组"`，导入的样式表只包含本功能标记选择器。

## 未覆盖

真实 Desktop 上的双项目分区需要用户把本机项目加入同一分区后复核；预览验证的是同一套 DOM 结构、CSS 和控制器。
