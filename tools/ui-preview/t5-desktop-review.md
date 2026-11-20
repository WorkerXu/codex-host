# Desktop 分区、项目镜像和派发预览

`capture-t5-desktop.mjs` 用导出的 Desktop 样式和两个主题的真实变量渲染本地夹具。分区使用脱敏后的原生侧栏节点，菜单使用生产组件和示例 Host 目录。Chromium 用实际鼠标和键盘触发悬停、聚焦。

```sh
node tools/ui-preview/capture-t5-desktop.mjs /path/to/codex-desktop.css build/t5-desktop
```

| 界面 | 浅色 | 深色 | 悬停 | 焦点 |
| --- | --- | --- | --- | --- |
| 分区 | `sections-light.png` | `sections-dark.png` | `sections-hover.png` | `sections-focus.png` |
| 项目镜像 | `mirror-light.png` | `mirror-dark.png` | `mirror-hover.png` | `mirror-focus.png` |
| `#` 派发 | `dispatch-light.png` | `dispatch-dark.png` | `dispatch-hover.png` | `dispatch-focus.png` |

分区标题行的操作在标题悬停或键盘焦点进入后出现。切换按钮沿用原生新对话按钮旁的间距，合并列表只显示一个「展开显示」。项目镜像弹层使用 Desktop 的浮层表面色与边框，深色下能与页面背景区分。离线机器以次级文字显示；悬停和键盘焦点沿用 Desktop 色值。派发菜单的机器标题省去重复的来源标签；两种连接错误各占一行。方向键与悬停定位到同一 Harness 行。

截图检验浮层始终在视口内。项目创建、文件夹信任和会话预选需在实际 Desktop 中验收。
