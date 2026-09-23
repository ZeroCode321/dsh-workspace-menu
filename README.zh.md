# dsh-workspace-menu

把 DSH 侧栏的工作区（Project）与会话（Chat）行补齐：右键或双击，就能置顶、标记已读/未读、复制路径与链接、在系统的文件管理器中打开、在新窗口打开、归档、分叉，以及受围栏保护的删除。所有开关收在 DSH 的「设置 → 通用」里。

界面不是仿制的：菜单由 DSH 的 `Menu` 组件渲染，确认框用 `RiskConfirmation`，重命名用 `Modal`，提示用 `Toast`——和内置行菜单是同一套组件与设计 token。

> **合集**：本插件是 [**DSH Collection**](https://github.com/ZeroCode321/dsh-collection) 的第 01 号项目（插件开发类）。合集里有截图、工程复盘与另外两个项目：`dsh-chest`（插件/技能管理）和 `dsh-whale-diving`（鲸鱼动画）。

## 亮点

- **官方 UI 组件**：菜单卡片、图标、悬停填充、点击外部/Esc 关闭、视口内收边，全部复用 DSH 自带实现，不用自己写一套长得像的菜单。
- **偏好写入 Host**：开关与置顶顺序存在 Host 的设置命名空间 `workspace-menu` 里，同一 profile 在任何浏览器上表现一致；命名空间不可用时降级为浏览器本地缓存。
- **可逆的置顶**：置顶列表按用户点击顺序把项目排到最前；取消置顶会退回注册表原本的顺序，而不是把顺序永久钉住。被置顶的行在名称左侧显示一枚**蓝色鲸鱼动画**（品牌蓝 `--dsw-alias-state-business-primary`；跃出水面 → 喷水 → 下潜，3.6s 一轮，带水花与涟漪，不透明度最低 0.85），未读则是圆点，两者互不覆盖。
- **受围栏保护的删除**：删除工作区目录只对 Host 当前注册为工作区、`realpath` 后仍是自身、且位于已占用卷上的目录生效，并且拒绝删除用户主目录、`$DSH_HOME`、进程工作目录、盘符根。
- **不动内置源码**：通过 DOM 事件与 React fiber 定位行（DSH 没有行级扩展点），不修改 DSH 自带代码。
- **会话记录删除委托出去**：永久删除会话日志复用 `@mlgbnb/dsh-archive-manager`，本插件只负责移除工作区目录，不直接改写存档文件。

## 置顶曾经是坏的（已修，附复盘）

「置顶」画了标记却不换位，是**三个缺陷叠在一起**：排序模式闸门让整个重排逻辑在默认配置下从不执行；排序数学只在「只有一个置顶项」时成立；而**一行并不是另一行的兄弟节点**——DSH 给每行套了一层 keyed 单子节点 wrapper，移动行本身等于在它自己的盒子里挪动，DOM 顺序真变了、屏幕纹丝不动。

完整复盘（含三层各自的证据与三个定位脚本）：[docs/CASE-STUDY.md](docs/CASE-STUDY.md)。

## 功能

触发方式（各自可关）：双击行、右键行。

Project / 工作区行：

| 动作 | 默认 |
| --- | --- |
| 置顶 / 取消置顶 | 开 |
| 在文件管理器中打开 | 开 |
| 复制路径 | 开 |
| 从工作区列表移除（保留目录） | 开 |
| 删除工作区（含目录，需勾选确认） | 开 |
| 重命名（内置菜单已有） | 关 |
| 新建会话（内置菜单已有） | 关 |
| 新建会话（内置菜单已有） | 关 |

Chat / 会话行：

| 动作 | 默认 |
| --- | --- |
| 置顶 / 取消置顶 | 开 |
| 标记未读 / 已读 | 开 |
| 压缩上下文（/compact） | 开 |
| 复制会话链接 | 开 |
| 复制会话标题 | 开 |
| 在新窗口打开（同时复制链接） | 开 |
| 打开所在目录 | 开 |
| 删除会话（含日志，需勾选确认） | 开 |
| 重命名、分叉、归档（内置菜单已有） | 关 |

凡是 DSH 原生行菜单已经提供的动作，本插件默认关闭，避免同一件事出现两份入口。

## 安装

官方流程（tgz 或包名）：

```bash
dsh plugin --profile web add dsh-external-dsh-workspace-menu-1.3.0.tgz
```

本地开发（link 安装）：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-workspace-menu
```

> link 安装时 Host 半边需要解析 `@deepseek-ai/dsh-settings` 与 `@deepseek-ai/schemastery`；这两个包在 profile 的 `node_modules` 里，但 Node 的 ESM 解析不会从链接目录回溯上去，所以本地 link 场景需要在插件目录的 `node_modules/@deepseek-ai/` 下建立指向它们的链接（正常的 tarball 安装由 pnpm 处理，无需手工操作）。

开发与构建：

```bash
npm run typecheck   # tsc -p tsconfig.dev.json 与 tsconfig.test.json
npm run build       # Host: tsc -p tsconfig.build.json，Client: tsdown
npm test            # 单元测试：功能清单、置顶顺序、分组置顶、动作过滤、失败路径
npm run check       # 校验产物契约与 client bundle 的 require 表
```

单元测试覆盖纯逻辑（不需要浏览器；React 等平台模块由 `tests/stubs/` 里的桩模块顶替，经 `tests/platform-stubs.mjs` 的解析钩子重定向）：功能清单的唯一性与默认值、id 列表编解码的健壮性（含被手工编辑过的设置文档）、置顶/取消置顶的顺序数学、注册表顺序回放的收敛性、偏好存储的单实例语义与写入路由、动作按开关与能力过滤，以及删除与打开目录的失败路径不静默。DOM 与 React 层靠真实 GUI 验证。

`tsconfig.dev.json` 与本机已安装的 DSH 版本对齐（`paths` 指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`），因此不需要把未发布的 `@deepseek-ai/dsh-*` peer 包装进本仓库；`tsconfig.test.json` 在它之上放开数组下标检查，用来把测试也算进类型检查。

## 设置与持久化

**为什么不用 DSH 的设置命名空间当主通道。** 本插件确实在 Host 注册了设置命名空间 `workspace-menu`（注册是成功的），但 DSH 的 `settings.*` 协议只服务一份 **Host 侧白名单**里的命名空间，而不是所有已注册的。DSH 官方文档写得很直白（`packages/client/ui-settings-plugins/README.zh.md`）：

> 暴露是 Host 的白名单，而非插件的声明——不在 api-proxy 白名单中的命名空间，即便其拥有方已注册，也只会得到 `settings-not-exposed`，因此在本仓库之外分发的插件无法在不改动 `packages/host/apiproxy` 的前提下让自己的配置出现在这里。

也就是说：第三方插件**结构上**无法从浏览器读写自己的 settings 命名空间。所以本插件改用自己的一条受围栏保护的 Host 路由 `/dsh-workspace-menu/preferences`，把偏好原子写入 `$DSH_HOME/workspace-menu.json`：

```json
{
  "features": { "dblclick": true, "workspacePin": false },
  "pinnedWorkspaces": "ws-a\nws-b",
  "pinnedSessions": "",
  "unreadSessions": ""
}
```

客户端启动时按优先级挑传输通道：**插件自己的 Host 路由** → **settings 命名空间**（若某个部署把它加入了白名单，或未来 DSH 取消白名单，就自动优先用它）→ **仅浏览器本地缓存**（两者都不可用时，设置行会说明）。

功能开关和四张 id 表的字段含义：

| 字段 | 内容 |
| --- | --- |
| `features` | 每个功能键一个布尔值，默认值来自 `src/features.ts` |
| `pinnedWorkspaces` | 换行分隔的工作区 id，顺序即置顶顺序 |
| `pinnedSessions` | 换行分隔的会话 id |
| `unreadSessions` | 换行分隔的已标记未读会话 id |

Host 与客户端共用同一份功能清单（`src/features.ts`）：Host 用它生成 schema 默认值与文件校验，客户端用它生成设置行，因此两者不可能走偏。任何传输通道都不可用时，同样的结构会缓存在 `localStorage`，设置行会说明当前是哪种模式。

## 工作区目录删除的安全围栏

`POST /dsh-workspace-menu/delete-workspace-directory` 是唯一会写磁盘的删除路径，它的检查顺序是：

1. 请求必须通过 loopback / 受信主机 / Origin 围栏（与 DSH 自带 API 路由同一套规则）；
2. 路径必须是绝对路径，且不含 NUL；
3. 目标必须**就是** Host 工作区注册表里某个条目的路径（不在注册表里的目录一律拒绝）；
4. `realpath` 之后必须仍等于该注册路径——符号链接或 junction 不能把删除重定向到别处；
5. 目标不得位于用户主目录、`$DSH_HOME`、进程工作目录之内（含相等）；
6. 目标必须位于注册表已经占用的卷上，且父目录可验证（盘符根因此永远不会通过）。

会话日志的删除不在这里：它经 `POST /api/dsh-archive-manager/delete` 交给归档管理器，失败会明确报错并中止后续的目录删除，不会静默继续。

客户端在加载时会在同源上探测一次这条路由（用一个真实会话不可能拥有的 id，并带 `x-dsh-workspace-menu-probe` 标记头；结束点并不认识这个头也没关系，因为那个 id 不可能匹配到会话），只把 404 读作"未安装"。未安装时，「删除会话（含日志）」不会出现在菜单里，设置页会说明原因——而不是给出一个必然失败的动作。

## 与大版本 1.2 的差别

- 菜单与对话框改为 DSH 官方组件，不再自造 DOM 菜单；
- 偏好从 `localStorage` 迁移到 Host 设置命名空间（本地缓存仅作降级）；
- 取消置顶恢复原顺序；置顶与未读的状态条不再互相覆盖（改为两条独立的左侧导轨）；
- 删除目录加入注册表校验、`realpath` 校验、卷与父目录校验；
- 行标记从"每次 DOM 变动全量扫描 + 每行 fiber 遍历"改为按变更节点增量刷新，一帧合并一次；
- 补上中英文字典（`zh` 为准，`en` 按键联合类型检查完整性）；
- 深链轮询在页面不可见时不再空转；
- 能力探测：未安装归档管理器时，设置页会说明，「删除会话（含日志）」不再出现在菜单里；「删除工作区（含目录）」仍可用，但确认框会明确写出那几条无法清理的会话日志会成为孤立记录。

## 说明

- 「在文件管理器中打开」由 Host 调用系统文件管理器：Windows 用资源管理器（文件会被选中），macOS 用 Finder，Linux 依次尝试 `xdg-open` / `gio` / `nautilus` / `dolphin` / `thunar` / `pcmanfm`。
- 「在新窗口打开」与「复制会话链接」都用 `?session=<id>` 深链；前者会同时把链接放进剪贴板，因为再开一个窗看同一个会话，只有在你要把 URL 发出去时才有意义。
- **置顶要生效，侧栏必须处于「手动排序」。** DSH 侧栏的默认排序是「最近更新」，而在这个模式下 DSH 会主动把**有活动的会话提到最前**，并且它自己的会话拖拽排序在该模式下也被禁用（`WorkspaceBrowser.tsx`：`if (orderBy === 'updated' || ...) return`）。所以"置顶的顺序"不是被忽略，而是每次列表刷新都会被重算掉。本插件改不了这条策略，只能检测到并在你置顶时明确告知——标记本身仍然会写入并在刷新后保留，无法保持的只是**顺序**。
- 「压缩上下文」执行的是 **DSH 自带的 `/compact`**（`@deepseek-ai/dsh-command-compact`）：它把已发生的历史摘要成一个节点，让这个会话能继续工作。本插件只是把它放到行菜单上，并**按会话 id 直接提交**，因此你不需要先打开那个会话；Host 拒绝（忙碌、无可压缩内容、历史已变）会原样报出。
- 行识别依赖 DSH 放在 React fiber 上的 props。DSH 没有行为级的扩展点，这是唯一不重写整个侧栏的办法；一旦 DSH 改了行组件的结构，菜单会失效——`src/client/rows.ts` 是唯一需要跟着改的地方。这种失效原本是静默的，现在会在连续 3 行认不出来时弹一次提示说明原因。
