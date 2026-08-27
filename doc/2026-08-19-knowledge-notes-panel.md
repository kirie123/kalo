# 知识笔记：把知识库从「设置里的一个 tab」升级成 Kalo 自主经营的笔记库

日期：2026-08-19
状态：M1 已实施（2026-08-19），M2 起待办

## 需求

侧边栏在「自动化」下面加一项「知识笔记」，占据主面板（和「演化」同级），让 Kalo 自主沉淀、整理、复盘个人知识库。

## 现状与问题

知识库这条线现在的实现散在四处：

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `src-tauri/src/knowledge.rs` | list/read/write/delete + frontmatter 行解析 | 四个域 `DOMAINS = [cards, training-notes, investing, math]` **写死在代码里** |
| `components/KnowledgeSettings.tsx` | 设置页 tab，卡片列表 + 域分组 | 客户端过滤，**搜不了正文**；埋在设置里，不是日常工作面 |
| `internal-skills/knowledge/SKILL.md` | save / search / recall 三段提示 | 检索是手写 `rg`；**`INDEX.md` 要模型手工维护** |
| `~/.kalo/knowledge/` | cards/ + 三个域目录 + INDEX.md | 只有「卡片」这一种形态，笔记之间没有关系 |

对照 roadmap（`doc/2026-08-17-personal-agent-roadmap.md`）自己立的两条原则，现在有两处是违背的：

- §5 结尾：*「`knowledge.rs` 里写死的四个域属于编译进代码的领域特例，应改为用户可配置列表」*
- §7 第一条：*「文件即状态，但状态由工具写，不由模型手写」* —— `INDEX.md` 恰恰是模型手写的，每次存卡都可能漏、可能写错路径。

所以这次不是「加个页面」，是把这条线补齐到底座该有的样子。

## 借鉴的结构决策（取舍）

**采用（四条，都是结构性决策）**

1. **类型/域本身就是一篇笔记**。`type/project.md` 是一个 `type: Type` 的普通 md，靠 `_icon` / `_color` / `_order` / `_sidebar_label` 描述自己（下划线系统字段约定）。代码里因此**没有任何硬编码类型表**。这正是我们要的「域可配置」的答案 —— 不做设置项，做成一篇笔记。
2. **`[[wikilink]]` + 反向链接**。关系字段是**动态识别**的：任何 frontmatter 值里含 `[[...]]` 就算关系，不维护字段名白名单。这一条决定了库是「知识网络」还是「卡片堆」，也给了 agent 一个极便宜的编织手段：写卡时顺手 `[[PrefixLM]]`。
3. **vault 根目录的 `AGENTS.md`**：读 vault 里的 AGENTS.md 一起给 agent；managed / missing / broken / custom 四态，可一键恢复。组织约定住在数据旁边、用户可改、write-if-missing —— 这和 roadmap §5「提示层」是同一件事，直接落地。
4. **inbox 先捕获、事后归类**。快速写入不需要当场决定放哪，归类是后台任务的活。

**不采用**

- git per-vault、同步、冲突解决、远端、AutoGit —— 我们的库在 `~/.kalo` 下，用户想版本化自己 `git init`，不做 UI。
- BlockNote 富文本 + markdown 双向序列化。这是同类产品最重的一块（富文本序列化器缓存、渐进挂载），代价和本次改动完全不成比例。我们用 markdown 源码 + 预览，而且这样和 agent 写文件天然同构。
- 多 vault 挂载 / workspace、trash 管理、主题系统、saved views、独立 MCP server（kalo 走扩展与技能）。
- 派生 SQLite 缓存。个人量级（现在 1.6 MB 级）Rust 直接扫目录就够；检索入口留成一个函数，等 P1-R 的 `recall`（FTS5 + trigram，见 `doc/2026-08-18-recall-fts5.md`）落地后换实现，页面不动。

## 决策

1. **存储沿用 `~/.kalo/knowledge/`**，UI 名称叫「知识笔记」。零迁移：现有卡片、skill 里的 rg 路径、`knowledge.rs` 的命令全部继续有效。设置页的「知识库」tab **删除**，逻辑迁进新页面 —— 不留两套 UI。
2. **编辑器**：markdown 源码 + 实时预览（react-markdown + remark-gfm/math + rehype-katex 依赖已在，`AssistantMessage.tsx` 同一套渲染）。
3. **自主性边界**：agent 直接写盘，但写入时打 `_by: kalo` / `_reviewed: false`，页面有「待审阅」筛选，人逐条通过/改/删。信任机制用 frontmatter 约定实现，零额外基础设施。
4. **第一版就做链接图谱**：链接、反向链接、孤立笔记由 **Rust 侧从文件派生**，`INDEX.md` 变成生成物，模型不再手写。
5. **覆盖与删除前进 `.trash/`**（M1 就要有）。AI 在无人看管时改笔记，必须有兜底；但不做 git、不做 diff 视图。
6. **memory 保留，与 knowledge 划清边界**：memory 管「用户与当下」且常驻上下文，knowledge 管「世界与结论」且按需检索。边界写进两边的提示层，memory 自身的升级单独排 M5。

## 数据模型

frontmatter 全部字段可选，现有卡片（title/domain/tags/date/source_session）解析结果不变：

```yaml
---
title: PrefixLM 在 HRM 上更优      # 无则回退到 H1，再回退到文件名
domain: training-notes             # = 所在顶层目录，冲突时目录赢
tags: [hrm, prefixlm]
date: 2026-08-15                   # 创建
updated: 2026-08-19                # 最后一次实质修改（工具写）
status: seed | active | stable | stale   # 生命周期，列表里彩色 chip
related: ["[[PrefixLM]]", "[[HRM 架构]]"]  # 显式关系；正文里的 [[]] 同样计入
source_session: a3f9c2
_by: kalo                          # 谁写的（缺省=人）
_reviewed: false                   # 待审阅
---
```

**下划线 = 系统字段**（通用约定）：`_` 开头的字段不进属性面板、不进筛选器，只在源码模式可见。今后所有系统级 frontmatter 都遵守这条。

### 目录

```
~/.kalo/knowledge/
  AGENTS.md                  # 组织约定，write-if-missing，Kalo 动笔前必读
  _types/                    # 域的自描述笔记（可选，缺失则用目录名）
    training-notes.md        #   frontmatter: _label/_icon/_color/_order
  inbox/                     # 快速捕获，待归类
  cards/ training-notes/ investing/ math/    # 现有域=文件夹，代码里不再出现
  review/                    # 周报/月报等派生笔记
  attachments/
  .trash/                    # 覆盖/删除前的快照兜底，不参与任何扫描
  INDEX.md                   # 生成物（工具写）
```

域 = 扫描出来的顶层目录，标签/图标/排序来自可选的 `_types/<域>.md`。`DOMAINS` 常量从 `knowledge.rs` 删除；`_types/` 缺失时一切照常工作（回退目录名），这是导航辅助不是 schema。

## 实现

### Rust：`knowledge.rs` 扩写（不新建模块，命令名沿用前缀）

| 命令 | 作用 |
| --- | --- |
| `list_knowledge_cards`（现有，扩字段） | 追加 `status/updated/by/reviewed/wordCount/snippet`；`linkCount/backlinkCount` 需要全图，推到 M2 |
| `list_knowledge_domains`（新） | 扫顶层目录 + 读 `_types/*.md`，返回 `{key,label,icon,color,order,count}` |
| `search_knowledge(query, limit)`（新） | 正文全文。≥3 字走子串匹配，1–2 字同样走子串（中文短查询天然可用，不吃 unicode61 的坑）。返回 `{relPath,title,line,snippet}`。**UI 侧唯一检索入口，将来整体换成 `recall`** |
| `knowledge_graph()`（新） | 一次全库扫描 → `{links: Record<rel, rel[]>, backlinks, orphans, brokenLinks}` |
| `rebuild_knowledge_index()`（新） | 由上面的图生成 `INDEX.md`（按域分节，`- [标题](路径) — tags（日期）`） |
| `read/write/delete_knowledge_card`（现有） | `write` 增加维护 `updated`、`domain` 由传入目录决定，**并在覆盖前备份旧内容到 `.trash/`**；`delete` 同样先备份 |
| `ensure_knowledge_base`（现有，扩写） | write-if-missing 追加 `AGENTS.md` / `inbox/` / `review/` / `_types/` / `.trash/` |

wikilink 解析规则（定死，不做配置）：`[[目标]]` 或 `[[目标|显示文本]]`，目标按 **标题 → 文件名（去 .md）** 两轮匹配，大小写不敏感；匹配不到记为 broken。frontmatter 里任何值含 `[[...]]` 的字段都算关系（动态识别，不列字段白名单）。

路径安全沿用现有 `resolve_card_path`（拒绝 `..` / 绝对路径 / 非 `.md` / 逃出根目录），新命令一律走它。

**⚠️ Tauri command 只服务前端。** headless pi 是独立进程，`invoke` 不到 —— agent 侧的检索走 shell `rg`（写在 `AGENTS.md` / SKILL 里），**不为 knowledge 再造一份 TS 实现**。这一条是从 memory 的教训来的：`memory.rs` 与 `extensions/memory/index.ts` 是同一套 parse/serialize/slugify 写了两遍，注释里写着 "must stay in sync"，而实际已经不同步（Rust 的 `slugify` 保留 CJK，`knowledge.rs` 的是 ASCII-only，纯中文标题回退时间戳）。knowledge 不重蹈此路，也正合 roadmap「绝不写扩展」。

### 覆盖兜底：`.trash/`（M1 就要有）

原方案把 git 归入「不学」，这个判断偏激进了：**让 AI 半夜改笔记，却没有 diff、没法回滚，只有一个 `_reviewed: false` 标记，是整个方案最弱的一环**。per-vault git + 自动提交能兜这个底。

最小补法（Rust 十几行，不引入 git）：`write_knowledge_card` / `delete_knowledge_card` 在覆盖或删除前，把旧内容原样落到 `~/.kalo/knowledge/.trash/<relPath>.<unix_ts>.md`。`.trash/` 不参与扫描（不进列表、不进图谱、不进搜索、不进 INDEX），保留 30 天由维护任务清理。用户想要真正的版本历史，自己在库根 `git init` 即可 —— 我们不做 UI。

### 前端：`src/features/notes/`

```
NotesPanel.tsx      三列布局 + 视图状态机
DomainTree.tsx      左：域 / 标签 / 待审阅 / 孤立笔记 / inbox 的筛选树
NoteList.tsx        中：搜索框 + 列表（标题、域 chip、status chip、tags、日期）
NoteEditor.tsx      右：源码/预览切换 + 属性区 + 反向链接区
graph.ts            链接渲染与跳转（[[]] 点击 → 打开目标笔记）
maintenance.ts      维护任务模板（写 Scheduler agent 任务）
```

接线（三处小改）：

- `App.tsx`：`page` 联合类型加 `"notes"`；`onOpenNotes` 回调；主面板分支渲染 `NotesPanel`（和 `era` 同构）。
- `Sidebar.tsx`：`SideButton` 在「自动化」与「演化」之间插一项「知识笔记」+ `BookIcon`，`active={page === "notes"}`。
- `SettingsPage.tsx`：`SettingsTab` 删掉 `"knowledge"`，`TABS` 去掉对应项；`KnowledgeSettings.tsx` 删除，`KnowledgeEditModal.tsx` 的模板与域标签迁进 `features/notes/`。

联动：选中笔记 → 「在对话中引用」把相对路径写进输入框（照 `EraPanel` 的 `onLeaveToChat` handoff 做法）。

### 自主管理（这一层不写扩展）

roadmap §5 说得很明确：*「能用提示 + 目录约定解决的，绝不写扩展」*。所以**不新增 harness 扩展**，agent 用已有的文件工具 + shell `rg`。自主性靠三件事：

**1. `AGENTS.md`（提示层，用户可改）** —— write-if-missing 到库根，内容写清：目录含义、frontmatter 字段、什么该存什么不该存、`[[]]` 怎么用、inbox 归类规则、`.trash/` 不要碰、`INDEX.md` 是生成物**不要手写**。agent 动笔前先读它。`internal-skills/knowledge/SKILL.md` 相应改瘦：`INDEX.md` 维护那一节删掉，检索保留 `rg`（但收敛成一条固定写法，不再让模型每次自由发挥）。

**2. 维护任务（与「自动化」联动）** —— 页面上一组开关，一键写入 gateway Scheduler 的 `kind: "agent"` cron 任务（`cwd` = 库根，`prompt` = 模板）：

| 任务 | cron | precondition（空则跳过） | prompt 要点 |
| --- | --- | --- | --- |
| 整理 inbox | `23 21 * * *` | `ls inbox/*.md` | 归类到域、补 frontmatter、合并明显重复、拿不准的留在 inbox 并说明 |
| 周度回顾 | `7 10 * * 0` | `find . -name '*.md' -newermt '-7 days'` | 近 7 天新增/改动、孤立笔记、broken 链接、`status: seed` 超期未熟 → 写 `review/YYYY-Www.md` |
| 月度整合 | `13 9 1 * *` | —（总是跑） | 相似卡合并、过长笔记拆分、`stale` 标注、清理 `.trash/` 超 30 天条目 |

这就是「知识笔记」为什么放在「自动化」正下方 —— 它的自主性是由那套定时器驱动的。

**2b. Scheduler 需要一处小改：`precondition`。** 现在 [`runAgent`](../kalo-desktop/gateway/src/scheduler.ts) 到点无条件 `requestAgentSession`，没有前置判断 —— inbox 空着的日子照样起一个 session、加载完整系统提示和工具表、调一次 `ls`、然后说「没有待整理项」，每次白烧 ~15k token。给 `ScheduleTask` 加可选 `precondition?: string`（bash 片段，**复用现成的 `runWatch` 执行器和 60s 超时**），stdout 为空就跳过本次、不起 session、`lastResult: "ok"`。约 30 行，让「无事发生的日子」成本精确为 0，也顺带把 watch 那套零 token 机制真正复用起来。`sanitizeTask` 同步加字段。**这同时是 [memory-lifecycle](./2026-08-19-memory-lifecycle.md) 的 C3——「记忆归档」任务也靠它常开而不空烧；谁先落地谁实现，不要写两遍。**

**3. 待审阅队列** —— agent 写入带 `_by: kalo` / `_reviewed: false`；左树有「待审阅（N）」入口，逐条「通过」（置 `_reviewed: true`）/ 改 / 删。夜间任务改错了有兜底（配合 `.trash/`），且不需要暂存区和 diff 视图。

## 与 memory 的边界

已有的 memory（`~/.kalo/memory/*.md` + `memory_save/search/list` 工具 + `/remember`）与知识笔记**不冲突，但边界必须写进提示层**，否则两边都塞、都不完整。

| | memory | knowledge |
| --- | --- | --- |
| 回答什么 | 关于**用户与当下**：偏好、习惯、正在做什么、项目决定。有时效 | 关于**世界与结论**：可复用、可验证、无时效 |
| 形态 | 扁平 `<slug>.md`，无层级 | 按域分目录 |
| 上下文 | **每次 agent 启动注入索引**（≤50 条 / 2000 字符 ≈ 1–1.5k token） | 不注入，按需检索 |
| 写入 | `memory_save` 工具主动写 | 文件工具 + skill 提示 |

**这个划分是对的，不该合并** —— memory 常驻上下文当索引，knowledge 离线当仓库。

**但现在已经在漏了。** 唯一那条 memory（`sdw技术课题与hrm实验线-0-25b数据策展验证计划.md`）里同时装了两类东西：SDW 项目状态、资料路径、当前计划（memory），和「PrefixLM 在 <100M 规模必败（trivial solution）」「LFM 64K tokenizer 远优于 minimind 6400」（**标准的知识卡片** —— 正好就是本文档举的 `[[PrefixLM]]` 例子）。结论混在项目状态里，会随状态更新被反复重写，也搜不到。

所以 M3 的 `AGENTS.md` 与 memory 的 `promptGuidelines` 要**成对修改**，各写清「这类东西不归我，去另一边」。

### memory 自身的改进（排 M5）

> **实施细节已抽出到 [2026-08-19-memory-lifecycle.md](./2026-08-19-memory-lifecycle.md)**（frontmatter 字段、注入排序、归档规则、Scheduler `precondition`、两侧同步清单）。本节只留结论，避免两处真相。

1. **memory 只增不减 —— 最大的结构性缺陷。** 没有淘汰、归档、过期机制。「先捕获、后归类」的生命周期在知识库侧已有，memory 现在没有：项目状态半年后还在，照样每次注入。
2. **注入按「最近更新」排，不是按「重要」排。** `loadAll()` 按 `updated` 倒序、满 2000 字符 `break`，丢的是最旧的 —— 一条核心偏好写了半年没动，会被一堆新记的琐事挤出索引。用下划线系统字段，加 `_pinned: true` 强制驻留，排序改成 pinned → 类型权重 → updated。改动小，收益直接。
3. **用 `[[wikilink]]` 打通 memory ↔ knowledge —— 最有价值的一条。** memory 只留一句摘要 + `[[PrefixLM 在 HRM 上更优]]`，全文沉到知识卡片。索引不再膨胀（省的是每次 agent 启动的真金白银），结论有独立的生命周期和反向链接，memory 回到它该干的事：当索引，不当仓库。
4. **memory 没有 type，只有自由 tags。** 借类型自描述：`type: preference | project | fact | lesson`，直接驱动策略 —— `preference` 永久驻留、`project` 有时效需定期复查、`lesson` 到点沉降为知识卡片。不引入 schema，一个 frontmatter 字段 + 提示层约定。
5. **第四个维护任务「记忆归档」。** 复用同一套 cron：提炼 memory 里的可复用结论 → 写成知识卡片 → memory 原文换成一行 + `[[链接]]`；过期 project 状态移到 `memory/archive/`（不注入）。让 1–4 自动发生，而不是靠人记得清理。
6. 顺带统一两处 `slugify`（Rust 保留 CJK vs `knowledge.rs` ASCII-only）。**这一条不在 memory-lifecycle 的范围内**，是独立小改。

## Token 成本

- **M1 / M2 全部是 0**：列表、正文搜索、链接图谱、`INDEX.md` 生成都在 Rust 里做，不经过模型。翻一天笔记消耗为 0。
- **对话内增量很小**：读一次 `AGENTS.md`（~1k）；检索返回 **snippet 不是全文**（有意如此，避免把整篇灌进上下文）。
- **后台只有 M3 花钱**（默认全部关闭，页面逐个开）。稳态粗估，未计 prompt cache 命中：

| 任务 | 频率 | 单次 input | 月量级 |
| --- | --- | --- | --- |
| 整理 inbox | 每日 | 100–250k | ~4M |
| 周度回顾 | 每周 | 300–600k | ~2M |
| 月度整合 | 每月 | 0.5–1M | ~1M |

合计 **月 5–10M input / 0.2–0.4M output**，约等于每月十几次中等规模编码对话。`precondition` 把空跑那部分砍到 0。

- **实现期一次性**：M1 约 200–400k，M2 约 150–250k，M3 约 100–200k，M4 约 150k，M5 约 150k。
- **memory 索引是常驻税**：每次 agent 启动 1–1.5k token，含每次 cron 任务。M5 的第 3 条正是在压这个数。

## 分期

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| M1 | `list_knowledge_domains` / `search_knowledge`、`ensure_knowledge_base` 扩写、**写入前进 `.trash/`**、三列页面、编辑保存、settings tab 迁移 | 日常可用的笔记工作面，正文可搜，域不再写死，覆盖有兜底 |
| M2 | `knowledge_graph` / `rebuild_knowledge_index`、反向链接面板、孤立与 broken 视图、`[[]]` 跳转 | 知识网络成形，INDEX.md 不再由模型手写 |
| M3 | `AGENTS.md` 模板 + skill 改瘦、**Scheduler `precondition`**、维护任务开关、待审阅队列、memory 边界写进两边提示（对侧那句见 [memory-lifecycle](./2026-08-19-memory-lifecycle.md) 提示层一节） | Kalo 真正自主经营，空跑不烧 token |
| M4（可选） | 检索切到 `recall`（P1-R）；重命名同步 `[[]]` 引用；引用注入对话 | —— |
| M5（memory 升级） | 见 [2026-08-19-memory-lifecycle.md](./2026-08-19-memory-lifecycle.md)：`_pinned` + 注入排序、`type` 字段、memory ↔ knowledge 的 `[[]]` 打通、「记忆归档」任务 | memory 从仓库回到索引，常驻上下文税下降 |

M5 单独排，不塞进 M1 —— 避免战线拉长。

## 风险

- **重命名笔记会打断 `[[]]` 引用**。M1–M3 不做重命名（编辑标题只改 frontmatter，文件名不动），M4 再做全库引用替换。专门的 rename 事务复杂度，我们不追。
- **全库扫描的成本**。个人量级毫秒级；`knowledge_graph` 结果在前端缓存，写入后失效重取。真扫不动了再谈索引 —— 那时正好并进 `recall`。
- **`_types/` 让域变成两处真相**（目录 + 笔记）。规则定死：**目录是真相，`_types/` 只提供展示元数据**，笔记不存在就回退目录名。
- **`.trash/` 只是兜底，不是版本历史**。只保留「上一次覆盖前」的快照序列，没有 diff、没有分支。要真历史请自行 `git init`。所有扫描路径（列表 / 搜索 / 图谱 / INDEX）必须显式排除 `.trash/`，否则会污染搜索结果和链接图 —— 这是 M1 的必测项。
- **memory 与 knowledge 的边界靠提示维持，不靠代码约束**。会有误判，靠 M5 的「记忆归档」任务事后纠偏，而不是加校验。

## 取舍结论

**赢在三处**：派生层零 token（图谱/搜索是 Rust，不是 MCP 工具，不占上下文）；markdown 源码直读直写，没有 BlockNote ↔ md 双向序列化的复杂度与规范化损耗；定位是「AI 定时经营、人审阅」，与「人写笔记、AI 辅助」的通用产品错位。

**输在四处**：编辑体验（源码+预览 vs 所见即所得）；版本历史（`.trash/` 只是兜底，同类产品有 per-vault git + 自动提交）；不能挂载已有库（锁死 `~/.kalo/knowledge`，管不了现成的 Obsidian 库）；无索引全量扫描 + `_types` 只当展示元数据用（同类产品是完整 schema：属性定义 + 视图）。

---

# 附：M1 实施清单

自底向上：Rust（可 `cargo test` 单独验）→ 桥接 → UI → 接线 → 删旧。每步结束时代码可编译。

## 步骤 1 — `src-tauri/src/knowledge.rs`（最大的一步）

**1.1 删除硬编码**
- 删 `const DOMAINS: [&str; 4]`。`write_card` 里 `if DOMAINS.contains(&domain)` 的兜底改为「非空且是单个合法路径段则用它，否则 `cards`」。
- `INDEX_STUB` 保留（M2 才由 `rebuild_knowledge_index` 接管），但去掉写死的四个 `## <域>` 小节，只留标题 + 生成物说明注释。

**1.2 扫描排除规则（M1 必测项）**
`collect_cards` 现在只跳过 `.` 前缀的名字 —— `.trash/` 因此天然不进列表，但要**显式测出来**而不是依赖巧合。新增统一规则并抽成一个函数：

```
fn is_scannable_dir(name: &str) -> bool   // 排除 "." / "_" 前缀 + "attachments"
```

`.trash`（`.` 前缀）、`_types`（`_` 前缀）、`attachments` 全部排除。列表 / 搜索 / 域树 / 将来的图谱都走这一个判定。

**1.3 `KnowledgeCardMeta` 扩字段**
`updated: String`、`status: String`、`by: String`（读 `_by`，缺省空 = 人写）、`reviewed: Option<bool>`（读 `_reviewed`）、`word_count: usize`、`snippet: String`。serde camelCase 已有，`by`/`reviewed` 前端就是 `by`/`reviewed` —— **frontmatter 里的下划线不带进 API**。

`CardFrontmatter` 相应加 `updated / status / _by / _reviewed` 四个 key。`snippet` = 正文首个非空且非 `#` 开头的行，截 120 字符（照 `memory.rs::summary_of` 的做法）。`word_count` 用正文 `chars().count()`（中文按字符算，不按空格分词）。

**1.4 `list_knowledge_domains()`（新）**
返回 `Vec<KnowledgeDomain { key, label, icon, color, order, count }>`。扫顶层目录（过 `is_scannable_dir`）→ 读可选的 `_types/<key>.md` 取 `_label/_icon/_color/_order` → count 由一次 `list_cards()` 聚合。`_types/` 缺失时 `label = key`，`order = usize::MAX`。排序 order → key。

**1.5 `search_knowledge(query, limit)`（新）**
返回 `Vec<KnowledgeSearchHit { rel_path, title, line, snippet }>`。逐文件逐行子串匹配（两侧 `to_lowercase`，不分词、不设最小长度 —— 中文 2 字查询要能用）。**每文件最多 3 条命中**，全局 `limit`（默认 50）。`line` 是 1-based 行号，`snippet` 是命中行 trim 后截 160 字符。

**1.6 `.trash/` 兜底**
```
fn backup_to_trash(rel: &str) -> Result<(), String>
```
路径 `.trash/<rel>.<unix_ts>.md`（嵌套保留原目录结构，`create_dir_all`）。`write_card` 在**覆盖已存在文件前**调用，`delete_card` 在删除前调用。**备份失败返回 Err、阻塞写入** —— 备份是可选的话兜底就形同虚设。新建文件（`rel_path.is_none()`）不备份。

注意 `backup_to_trash` 走的是 `.trash` 目录，`resolve_card_path` 会拒绝 `.` 前缀之外的东西但不拒绝 `.trash` —— 备份路径**不要**过 `resolve_card_path`（它要求 `.md` 结尾且我们的备份名是 `.md` 结尾，能过，但语义上是内部路径），直接用 `knowledge_root().join(".trash")` 拼，并断言拼出来的路径仍在 root 下。

**1.7 `ensure_knowledge_base` 扩写**
建 `cards / inbox / review / _types / .trash`（**不再建 training-notes / investing / math**）。已有用户那三个目录仍在磁盘上、照常被扫出来 —— 向后兼容靠「目录是真相」这条规则自然成立。`AGENTS.md` 模板留到 M3。

**1.8 测试**
保留 `rejects_traversal`。新增：
- `excludes_trash_and_underscore_dirs` —— 在 tempdir 里造 `.trash/x.md` / `_types/y.md` / `cards/z.md`，只应扫出 z
- `search_finds_body_line` —— 中文 2 字查询命中正文，行号正确
- `parses_extended_frontmatter` —— `_by` / `_reviewed` / `status` / `updated`
- `snippet_skips_headings`

## 步骤 2 — `src-tauri/src/main.rs`
两个 `#[tauri::command]` 包装 + `invoke_handler` 注册：`list_knowledge_domains`、`search_knowledge`。

## 步骤 3 — 桥接
- `src/types.ts`：`KnowledgeCardMeta` 补字段（并删掉 `domain` 上那句 `cards | training-notes | investing | math` 的注释 —— 它现在是错的）；新增 `KnowledgeDomain`、`KnowledgeSearchHit`。
- `src/lib/pi-bridge.ts`：`listKnowledgeDomains()`、`searchKnowledge(query, limit?)`。

## 步骤 4 — `src/features/notes/`
| 文件 | 内容 |
| --- | --- |
| `NotesPanel.tsx` | 三列布局 + 状态机（domains / cards / query / hits / selected / dirty）；列宽用 `loadWidth` + `startColumnDrag`，key `kalo.layout.notesTreeW` / `notesListW` |
| `DomainTree.tsx` | 左：全部 / inbox / 待审阅(N) / 各域(count) / 标签云 |
| `NoteList.tsx` | 中：搜索框（有 query 走 `searchKnowledge`，否则走本地过滤的 `cards`）+ 列表行（标题、域 chip、status chip、tags、日期、snippet） |
| `NoteEditor.tsx` | 右：源码 `<textarea>` / 预览切换 + 保存 + 删除；预览复用 `AssistantMessage.tsx` 那套 react-markdown 配置 |
| `template.ts` | 从 `KnowledgeEditModal.tsx` 迁 `cardTemplate()`；`DOMAIN_LABEL` 降级为 `_types/` 缺失时的**中文兜底表**（不再是权威列表） |

`_reviewed: false` 的行在列表里加一个「待审」角标。

## 步骤 5 — 接线
- `App.tsx`：`page` 联合加 `"notes"`；`const onOpenNotes = useCallback(() => setPage("notes"), [])`；主面板分支加 `page === "notes"` → `<NotesPanel />`（**不套 `EraPanel` 那个 `overflow-y-auto px-6 py-5` 容器**，三列要自己撑满高度）；header 文案 `page === "notes" ? "知识笔记" : …`；`panelOpen && page !== "era"` 改成 `page === "chat"`。
- `Sidebar.tsx`：`SidebarProps` 加 `onOpenNotes` + `notesActive`；在「自动化」与「演化」之间插一行 `SideButton`；新增 `BookIcon`（本地 inline SVG，同文件风格）。

## 步骤 6 — 删旧
删 `components/KnowledgeSettings.tsx`、`components/KnowledgeEditModal.tsx`；`SettingsPage.tsx` 的 `SettingsTab` 去掉 `"knowledge"`、`TABS` 去掉那项、删 import 和渲染分支。**`grep -rn "KnowledgeSettings\|KnowledgeEditModal\|DOMAIN_ORDER"` 确认零残留**（`DOMAIN_ORDER` 整个删掉，不迁）。

老用户 `localStorage` 里可能存着 `"knowledge"` —— 已确认 `loadTab()` 会用 `TABS.some(...)` 校验并回落 `"models"`，**不需要额外处理**。

## 步骤 7 — 验收
`cargo test`（knowledge 模块）+ `tsc` / `npm run build`，然后手测：

1. `.trash/` 里放一个 `.md`，**不出现**在列表、搜索结果、域树 ← M1 头号必测项
2. 已有的 `training-notes/` 等三个域仍正常显示（向后兼容）
3. 完全没有 `_types/` 时一切正常（label 回落目录名）
4. 纯中文标题新建 → 时间戳文件名，不报错
5. 覆盖保存一次 → `.trash/<rel>.<ts>.md` 里是前一版内容
6. 中文 2 字查询命中正文（不只是标题）
7. 老用户设置页 tab 记录是 `"knowledge"` 时能正常打开设置页（`loadTab` 已有回落，回归验证即可）
8. 侧边栏「知识笔记」高亮态与「演化」互斥

### 实施记录（2026-08-19）
M1 代码已全部落地。自动化验收已过：

- `cargo test` → 22 passed（其中 knowledge 模块 10 个）；`cargo clippy` 对 `knowledge.rs` 零告警
- `tsc --noEmit` → 仅剩 `src/lib/session-rows.test.ts` 一个既有的 `Array.prototype.at` / lib target 报错，与本次改动无关
- `vite build` → 通过

上面 8 项手测需要跑起 app，留给下一次 `npm run tauri dev`。
