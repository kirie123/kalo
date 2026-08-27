# 文件面板 git 感知：只读状态 + diff 查看

日期：2026-08-19
状态：已确认，实施中

## 需求

文件面板（`src/components/FilePanel.tsx`）现在只是个目录浏览器：目录树 + 文本预览 + 右键菜单。日常编码里最缺的一步是「**改完看整体 diff**」——现在只能让 agent 跑 `bash git diff`，或者切到别的工具去看。

盘点结论里编码线的三个缺口之一就是这条：能力面已经追平主流客户端，但**没有 git 感知**，改动是否已提交、哪些文件动了、动了多少，面板上一点也看不出来。

## 决策

1. **只读感知，不做写操作。** 不做 stage / unstage / discard / commit / 分支切换。理由有两条：
   - 写仓库的路径已经有了——agent 在会话里跑 `git`，用户在终端里跑 `git`。面板再开一个写入口，等于三方抢同一个 index.lock 和同一份工作区状态，还得处理"面板显示的暂存区是 3 秒前的"这类问题。
   - 这次要解决的是「看不见」，不是「不好操作」。
2. **调用 `git` 命令行，不引 libgit2。** 零新依赖、构建时间不变，而且行为与用户/agent 在终端里看到的**完全一致**（`.gitignore`、submodule、稀疏检出、`core.quotepath`、各种 `include` 配置都由 git 自己解释）。代价是机器上必须有 git——对一个 coding agent 客户端来说这不是代价。
3. **不装文件系统监听。** 刷新时机只有三个：root 变化、手动刷新、**一轮对话结束**。轮次结束这一下正好覆盖"agent 刚改完一批文件"，成本为 0，也不会在大仓库里被 watcher 拖住。
4. **不是仓库是正常状态，不是错误。** 非 git 目录下整个 git 区不渲染，不报错、不弹 toast。

## 数据模型

一次 `git_status(cwd)` 返回全量快照（前端不做增量）：

```ts
interface GitStatus {
  repoRoot: string;        // 绝对路径，原生分隔符
  branch: string;          // 分支名；detached 时是短 oid
  detached: boolean;
  upstream?: string;       // "origin/main"
  ahead: number;
  behind: number;
  initial: boolean;        // 空仓库（还没有 HEAD）
  entries: GitEntry[];
  truncated: boolean;      // 条目超过 5000，列表是前缀
}

interface GitEntry {
  relPath: string;         // 相对 repoRoot，posix 分隔符（git 原样给出）
  path: string;            // 拼好的绝对路径，原生分隔符
  index: string;           // 暂存区状态字母，"." 表示无
  worktree: string;        // 工作区状态字母，"." 表示无
  untracked: boolean;      // `? ` 记录
  isDir: boolean;          // 未跟踪目录（-unormal 折叠出来的 "dir/"）
  conflicted: boolean;     // `u ` 记录
  submodule: boolean;      // porcelain 的 sub 字段以 S 开头
  renamedFrom?: string;    // `2 ` 记录的原路径
  added?: number;          // numstat
  removed?: number;
  binary: boolean;         // numstat 给出 "-\t-"
}
```

## 实现

### Rust：`src-tauri/src/git.rs`（新建）

三条命令，全部 `--no-optional-locks`（与 agent 并发跑 git 时不去争 `index.lock`），全部走 `proc::no_window`：

| 调用 | 用途 |
| --- | --- |
| `rev-parse --show-toplevel` | 是不是仓库 + 仓库根。非零退出 ⇒ `Ok(None)` |
| `status --porcelain=v2 --branch -z -unormal` | 分支 / upstream / ahead-behind / 条目 |
| `diff --numstat -z HEAD`（空仓库降级为不带 `HEAD`） | 每文件 `+N -M` |

两个细节是这块最容易写错的地方：

- **`-z` 必须加**。默认输出会按 `core.quotepath` 把非 ASCII 路径转义成 `"\346\226\207"`，中文文件名直接烂掉。`-z` 下路径原样输出、以 NUL 分隔，无引号无转义。
- **`2 ` 重命名记录在 `-z` 下有两个路径字段**：`2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>\0`。原路径是**独立的 NUL 字段**，不是空格分隔的第 10 列。

`-unormal`（git 默认）而不是 `-uall`：整个未跟踪的目录折叠成一条 `? dir/`，大目录不会撑爆列表；前端按前缀让它的子项继承未跟踪状态。

`git_diff(cwd, rel_path)` 用 `diff HEAD -- <path>`：一次覆盖已暂存 + 未暂存，正是"改完看整体"要的视图。输出上限 512 KB。未跟踪文件没有 diff，前端退回源码预览。

条目上限 5000，超出置 `truncated`。

`CREATE_NO_WINDOW` 这个 flag 之前在 `proc.rs` / `session.rs` / `gateway.rs` 各写了一遍，本次抽成 `proc::no_window(&mut Command)`，三处改过来，不写第四遍。

### 前端：`src/lib/git.ts`（新建，纯函数，可单测）

- `buildStatusIndex(status)`：绝对路径 → 条目。键用与 `chat-store.ts` 同款的归一（`\`→`/` + 小写），Windows 下大小写才不会漏。
- 目录汇总：目录下有任何变更 ⇒ 目录挂一个小圆点（前缀匹配）；未跟踪目录的子项继承 `?`。
- `parseUnifiedDiff(text): DiffLine[]`：解析 `@@ -a,b +c,d @@`，hunk 之间产出一行 `kind: "skip"`。**复用 `DiffView.tsx` 的 `DiffLine` 与渲染器**，只给 `DiffView` 加一个可选 `lines` 入参——不写第二套 diff 渲染。

### 前端：`FilePanel.tsx`

- 头部：分支 chip `main ↑2 ↓1` + 变更计数（`● n`）。detached / 空仓库各有文案，非仓库整块不渲染。
- 行尾：状态字母（`M` `A` `D` `R` `?` `U`）+ `+42 -3`，配色用现成的 `--diff-add-text` / `--diff-del-text` CSS 变量。
- **「仅变更」开关**：切到一条按目录分组的平铺列表，而不是过滤懒加载的树——git 已经给了全部路径，不需要逐层展开，交互也更贴近"变更清单"。
- 预览列 `[源码 | diff]` 切换。
- 右键菜单加「查看 diff」。

## 边界

- **非 git 目录**：`Ok(None)`，UI 无 git 区，无报错。
- **空仓库**（还没有 commit）：`branch.oid` 是 `(initial)`；numstat 降级为 `diff --numstat -z`（无 `HEAD`）。
- **detached HEAD**：`branch.head` 是 `(detached)`，显示短 oid。
- **git 不在 PATH**：`git_status` 返回 `Ok(None)`（与"不是仓库"同样静默）——把"没装 git"渲染成一片报错不值得。
- **子模块**：`sub` 字段 `S...` 标出来，不给它算 numstat。
- **`.gitignore` 与隐藏文件**：`list_dir` 本来就跳过 `.` 前缀与 `node_modules / target / dist / __pycache__`，所以被忽略的文件基本不会出现在树上；**不请求 `--ignored`**。
- **状态漂移**：agent 或用户在别处跑了 git，面板不会立刻知道。轮次结束刷新 + 手动刷新按钮兜住，不做 watcher。
- **大仓库**：条目上限 5000 + `truncated` 标记；`git status` 本身是增量的，个人项目量级毫秒级。

## 验证

- `cargo test`（git 模块）：porcelain v2 各记录形态（含 `-z` 重命名双路径、CJK 路径、`? dir/`、`u ` 冲突、submodule）、`branch.ab` 解析、numstat 二进制 `-\t-`。解析函数吃固定样本，**不在测试里起真 git 进程**。
- vitest（`src/lib/git.test.ts`）：`parseUnifiedDiff` 行号推进、目录汇总、未跟踪目录继承、Windows 路径大小写。
- 手测：改文件 → `M` + 行数；新建 → `?`；`git mv` → `R`；`[diff]` 与终端 `git diff HEAD -- <file>` 逐行对齐；非 git 目录无报错；agent 跑完一轮自动刷新；CJK 文件名 / 含空格路径 / 子模块各验一次；「仅变更」条目数与 `git status --short` 一致。

## 不做（留给以后，或永不做）

- stage / discard / commit / 分支切换（见「决策 1」）。
- blame、行内 gutter、历史浏览、图形化 log。
- 文件系统监听。
