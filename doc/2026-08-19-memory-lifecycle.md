# memory 生命周期：从仓库回到索引

日期：2026-08-19
状态：已确认，待实施（对应 knowledge-notes-panel 的 M5）

规格原本寄居在 [2026-08-19-knowledge-notes-panel.md](./2026-08-19-knowledge-notes-panel.md) 的「memory 自身的改进（排 M5）」一节。那节现在只留结论与回链，**实施细节以本文为唯一真相**。

## 需求

memory（`~/.kalo/memory/*.md` + `memory_save/search/list` 工具 + `/remember`）今天只有「增」这一个动作：

| 缺陷 | 现状 | 后果 |
| --- | --- | --- |
| 无生命周期 | 没有淘汰、归档、过期机制 | 半年前的项目状态照样每次注入 |
| 排序按新旧不按重要 | `loadAll()` 按 `updated` 倒序，索引满 2000 字符 `break`（`extensions/memory/index.ts:128`、`:303`） | 一条半年没动的核心偏好会被一堆新记的琐事挤出索引 |
| 没有类型 | 只有自由 `tags` | 无法按类别定策略：偏好该常驻，项目状态该过期 |
| 当仓库用 | 结论全文写在 memory 正文里 | 索引膨胀，每次 agent 启动都付这笔常驻税 |

memory 索引是**常驻税**：每次 agent 启动（含每次 cron 任务）1–1.5k token。这次要压的就是这个数，同时让 memory 回到它该干的事——**当索引，不当仓库**。

## 决策

1. **不引 schema、不引数据库。** 两个 frontmatter 字段 + 排序规则 + 一个归档目录，全部是纯文件层面的约定。
2. **系统字段带下划线前缀**（`_pinned`），沿用 knowledge 侧已有的约定（`_by` / `_reviewed`），与用户可见字段区分。
3. **pinned 不受预算挤出。** 先铺 pinned，再按权重填剩余预算——否则「强制驻留」名不副实。
4. **归档是移动文件，不是加字段。** `memory/archive/` 子目录不参与扫描：判断规则简单到不可能出错，用户在文件管理器里也看得懂。
5. **结论外链而不是抄全文。** memory 留一句摘要 + `[[卡片标题]]`，全文沉到知识卡片。省的是每次启动的真金白银，且结论从此有独立生命周期与反向链接。
6. **parse / serialize 必须成对改两侧。** `memory.rs` 的头部注释就写着与 TS 侧 "must stay in sync"，而历史上已经漂移过一次。

## 数据模型

### frontmatter

现有字段（两侧都有）：`title` / `tags` / `created` / `updated`。新增两个：

```markdown
---
title: "偏好：中文回答，代码注释用英文"
tags: ["preference"]
type: preference
_pinned: true
created: 2026-03-02T10:11:12.000Z
updated: 2026-03-02T10:11:12.000Z
---

回答用中文，代码与注释用英文。详见 [[Kalo 交互偏好]]。
```

| 字段 | 取值 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `type` | `preference` \| `project` \| `fact` \| `lesson` | `fact` | 类型自描述，直接驱动策略 |
| `_pinned` | `true` | 无（= false） | 强制驻留注入索引，不受字符预算挤出 |

`type` 的策略含义：`preference` 永久驻留；`project` 有时效，需定期复查、过期移入归档；`lesson` 到点沉降为知识卡片；`fact` 中性。**未知取值一律退化为 `fact`**，不报错——记忆是用户资产，手写一个错值不该让这条记忆消失。

`_pinned` 只认字面 `true`（去空白后小写比较）；其他一切值视为未置。序列化时**仅在为真时写出该行**，让不 pin 的记忆文件保持原样，避免给每个文件都加一行噪音。

### 排序

`loadAll()` 的比较顺序，取代现在单纯的 `updated` 倒序：

```
pinned (true 先) → type 权重 → updated 倒序
```

type 权重：`preference` 0 > `lesson` 1 > `fact` 2 > `project` 3。

理由：偏好是最该常驻的（它决定每一句回答的形态）；经验教训次之（可复用）；事实再次；项目状态最容易过期，也最容易靠 `recall` 现查，所以排最后、最先被预算挤掉。

### 目录

```
~/.kalo/memory/
  <slug>.md          扫描、注入、memory_list 可见
  archive/
    <slug>.md        不扫描、不注入、memory_list 默认不可见
```

`archive/` 是唯一的子目录约定。扫描现在是单层 `readdirSync` + `.md` 过滤，所以子目录**天然已被跳过**——不需要额外的排除逻辑，但需要在两侧的注释里写明这是有意的，否则下一次有人改成递归遍历时会静默破坏归档。

## 实现

### C1 harness：`extensions/memory/index.ts`

| 位置 | 改动 |
| --- | --- |
| `interface Memory`（:23） | 加 `type: MemoryType` / `pinned: boolean` |
| `serialize()`（:75） | 写 `type: <v>`；`pinned` 为真时写 `_pinned: true` |
| `parse()`（:80） | 读 `type`（未知值 → `fact`）、`_pinned`（仅 `true`） |
| `loadAll()`（:111） | 排序改为 pinned → 权重 → updated |
| `save()`（:132） | 入参加 `type?` / `pinned?`；覆盖时和 `created` 一样**保留旧值**（未传就沿用文件里的） |
| `before_agent_start`（:296） | 两趟：先无条件铺 pinned，再按序填到 `MAX_INDEX_CHARS`；`MAX_INDEX_ENTRIES` 同样先给 pinned |
| `memory_save` 参数 | 加 `type` / `pinned`，描述里写清各类型的语义 |
| `memory_list` 参数 | 加 `includeArchived`（默认 false） |
| `promptGuidelines` | 补两条（下节） |

pinned 溢出的边界：**pinned 自己就超出 2000 字符时不截断**，全部注入并按 `console.warn` 记一行。理由是用户显式 pin 的东西不该被系统悄悄丢掉；真出现这种情况，该修的是 pin 太多，不是让系统替他选。

`indexLine()` 给 pinned 条目加一个 `📌 ` 前缀，让模型看得出哪几条是用户钉住的。

### 提示层：两条 guideline

加到 `memory_save` 的 `promptGuidelines`：

1. **边界**：「世界与结论去知识库，用户与当下留 memory」——可复用、可验证、无时效的结论写成知识卡片；偏好、习惯、正在做什么、项目决定留 memory。
2. **外链**：结论不要抄进 memory 正文，用 `[[卡片标题]]` 链出去，memory 只留一句摘要。

⚠️ **边界必须成对生效**：这两条只是 memory 这一侧。`~/.kalo/knowledge/AGENTS.md` 模板（knowledge M3）落地时，要把对侧那句一起写上（「关于用户与当下的信息不归我，去 memory」），否则两边都塞、都不完整。

### C2 桌面：`memory.rs` + 两个组件

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/memory.rs` | `MemoryMeta` / `MemoryEntry` / `ParsedMemory` 加 `type` + `pinned`；`parse_memory`（:150）读、`serialize_memory`（:200）写；`list_memories`（:227）排序与 TS 侧同规则；`write_memory`（:281）加两个入参并保留旧值 |
| `MemoryEditModal.tsx` | 类型下拉（四选一）+ 「常驻上下文」勾选 |
| `MemorySettings.tsx` | 列表显示类型 chip、pinned 图标；归档筛选开关 |

排序规则在两侧各写一遍是重复，但**不值得为它造抽象**（一个进程是 Rust、一个是 TS，没有共享层）。代价靠一条测试兜住：两侧各喂同一组样本，断言顺序一致。

### C3 Scheduler `precondition`（约 30 行）

> 同一处改动也是 knowledge M3 的 §2b（[knowledge-notes-panel](./2026-08-19-knowledge-notes-panel.md) 「Scheduler 需要一处小改」）。**两条轨道谁先落地谁实现，另一条只是消费者**——不要各写一遍。下面是完整规格。

`gateway/src/scheduler.ts` 的 `runAgent()`（:403）到点无条件起 headless 会话。加可选字段：

```ts
precondition?: string;   // bash 片段；stdout 为空 ⇒ 跳过本次
```

- 复用现成的 `runWatch()` 执行器与 `WATCH_TIMEOUT_MS`（60 s 硬超时）——不写第二套子进程逻辑。
- stdout 非空 ⇒ 照常 `runAgent()`；空 ⇒ 不起 session、`finishRun(task, "ok")`、不发 alert。
- 脚本本身失败（无法启动 / 超时）⇒ 按 `error` 处理并 alert，**不**当作「条件成立」去烧 token。
- `sanitizeTask()`（:442）加 `precondition: typeof raw.precondition === "string" ? raw.precondition : undefined`。

有了它，「记忆归档」任务才能常开而不在无事发生的日子白烧 ~15k token。

### 第四个维护任务：「记忆归档」

任务模板本身是**提示层**，不写代码。复用同一套 cron + 上面的 `precondition`：

- `precondition`：`memory/` 下有 `type: project` 且 `updated` 早于 N 天的文件才输出——没有就整天不起 session。
- prompt：提炼可复用结论 → 写成知识卡片 → memory 原文换成一行 + `[[链接]]`；过期 project 状态 `git mv` 式移入 `memory/archive/`。

## 不做的

- **统一两处 `slugify`**（`memory.rs:64` 保留 CJK vs `knowledge.rs` ASCII-only）：M5 原列表第 6 条，独立小改，本轨道不夹带。
- **memory 检索改造**：`memory_search` 收敛为 `recall(scope:"memory")` 属 [recall 文档](./2026-08-18-recall-fts5.md) 的 R-d，且必须等 recall 跑过一阵——记忆是用户资产，退路要留着。
- **自动 pin**：不让模型推断该 pin 什么。`_pinned` 是用户的开关，模型可以建议，但要用户在设置页点。

## Token 成本

- 实现期一次性约 150k。
- 稳态：注入索引从 1–1.5k token 降到多少取决于外链化的程度，结构性上限不变（`MAX_INDEX_CHARS` 仍是 2000），但**同样的预算装的是重要的那几条**——这才是收益所在。
- `precondition` 把「记忆归档」任务的空跑成本砍到 0。

## 风险

- **两侧 parse/serialize 漂移**（历史上发生过一次）。缓解：同一个 commit 改两侧 + 双向读写测试（同一条记忆两边各改一次，都读得懂）。
- **pinned 用成了收藏夹**。用户 pin 十几条，索引全被占满。缓解：pinned 超预算时 warn；设置页显示 pinned 条数与占用字符。
- **归档变成黑洞**。移进去就再也找不到。缓解：`memory_list(includeArchived)` 保留入口；recall（R-a）落地后归档内容仍然可搜——这正是「归档」与「删除」的区别。

## 验证

- harness `npm run check`；`bun run build:engine` 后 exe 同步到 `src-tauri/binaries/`（[AGENTS.md](../AGENTS.md) 引擎定制点）。
- 造 3 条 memory（一条 `_pinned` + `type: preference`，一条 `type: project`，一条普通）：`memory_list` 顺序正确；把索引撑到超过 2000 字符，确认 pinned 那条**没被挤掉**。
- `memory/archive/` 下放一条：不进注入、不进 `memory_list`（除非 `includeArchived`）。
- 桌面设置页能读写 type/pinned，且与 harness 写出的文件互相读得懂（同一条记忆两边各改一次）。
- 手写一个非法 `type: 乱写`：退化为 `fact`，记忆不消失。
- `precondition` 返回空 → 定时任务跳过、不起 session（看 gateway 日志与 `lastResult`）；`precondition` 超时 → `error` + alert，且没起 session。
