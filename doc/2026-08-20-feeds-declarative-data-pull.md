# Feeds：把「机械的、要配置的定期拉取」做成一条声明式机制

日期：2026-08-20
状态：M1 已实施（2026-08-20），M2/M3 待办

## 需求

起点是一个具体诉求：顶栏放一条股市大盘的滚动行情。

但盘面数据只是这类需求的一个实例。「每隔一段时间去某个 URL 取一段数据、抽出几个字段、按格式显示或在越界时提醒」——这件事是**纯机械**的，唯一需要人参与的部分是**配置**（地址、字段、频率、格式）。这类需求会不断出现：汇率、比特币、GitHub 仓库 star/issue、CI 队列长度、天气、机场延误、论文 arXiv 新条目、家里 NAS 的剩余容量。

所以这次不做「行情条」，做一条可复用的机制：**feed = 声明式的周期性数据拉取 + 声明式的呈现位置**。行情条是它的第一个实例，配置文件而不是代码。

## 现状与问题

已有的两条「定时」能力都不适配：

| 现有能力 | 位置 | 为什么不够 |
| --- | --- | --- |
| `watch` 任务（cron + bash 片段，输出非空则告警） | `gateway/src/scheduler.ts` | 最快只能到**分钟**（5 字段 cron + 30s tick）；产物是「一次告警」而不是「一个持续可读的当前值」；要靠用户写 shell + curl + jq，Windows 上还依赖 bash |
| `agent` 任务（cron 唤起无头会话） | 同上 | 每次都烧 token。让 LLM 每 20 秒读一次指数点位是纯粹的浪费 |
| `job` 运行时（长驻命令 + 规则抽指标） | `gateway/src/jobs/` | 面向「一次长跑任务的生命周期」，不是「一个反复刷新的值」 |

缺的正是中间那一层：**高频、零 token、结果是"当前快照"而不是"事件"、且定义是数据而不是脚本**。

对照 roadmap（`doc/2026-08-17-personal-agent-roadmap.md`）§7 第一条「文件即状态，但状态由工具写，不由模型手写」：feed 恰好是这条原则的模范用例——配置由人/模型写一次，值由引擎写。

## 决策

1. **引擎放在网关子进程**（`gateway/src/feeds.ts`）。理由：进程常驻（桌面窗口关掉也在）、已经拥有飞书推送通道、Bun 自带 `fetch` 与 `TextDecoder("gbk")`（国内行情源大量 GBK），零新依赖。Rust 侧 `Cargo.toml` 里没有 HTTP 客户端，放那边要引入 reqwest + 编码库，不划算。
2. **一个源一个文件**：`~/.kalo/feeds/<id>.json`。不塞进 `schedules.json`：feed 的字段集合和 task 完全不同，混在一个数组里两边都要 `kind` 判空；而且单文件让「手写一个源」「用 git 版本化」「模型生成一个源」都变成一次原子写。
3. **自己的快 tick**，与 scheduler 的 30s tick 并存。feed 的周期是 `everySec`（秒级整数），不是 cron——「每 20 秒」这件事 cron 表达不了，而 feed 也几乎不需要「每周一 9:30」这种日历语义。
4. **表达力刻意做小，且不含任何求值器**。字段抽取只有「JSON 路径 / 正则 / 按分隔符取第 n 段 / 常量」四种，加上 `scale`、`digits`、`prefix/suffix` 的数值整形。没有 `eval`、没有 JS 片段、没有表达式语言。理由：这些配置会由 LLM 生成，一个能求值的字段等于给模型开了一个任意代码执行入口；而 90% 的真实数据源用这四种就够。表达力不够的场景退回 `watch`/`agent` 任务——那条路本来就是给「需要脚本」准备的。
5. **值写进快照文件** `~/.kalo/feeds/state/<id>.json`。桌面首屏、飞书推送、模型读取共用同一份，不必各自缓存；网关重启后顶栏立刻有值（带 stale 标记）而不是空白。
6. **呈现位置是声明的一部分**（`surface`）。同一套拉取逻辑，`ticker` 进顶栏滚动，`card` 进面板，`alert` 触发推送，`note` 落到知识库。M1 只实现 `ticker`，但字段先留好，避免以后为了「同样的数据换个地方显示」再造一次机制。
7. **失败是常态，不是异常**。行情源会限流、会改字段、会在非交易时段返回空。所以：指数退避、连续失败 N 次后转静默（仍保留最后一次成功值并打 stale）、错误只在面板里可见，不推送。顶栏永远不因为一个源挂了而变成红字。

## 数据模型

### 规格 `~/.kalo/feeds/<id>.json`

```jsonc
{
  "id": "cn-index",              // [\w-]{1,64}，与文件名一致
  "name": "A股大盘",
  "everySec": 20,                // 拉取间隔，最小 5
  "surface": "ticker",           // ticker | card | alert | note（M1 只有 ticker）
  "enabled": true,
  "request": {
    "url": "https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f14&secids=1.000001,0.399001",
    "encoding": "utf-8",         // utf-8 | gbk，默认 utf-8
    "headers": { "Referer": "https://finance.sina.com.cn" }
  },
  "rows": { "path": "data.diff" },   // 可选：把响应切成多行
  "fields": {
    "label":  { "path": "f14" },
    "value":  { "path": "f2", "scale": 0.01, "digits": 2 },
    "change": { "path": "f3", "scale": 0.01, "digits": 2, "suffix": "%" }
  },
  "template": "{label} {value} {change}",   // 每行渲染成一条
  "trendField": "change"          // 该字段的正负决定涨跌配色
}
```

`rows` 的两种形态：

- `{ "path": "data.diff" }` —— JSON 响应里的数组，每个元素一行。
- `{ "split": "\n" }` —— 文本响应按分隔符切行（新浪 `hq.sinajs.cn` 一行一只）。

省略 `rows` 时整个响应算一行。

### 字段抽取器（四种，互斥）

| 形态 | 用于 | 例 |
| --- | --- | --- |
| `{ "path": "a.b.0.c" }` | JSON（点号路径，数字段即数组下标） | `data.diff.0.f2` |
| `{ "regex": "([\\d.]+)", "group": 1 }` | 文本（首个匹配的第 group 个捕获组） | 从 `hq_str_sh000001="..."` 里取值 |
| `{ "index": 3, "sep": "~" }` | 文本按分隔符取第 n 段（腾讯 `qt.gtimg.cn`） | `index: 3, sep: "~"` |
| `{ "const": "上证" }` | 补一个固定文本（源里没有名字时） | — |

共用的数值整形（都可选，按序应用）：`scale`（乘数，东财返回定点整数，用 `0.01`）→ `digits`（小数位，四舍五入）→ `plus`（正数补 `+`）→ `prefix` / `suffix`。

三个数值选项**都没写时不做数字解析**，源里的文本原样保留——否则 `000001` 会变成 `1`、`10874.20` 会变成 `10874.2`。

抽不到值 = 空字符串，不是错误：源改字段时那一格空着，其他格照常显示。

### 两个示例源（实测于 2026-08-20，本机在中国大陆）

| 源 | 地址 | 实测结论 |
| --- | --- | --- |
| A股大盘 | `push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f14&secids=1.000001,0.399001,0.399006` | JSON / UTF-8，定点整数（`scale: 0.01`）。**不需要** UA 或 Referer，但**约每六次请求会有一次连接被直接掐断**——与 UA 无关，重试即好。这正是决策 7（失败是常态）要处理的形态。 |
| USD/CNY | `hq.sinajs.cn/list=fx_susdcny` | 文本 / GBK，需要 `Referer: finance.sina.com.cn`。单行按 `,` 切：`3` 昨收、`8` 最新价、`9` 名称、`10` 涨跌幅%、`11` 涨跌额（用 `最新价 - 昨收 = 涨跌额` 对齐过，不是猜的）。 |

Yahoo 的 `query1.finance.yahoo.com/v8/finance/chart/CNY=X` 一度是更省事的选择，但本机实测**恒定 403**（带浏览器 UA 也一样），已弃用。选源的判据就是这个：能不能在**目标机器**上裸 GET 拿到，而不是文档上写着有没有。

### 快照 `~/.kalo/feeds/state/<id>.json`

```jsonc
{
  "id": "cn-index",
  "at": "2026-08-20T06:31:02.114Z",   // 本次拉取完成时刻
  "ok": true,
  "ms": 143,                           // 耗时
  "items": [
    { "text": "上证指数 3421.55 +0.62%", "trend": "up" },
    { "text": "深证成指 10874.20 -0.13%", "trend": "down" }
  ]
}
```

失败时 `ok: false` + `error`，且 **`items` 保留上一次成功的内容**——顶栏显示旧值加一个 stale 点，比清空有用。

### 上报给 UI 的行 `FeedInfo`

规格 + 最新快照 + `nextPullAt` + `consecutiveFailures`。和 `ScheduleTaskInfo` 同一个套路：UI 只渲染快照，不自己算下次时间。

## 秘密与安全边界

- **只发 GET**，只允许 `http:` / `https:`。
- 3s 超时；响应体上限 512 KB（超出即截断并按解析失败处理）。
- `everySec` 下限 5 秒，且引擎对同一个源有重入保护（上一次没回来就跳过这一拍）。
- URL 与 headers 里的 `${secret:NAME}` 在**发请求前**替换，取值来自 `~/.kalo/feeds/secrets.json`（`{"NAME":"..."}`）。规格文件因此可以进 git，secrets 不进。日志里只打 URL 的 host+path，不打 query。
- 没有做私网地址黑名单：这是本机个人工具，用户完全可能想拉自己 NAS 或本地服务的接口。真正的边界是「只能 GET、只能读、拿到的东西只用于显示」。
- LLM 生成的规格必须先 dry-run（见下）才落盘，避免「模型猜了个字段名 → 顶栏一片空白 → 用户不知道哪错了」。

## UI

**顶栏（`surface: ticker`）**：菜单栏右侧、窗口按钮左侧的一段横向跑马灯。内容是所有启用中 ticker 源的条目拼接，**涨红跌绿**（A股/国内财经 UI 的惯例，示例源都是这个语境；配色仍取主题变量 `--danger` / `--ok`），鼠标悬停暂停滚动并显示每条的来源与拉取时刻，点击进「自动化」页。这条区域**不能**带 `data-tauri-drag-region`——悬停暂停需要指针事件，二者互斥；顶栏其余部分仍可拖动。窗口窄于 `lg` 时整条隐藏，避免与居中标题打架。

**「自动化」页新增「数据源」区**：一行一个源，显示名称 / 落地面（surface）/ 间隔 / 下次拉取 / 上次拉取时刻与耗时 / 连续失败次数，操作有 启用·停用 / 立即拉取 / 最近快照（展开这次解析出的每一行，带涨跌配色）/ 删除。上次错误就地展开成一行红字，不弹 toast。

编辑走「打开 JSON 文件」而不是做表单：字段是嵌套的、形态是多选一的，表单化的成本远高于收益，而目标用户（人 + 模型）都更擅长直接改 JSON。

## 协议

沿用 scheduler 的形状（`gateway/src/protocol.ts` → `src-tauri/src/gateway.rs` → Tauri 事件）：

```
Rust → gateway:  feed_list | feed_upsert{spec} | feed_remove{id} | feed_run{id}
gateway → Rust:  feed_status{feeds: FeedInfo[]} | feed_error{message}
Rust → 前端:      feed-status 事件 + feed_list 命令（缓存快照，首屏无往返）
```

## `feed-designer`：让模型配这件事

配置是这套机制唯一需要人的部分，所以它应该能被委托。新增内置技能 `feed-designer`，流程固定为四步：

1. 问清「要什么数据、多快、显示在哪」。
2. 找数据源，**先 curl 一次看真实响应**（不许凭记忆写字段名）。
3. 写出规格，**必须 dry-run**：`feed_run` 一次，把抽出来的 items 念给用户看。
4. 用户确认后才落盘启用。

M2 排。M1 先把引擎和 UI 做出来，人手写 JSON 也能用。

## 里程碑

- **M1（本次）**：网关侧 feed 引擎（快 tick、四种抽取器、退避、快照持久化）+ 顶栏 ticker + 「自动化」页数据源列表 + 首次运行写入两个示例源（A股大盘、USD/CNY）。列表里的「编辑」直接用系统默认程序打开该源的 JSON 文件（`open_path`），不做表单。
- **M2**：`feed-designer` 技能与 dry-run 闭环；`surface: card` 与 `alert`（含阈值条件 `when`：字段 + 比较符 + 阈值，同样不含求值器）。
- **M3**：`surface: note`（拉取结果按模板落进 `~/.kalo/knowledge/`，日报/周报类需求）；连续失败后可选唤起 agent 自愈（读最近响应、改字段路径、重新 dry-run、报给用户）。

## 测试

`gateway/src/feeds.test.ts`，注入 `fetch` 与 `now`：

- 四种抽取器 + `scale/digits/plus/suffix` 的整形结果
- `rows.path` / `rows.split` / 无 rows 三条路径
- GBK 解码（用真实字节，不用 mock 解码器）
- 失败退避：连续失败下 `nextPullAt` 指数增长、上限、成功后立刻复位
- 失败时 items 保留上次成功值并置 stale
- 重入保护：慢响应期间的 tick 不重复发请求
- `${secret:...}` 替换、非法 URL/scheme 被拒、`everySec` 下限夹取

前端把「哪些条目该进顶栏、怎么格式化」抽到 `src/lib/feed-view.ts`（纯函数，只有 type-only 依赖），`src/lib/feed-view.test.ts` 覆盖：只取启用中的 ticker 源、跳过从未拉取过的源、失败时保留旧值并在 tooltip 里说明、间隔与时刻的中文格式、涨红跌绿的配色映射。组件本身不测（渲染层没有逻辑）。

## 不做

- 通用表达式/脚本字段（见决策 4）。
- WebSocket / 流式行情。免费源基本不给，且真要实时应该走 `job` 长驻进程。
- 历史时序存储与图表。快照只有「当前值」；要历史就落知识库（M3）或另开一条线。
- 行情专有语义（复权、交易日历、集合竞价）。feed 不认识「股票」，只认识「字段」。
