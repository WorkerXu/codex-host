# 侧栏分区合并视图

Desktop 的「分区」（项目 `···` → 分区）原生存成员关系，codexhost 不保存任何项目归属。本功能只改变分区内部的显示顺序与项目头可见性：分区、项目、对话行始终是原生节点。

## 显示规则

分区默认使用合并视图：隐藏项目头，把分区内所有项目的对话行放在同一列表里按最近活动排序，只保留分区自己的「新建聊天」按钮。分区头的操作区新增一个 24px 图标按钮（`aria-label="显示项目分组"`，`aria-pressed`），按下后恢复原生项目分组；选择按分区 ID 保存在 Renderer 的 `localStorage`（`codexhost.sidebarSectionDisplay.v1`，值为 `merged | grouped`），不写入 Desktop 状态。

不在任何分区里的项目完全不受影响。合并视图不添加机器标签、不改行标题、不新增第二个新聊天入口。

## 合并实现

- 分区容器：`div[data-sidebar-project-container-id="custom:<sectionId>"]`；内部 `section[data-app-action-sidebar-section]` 的项目列表是 `div[role="list"]`，直接子项为项目 listitem。
- 只读取结构：`[data-app-action-sidebar-project-row]`（项目头）、`[data-app-action-sidebar-project-list-id]`（行容器）、`[data-app-action-sidebar-thread-row]`（行）、`data-app-action-sidebar-thread-id` / `-host-id` / `-pinned`。
- 行保持原节点。把项目容器到行之间的包装层标记 `data-codexhost-merge-flatten`，样式设为 `display: contents`；项目头包装层与左侧导轨标记 `data-codexhost-merge-hidden`。行因此成为分区列表的 flex 子项。
- 每个行写入 `data-codexhost-merge-order="<n>"`，由生成的样式表给出 `order`。分区列表的 `gap` 固定为 1px；`display: contents` 元素的原生 `::before` / `::after`（项目分隔线）一并关闭，避免它们继续参与布局。
- 项目行内部为项目缩进预留了 16px 前导槽（加上行内 8px 间距共 24px）。没有项目标题时这层缩进只会留下空白，因此合并态把标题触发器前的空前导槽标为 `data-codexhost-merge-lead` 并隐藏，行图标与分区下原生行一致（实测 `sectionLeft + 16px`）；切回分组态后立即恢复。
- 项目分页（`data-app-action-sidebar-project-show-all="false"`）不再让整个分区回退。合并态只合并各项目**当前已挂载**的行；每个项目原生的 `展开显示` / `收起` 行标为 `data-codexhost-merge-hidden`，分区列表末尾放一个克隆自原生控件的合并控件（`data-codexhost-merge-more`，`order: 10000`）。有折叠项目时标签为「展开显示」，点击后依次触发这些项目的原生展开按钮；全部展开后标签为「收起」，点击依次触发各项目原生收起。混合状态优先展开剩余项目。`show-all` 为 false 但没有原生展开按钮时视为全部已挂载，不回退。
- 排序用 `electronBridge.getInitialSidebarBootstrap()` 的 `catalogEntries[].sourceRecencyAt`，键为 `hostId + threadId`；草稿行用行的 React `conversationId`。归并只比较每个项目的队首，因此单个项目内部的顺序永远保持原生；置顶行优先。没有目录时间的旧行排在同项目已知行之后；整个分区没有任何时间时直接保留项目块顺序。
- 结构或时间不可用时不做任何视觉改动，只记录状态并回退到原生布局。

## 入口边界

分区 `···` 菜单由 Desktop 的 React 组件用 `getItems()` 生成，Radix 的集合、焦点和 typeahead 都只包含它自己注册的项。往弹出菜单里插自有节点只能做到外观相似，键盘不可达，重渲染还可能被移除，因此入口改为分区头操作区的真实按钮。按钮插在原生「选项」「新建聊天」之后，沿用原生 24px 命中区、圆角、`--color-background-secondary-ghost-hover` 悬停和 `--color-ring` 焦点环。

## 失败回退

以下任一情况该分区保持原生布局，`data-codexhost-merged-state` 记录 `fallback:<reason>`，控制台只提示一次原因：

- 找不到唯一的分区 `section` 或项目列表；
- 列表直接子项不是项目容器，或项目缺少项目头；
- 项目处于折叠状态（行不在 DOM，合并后无法展开）；
- 项目列表缺少 `data-app-action-sidebar-project-show-all` 属性（无法判断分页状态）；
- 行缺少 thread / host ID，或同一分区出现重复行；
- 分区内存在不属于任何项目的对话行；
- 分区头没有可放置按钮的菜单触发器。

用户在合并状态下点击按钮但应用失败时，选择会回退为 `grouped`，不会留下半合并的侧栏。

## 验证

- 单元测试：`packages/renderer-extension/test/renderer-sidebar-sections-model.test.ts`、`renderer-sidebar-sections-layout.test.ts`。
- Playwright：`tests/e2e/renderer-sidebar-sections.spec.ts` 覆盖合并顺序、节点复用、真实鼠标 / 键盘切换、持久化、分页合并与单一展开 / 收起、折叠 / 缺少按钮的回退，以及时间缺失时的项目块顺序。
- 视觉预览：`tools/ui-preview` 的 `sidebar-sections` / `sidebar-sections-grouped` 场景使用只读 CDP 捕获的真实分区 DOM（`tools/ui-preview/fixtures/native-sidebar-section-remote.html`、`native-sidebar-project-local.html`）；截图与逐图结论见 [界面验收记录](../../tools/ui-preview/sidebar-sections-review.md)。

真实 Desktop 仍需人工确认：双项目分区的合并顺序、项目头隐藏后的悬停卡片 / 固定 / 归档 / 右键 / 拖拽、浅深色以及分区折叠后的恢复。
