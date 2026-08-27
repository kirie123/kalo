# Kalo 文件搜索工具设计（grep / glob）

> 状态：已实现。
> 层次：harness 层（`kalo-harness/packages/agent`）新增 `grep`/`glob` 工厂与共享搜索核心；引擎侧（`kalo-harness/packages/coding-agent`）接线，重建 pi.exe 后 kalo 桌面端直接可用。

## 1. 需求与约束

- 模型在探索代码库时需要两个高频只读操作：**按内容搜索**（grep）与**按路径模式发现文件**（glob）。当前 harness 工具层（`pi-agent-core`）只有 `read`/`bash`/`edit`/`write`，缺少搜索类工具。
- 引擎（pi.exe，来自 coding-agent 包）虽有 `grep`/`find`，但执行依赖外部二进制：优先找系统 PATH 里的 `rg`/`fd`，找不到则运行时从 GitHub 下载。在 kalo 桌面场景（打包单文件、离线或网络受限、Windows 常无 rg）不可靠，搜索工具会直接报错。
- Kalo 的主力模型是本地中小模型，工具参数面必须极简：少参数、输出格式稳定、超限行为可预期。
- harness 层的执行环境 `ExecutionEnv = FileSystem & Shell` 是抽象接口（本地 Node 仅是默认实现），工具不能绕过它直接触碰 `node:fs` 或 `child_process`。

## 2. 方案选型

| | 外部二进制方案（spawn rg） | **纯 TS 方案（选定）** |
|---|---|---|
| 依赖 | 系统安装或运行时下载 rg | 零外部二进制；仅复用已有 npm 依赖 `ignore`（.gitignore 语义） |
| 离线/受限环境 | 不可靠 | 完全可用 |
| 环境抽象 | 只能跑在本地进程（argv spawn），违背 ExecutionEnv 抽象 | 只依赖 `FileSystem` 原语（listDir/readTextFile），任意后端可用（远程/沙箱） |
| 性能 | 大仓库（10w+ 文件）快 | 个人项目规模（数千~数万文件）足够；有遍历上限与早停护栏 |
| 打包 | bun compile 产物需携带平台二进制 | 无需任何附带资源 |

**决策**：在 `pi-agent-core`（packages/agent）实现纯 TS 的共享搜索核心与 `createGrepTool`/`createGlobTool` 工厂；coding-agent 的 `grep` 换用同一核心（去掉 rg 依赖），并新增 `glob` 工具。`find` 暂保留不动（fd 路径），后续可裁剪。

## 3. 共享搜索核心（`harness/tools/file-search.ts`）

grep 与 glob 共享同一套遍历/过滤基础设施，单独成模块并从包主入口导出，供引擎侧复用。

### 3.1 文件系统原语

核心不直接依赖 `ExecutionEnv`，只依赖最小原语集合（`ExecutionEnv` 天然满足）：

```ts
interface SearchFs {
    listDir(path: string, signal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
    readTextFile(path: string, signal?: AbortSignal): Promise<Result<string, FileError>>;
}
```

- `ExecutionEnv` 可直接传入；coding-agent 侧用本地 `fs` 薄封装（或 `NodeExecutionEnv`）。

### 3.2 glob → RegExp 编译

自研 `globToRegExp(pattern, { matchBasename })`，不引入新依赖。语义：

- `**` 匹配任意层级（含零层，跨 `/`）；`*` 匹配单段内任意字符（不含 `/`）；`?` 匹配单个非 `/` 字符；`{a,b}` 交替；`[...]` 字符类按字面透传；其余字符按字面转义。
- **模式不含 `/` 时按 basename 匹配**（任意深度）：`*.ts` 等价于 `**/*.ts`，符合直觉并减少模型写错模式的概率；含 `/` 时相对搜索根匹配完整路径。
- 匹配统一在 posix 风格相对路径上进行（Windows 分隔符先归一化为 `/`），输出路径也统一 posix 风格。

### 3.3 遍历与忽略规则（`walkFiles`）

```ts
async function* walkFiles(fs: SearchFs, root: string, options): AsyncIterable<WalkEntry>
// WalkEntry = { path: string /* 相对 root, posix */; absolutePath: string; size: number; mtimeMs: number }
```

- **目录序 DFS**，逐目录 `listDir`；对每个遇到的目录按序应用三层过滤：
  1. **内置排除**（不可关闭）：`.git`、`.hg`、`.svn`、`node_modules`、`dist`、`build`、`out`、`target`、`.next`、`.cache`、`__pycache__`、`.venv`——防止误入依赖目录导致遍历爆炸；
  2. **`.gitignore`**：从 root 向下逐层读取并叠加（用已有依赖 `ignore`，支持 negation 与嵌套 .gitignore）；读取失败的目录按无忽略规则处理；
  3. **隐藏项**：默认跳过 `.` 开头的文件与目录（`.gitignore` 例外，它本身要被读到）。
- **遍历上限**：单次调用最多访问 `MAX_WALK_ENTRIES = 20000` 个目录项，超限即停并在结果中标记 `truncated`（对模型提示收窄 path），不做静默截断。
- **abort 传播**：`signal` 贯穿 `listDir`/`readTextFile` 与循环检查点。
- symlink 不跟随（`FileInfo.kind === "symlink"` 直接跳过），避免环。

### 3.4 grep 核心执行（`grepFiles`）

```ts
async function grepFiles(fs: SearchFs, options: {
    pattern: RegExp;
    root: string;            // 文件或目录
    glob?: string;           // 文件名过滤（单一正向 glob）
    maxFileBytes?: number;   // 单文件大小护栏，默认 1.5MB，超限跳过
    signal?: AbortSignal;
}): Promise<{ files: Array<{ path: string; absolutePath: string;
                             matches: Array<{ lineNumber: number; line: string }> }>;
              matchCount: number; filesSearched: number; filesSkipped: number;
              walkTruncated: boolean }>
```

- root 为文件时直接单文件匹配（不做忽略规则，尊重显式路径）；为目录时 `walkFiles` + glob 过滤后逐文件匹配。
- **二进制跳过**：读取文本后检测前 8KB 是否含 NUL（`\u0000`），命中则跳过该文件。
- 匹配按文件分组、文件内按行号升序；总匹配数由调用方截断（核心不做 limit，便于调用方决定“先到先得”还是统计语义）。
- 逐行匹配用单个预编译 `RegExp`（非 `g` 标志，逐行 `test`），不逐 match new RegExp。

## 4. harness 层工具契约（模型可见）

### 4.1 grep

```
grep(pattern: string, path?: string, glob?: string, ignoreCase?: boolean, limit?: number)
```

- `pattern`：正则表达式（JS RegExp 语法，与 ripgrep 常用子集兼容），必填非空。
- `path`：文件或目录，相对路径基于会话 cwd；缺省为 cwd。
- `glob`：单一正向 glob 过滤（如 `*.ts`、`*.{js,jsx}`）；否定（`!…`）与逗号列表报参数错误。
- `ignoreCase`：忽略大小写，默认 false。
- `limit`：返回匹配上限，默认 200；达到上限即停止搜索（早停）并提示 `limit=N` 加倍或收窄。
- **不做上下文行参数**：匹配行自带行号，需要上下文时用 `read` 工具按 `offset` 读取（参数面极简原则）。

输出格式（按文件分组，路径只出现一次，省 token）：

```
Found 3 matches

src/utils/paths.ts
Line 12: export function joinPaths(parts: string[]) {
Line 40: 	return parts.join("/");

docs/example.md
Line 3: uses joinPaths everywhere
```

- 无匹配：`No matches found (searched 42 files)`。
- 截断三层，命中任意一层都在尾部给出可操作提示：
  1. 匹配数达到 `limit` → `[N matches limit reached. Use limit=2N for more, or refine pattern/path]`；
  2. 单行超 500 字符 → 复用 `truncateLine`，`[Some lines truncated to 500 chars. Use read for full lines]`；
  3. 总输出超 50KB → 复用 `truncateHead`，提示含已显示区间。
- `details`（非模型可见）：`{ matchLimitReached?, linesTruncated?, truncation?, filesSearched, walkTruncated }`。

### 4.2 glob

```
glob(pattern: string, path?: string, limit?: number)
```

- `pattern`：glob 模式；**不含 `/` 时匹配任意深度的 basename**（`*.ts` 全树搜索），含 `/` 时相对搜索根。
- `path`：搜索目录，缺省 cwd。
- `limit`：返回路径上限，默认 100。

输出：每行一个 posix 相对路径，**按修改时间降序**（最近改动的文件排前面，对“我在改什么”类探索最有用）：

```
src/api/handler.ts
src/utils/paths.ts
test/paths.test.ts

(Showing 3 of 47 matching files, newest first. Use a narrower pattern or path to reduce results.)
```

- 无匹配：`No files found matching pattern '*.xyz'`。
- 结果只含文件（不含目录）；尊重 3.3 的忽略规则。
- `details`：`{ resultLimitReached?, walkTruncated }`。

### 4.3 注册与导出

- `createGrepTool()` / `createGlobTool()` 与现有 `createReadTool()` 等同形态的 `AgentHarnessTool` 工厂，从 `harness/tools/index.ts` 与包主入口导出；不改变默认工具集组装（由 embedding 方决定启用）。

## 5. 引擎接线（coding-agent → kalo 桌面端）

1. **grep 重写**：`core/tools/grep.ts` 保留对模型可见的参数面与 TUI 渲染（`renderCall`/`renderResult`），`execute` 内部从 spawn rg 换为调用 `grepFiles` 核心；保留 `context` 参数（上下文行由引擎侧用文件内容自行展开，组内格式 `Line N- text`，匹配行为 `Line N: text`）。输出格式统一为 4.1 的分组式（原 `path:line: text` 行式废弃，现有测试断言同步更新）。
2. **GrepOperations 升级**（可插拔远程执行）：`{ isDirectory, readFile }` → `{ isDirectory, readFile, listDir }`，默认实现走本地 fs。属 breaking 变更，记录 CHANGELOG 并同步 gondolin 示例。
3. **glob 新增**：`core/tools/glob.ts` 提供 `createGlobToolDefinition`/`createGlobTool`（ToolDefinition 形态，含 TUI 渲染），内部走共享核心；`ToolName`、`allToolNames`、`createToolDefinition`、`createAllToolDefinitions`、`createReadOnlyToolDefinitions` 等注册点全部加入 `glob`，并从包入口导出。
4. **subagent 默认工具集**：`DEFAULT_TOOLS = ["read", "grep", "glob", "ls"]`（`find` 移出默认集，减少与 glob 的重叠；显式传参仍可用）。
5. **find 暂不动**：保留 fd 路径与既有测试，待 glob 验证稳定后在后续版本裁剪。

重建引擎（`scripts/build-engine.sh`）后，kalo 桌面端默认工具集为 `read/bash/edit/write/grep/glob/find/ls`，grep/glob 不再依赖网络与外部二进制。

## 6. 边界与安全

- **无 shell 注入面**：全程无子进程、无命令行拼接；flag-like 的 pattern（如 `--pre=…`）只是普通文本/正则。
- **正则灾难回溯**：模型可能构造病态正则。JS RegExp 单行匹配的回溯代价受行长度约束（超 500 字符的行本就会被截断显示；匹配仍作用于原始行，但行本身有 1.5MB 文件护栏）。第一版不做正则超时，观察实际使用再评估。
- **遍历爆炸防护**：内置目录排除 + 20000 目录项上限 + symlink 不跟随。
- **读取护栏**：单文件 > 1.5MB 跳过内容匹配（glob 不受影响，glob 不读文件内容）；二进制文件（NUL 检测）跳过。
- **abort**：用户中止会话时，signal 传播到遍历循环与所有 fs 调用。

## 7. 测试计划

- **pi-agent-core（vitest, harness 配置）**：
  - glob→RegExp：`**`、`*`、`?`、`{a,b}`、无 `/` 的 basename 语义、Windows 分隔符归一化；
  - walkFiles：.gitignore（含嵌套与 negation）、内置排除、隐藏项跳过、上限早停、symlink 跳过；
  - grepFiles：单文件/目录、glob 过滤、二进制跳过、大文件跳过、abort；
  - createGrepTool/createGlobTool：输出格式（分组/排序/无匹配）、limit/字节/行三层截断提示、错误参数（空 pattern、否定 glob）。
- **coding-agent（vitest）**：既有 grep 用例适配新输出格式并补 glob 用例；`--pre=` 注入用例在无子进程实现下天然通过。
- **端到端冒烟**：重建引擎后，在 kalo 会话里让模型 `grep` 一个本地关键词、`glob` 一类文件，确认离线可用与输出渲染。

## 8. 变更记录

- `packages/agent`：新增 `harness/tools/file-search.ts`、`grep.ts`、`glob.ts`；`tools/index.ts` 导出；CHANGELOG `Added`。
- `packages/coding-agent`：`grep.ts` 重写（去 rg 依赖，输出改分组式）；新增 `glob.ts` 与注册点；`GrepOperations` 加 `listDir`（breaking）；subagent 默认工具集更新；CHANGELOG `Added`/`Changed`/`Breaking Changes`。
