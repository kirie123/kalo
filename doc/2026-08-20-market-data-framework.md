# market-data：金融取数底座 + 宏观风向 / 财报两个 skill

日期：2026-08-20
状态：已实施

## 需求

起点是一份网上流传的「个股体检清单」（风险排查 / 健康度度量 / 催化契机，3 大类 15 项），
以及一句追问：**"可以给出市场风向判断吗？"**

清单本身是纯提示层的东西，把它抄进一个 SKILL.md 五分钟就完事。但它暴露了一个真实缺口：
**Kalo 没有可复用的金融数据采集层。** 模型要回答"美债收益率现在算高吗"只能现场
`web_fetch` 猜字段，猜错也不知道，更没有历史可比——4.65% 这个数字单独看毫无意义，
只有相对它自己的历史才知道是高是低。

用户在规划期加了一条硬约束，直接决定了架构：

> "我希望数据拉取本身是不消耗 token 的，不然每天自动拉取消耗 token 就不好。"

本期范围（用户圈定）：**宏观关键指标 + 财报下载**，个股体检下一期做；**零 TS/Rust 改动**，
只写 skill 与脚本。

## 为什么不复用已有的两条机制

| 已有能力 | 为什么不够 |
| --- | --- |
| **feeds**（`gateway/src/feeds.ts`，见 [feeds doc](2026-08-20-feeds-declarative-data-pull.md)） | 表达力刻意做小到四种抽取器、无求值器，做"顶栏显示当前值"很合适，但**算不了分位数、期限利差、MACD**，也不存历史（那份 doc 的「不做」里明写了"历史时序存储"） |
| **roadmap §5 投资线**（[personal-agent-roadmap](2026-08-17-personal-agent-roadmap.md)） | 当时的结论是"不建内置目录、不做 market_data 工具，行情用 python 脚本临时写" |

roadmap 那条结论这次**修正一半**：不做引擎侧工具（保留，本期零 TS/Rust 改动），
但"临时写脚本"被实测证伪——见下一节。

## 实测：架构是被数据源逼出来的

规划期逐条实测，不是查文档得来的。本机中国大陆、裸 GET、无 API key：

| 数据 | 源 | 关键发现 |
| --- | --- | --- |
| 美元指数 | `hq.sinajs.cn/list=DINIW` | `hf_DX` / `hf_DXY` / 东财 `100.UDI` **全部返回空**，只有无前缀的 `DINIW` 可用 |
| 中美国债收益率 | datacenter `RPTA_WEB_TREASURYYIELD` | 字段是内部代号：`EMG*` = 美国，`EMM*` = 中国 |
| 金银铜油 / 纳指标普恒生 / USDCNY | `hq.sinajs.cn` | 需 `Referer: finance.sina.com.cn` + GBK 解码 |
| VIX | `cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json` | 干净 JSON |
| BTC | `api.binance.com/api/v3/ticker/24hr` | |
| 涨停池 | `push2ex.eastmoney.com/getTopicZTPool` | 炸板数要从 `pool[].zbc > 0` 数出来 |
| 两融余额 | akshare `stock_margin_sse` | |
| 财报 PDF | cninfo `hisAnnouncement/query` → `static.cninfo.com.cn` | orgId 从 `szse_stock.json` 全量表来 |
| 财务指标 | 东财 F10 `RPT_F10_FINANCE_MAINFINADATA` | **必须 `columns=ALL`**，逐个列名会返回「字段不存在」 |

**⚠ 实测中亲身触发的限流**：连续几十次请求后 `push2.eastmoney.com` 与 `push2his`
**整体拒绝服务**（连接直接空返回，curl 与 requests 同样中招，换 UA 无效，持续数小时）；
而同一时刻 `datacenter.eastmoney.com` / `hq.sinajs.cn` / `push2ex` / `cninfo.com.cn`
**全部正常**。

这条实测决定了四件事：

1. 缓存与退避重试是**必需品不是优化**，源注册表必须给每条源标 `rate: strict | normal`；
2. **最关键的指标不能单一依赖 push2**——A 股三大指数因此改走新浪简版行情
   （与美元指数、商品同一个 host，已反复验证稳定），push2 的接口留在注释里备查；
3. akshare 内部打的正是同一批接口，**装了 akshare 也逃不掉限流**，缓存层必须包住
   akshare 调用而不只是 HTTP；
4. "临时写脚本"必然反复踩这些坑，而正确的重试/缓存/字段映射知识**应该沉淀成资产**
   而不是每次重新发现。这就是本期要建的东西。

另外：本机系统代理（127.0.0.1:7897）会拒掉部分东财域名，取数默认直连
（`trust_env=False`），最后一次重试才改走代理。

## Token 边界（本方案的骨架）

| 环节 | 由谁执行 | Token |
| --- | --- | --- |
| 每日拉取 + 落盘 `daily.jsonl` | scheduler **`watch`** 任务跑 bash | **0** |
| 分位数 / 变化率 / 派生量全部计算 | `metrics.py` 纯 Python | **0** |
| 阈值越界告警推飞书 | `watch` 的 `nonEmpty` 语义 | **0** |
| 解读与判断 | 模型，**仅在用户开口时** | 按需 |

关键在于选 `watch` 而不是 `agent`：`scheduler.ts` 的两种任务里，`agent` 每次到点起一个
无头会话（烧 token），`watch` 只是跑一段 bash、stdout 非空才告警——**引擎根本不参与**。
feeds doc 里那句"让 LLM 每 20 秒读一次指数点位是纯粹的浪费"，在这里体现为：
**模型永远不参与采集，只在被问到时读一份已经算好的小结论。**

由此派生两条实施纪律，都已落地并验证：

1. **`macro append` 正常运行完全静默**（stdout 与 stderr 都是 0 字节，实测 4.9s）。
   有输出 = watch 认定异常 = 推飞书。所以正常日子里连一条推送都不产生。
   只有「多数源失败」才 echo 一行——单源失败是常态，已记进当天那行的 `errors[]`。
2. **`macro analyze` 的输出是压缩过的小 JSON**：满 250 天历史、21 个指标，实测
   **1344 字节**。为此把输出从"对象数组"改成"表头 + 数组行"（对象数组同样内容实测
   3.1 KB，字段名重复二十遍），指标中文名也不进输出——对照表在 SKILL.md 里，
   模型写报告时本来就要看那张表。

顺带白捡：**盯盘告警也是零 token 的**。想要"美元指数破 100 提醒我"，在 watch 脚本里
加一句阈值判断，越界时 echo 一行，scheduler 自动推飞书，全程不惊动模型。

## 架构

三层，边界是「**取数与判断分离**」：脚本只产出事实（数值、分位数、指标值），
**从不下结论**；判断规则全部写在 SKILL.md 里由模型执行。模型不口算任何数字，
脚本不写任何"看多看空"。这条线**同时就是 token 边界**。

```
internal-skills/
  market-data/              ← 共享底座（本身也是可直接调用的 skill）
    SKILL.md                  数据层说明 + CLI 用法 + 加源方法
    sources.yaml              源注册表（数据，非代码）
    md.py                     统一 CLI 入口
    requirements.txt          akshare / pandas / requests / pyyaml / pypdf
    lib/
      registry.py             读 sources.yaml，四种抽取器，count_where 派生
      fetch.py                http + akshare 统一取数、退避重试、直连优先
      cache.py                磁盘缓存（按源 ttl）
      metrics.py              纯函数：分位数 / 变化率 / MA / MACD / RSI / BIAS / 相关性 / 背离
      store.py                daily.jsonl 追加与读取
      macro.py                宏观快照、派生量、analyze
      filing.py               巨潮下载 + pypdf 抽文本 + 东财 F10
    tests/test_metrics.py     19 个单测，合成数据不联网
  macro-pulse/SKILL.md      指标对照表 + 判断规则 + 输出格式
  filing-digest/SKILL.md    先表后文的财报分析流程
```

`market-data` 作为独立 skill 目录而不是藏在某个 skill 下：装到 `~/.kalo/skills/market-data/`
后路径稳定可预测，另两个 skill 用绝对路径引用它；且它本身直接可用（"帮我查下美债收益率"）。

### 源注册表：数据源是数据

沿用 feeds 的核心取舍（**声明式、无求值器**，因为规格是给 LLM 写的），但多两样
feeds 刻意不要的东西：`kind: akshare`，以及**实测证据字段**。

```yaml
- id: dxy
  name: 美元指数
  group: macro              # macro 组的源会被 macro now/append 采集
  kind: http                # http | akshare
  url: "https://hq.sinajs.cn/list=DINIW"
  encoding: gbk
  headers: { Referer: "https://finance.sina.com.cn" }
  rate: normal              # normal | strict
  ttl: 300
  parse: { type: text }
  fields:
    dxy: { index: 1, sep: ",", digits: 4 }
  verified_at: "2026-08-20"
  verified_sample: 'var hq_str_DINIW="17:13:15,98.6322,...";'
```

`verified_at` / `verified_sample` **必填**，这是 feeds doc 那句"选源的判据是能不能在目标
机器上裸 GET 拿到，而不是文档上写着有没有"的**制度化**：证据跟着源一起进版本库，
源失效时 `md.py probe` 立刻指出来。

### 计算层：分位数是核心

`metrics.py` 是纯函数、不联网、不读盘的「事实 → 事实」加工层。几个刻意的取舍：

- `change_pct` 样本不足返回 `None` 而不是 `0`——"没数据"和"没变化"必须可区分；
- 收益率、利差、VIX 走**绝对变化**（个百分点），对它们说"上涨 3.2%"没有意义；
- MA / MACD / RSI / BIAS 本期宏观分析用不满，是给下一期个股体检备的——
  那份体检清单里的技术面判据正是这几个。

### 派生量

单个数字没意义，组合才有：**期限利差 10Y-2Y**（倒挂是衰退信号）、**中美 10Y 利差**
（人民币压力与外资流向）、**铜金比**（经济动能 vs 避险）、**两市成交额**
（A 股最重要的单一指标）、**炸板/涨停比**（情绪退潮）。

### 落盘

```
~/.kalo/market/daily.jsonl     每日宏观快照，一行一天，append-only（同日重跑覆盖）
~/.kalo/market/cache/<id>.json 当日取数缓存
~/.kalo/market/venv/           Python 3.12 环境（uv 建）
~/.kalo/filings/<code>/        年报 PDF + 抽出的 txt + metrics.json
```

选 JSONL 而不是数据库或 CSV：一行一个原子写（断电最多丢当天那行）、字段可随时增加
（加一条源不需要迁移旧数据）、rg / pandas / 编辑器都能直接读。

**venv 刻意放在数据目录而不是 skill 目录**：akshare + pandas 几百 MB，
不该跟着 skill 被 `internal_skills.rs` 复制，也不该进仓库。

## 每日落盘任务

已写入 `~/.kalo/agent/schedules.json`：

```json
{ "id": "market-daily-snapshot", "kind": "watch", "schedule": "5 17 * * 1-5",
  "script": "\"$HOME/.kalo/market/venv/Scripts/python.exe\" \"$HOME/.kalo/skills/market-data/md.py\" macro append" }
```

收盘后跑，工作日五天。watch 的超时是 60s，实测一次全量采集 4.9s。

## 验证

| 项 | 结果 |
| --- | --- |
| 框架自检 `md.py probe --all` | 10/10 条源可用 |
| 缓存有效性 | 首次约 1.6s，二次全走缓存 6–12ms |
| 指标正确性 `pytest tests/` | 19 passed（与手算对照，不与联网数据对照） |
| `macro append` 静默 | stdout 0B / stderr 0B / 退出码 0 / 4.9s |
| `macro analyze` 体积 | 250 天 × 21 指标 = 1344 B（目标 < 2 KB） |
| 样本不足标记 | 历史 < 60 个交易日时输出带 `warning` |
| 财报端到端 | 茅台 2025 年报 PDF 1057 KB → txt 157416 字，含「营业收入」33 处 |
| F10 指标 | 近 12 期，金额转亿元，1.8 KB |
| 零 token | 全程未新增 `~/.kalo/agent/sessions/` 会话 |

## 不做

- 不做实时行情、图表、回测——daily 粒度足够，更高频要另起一条线。
- **不做投资建议、不自动下单**（roadmap §5 的定位：记录与复盘）。
- 个股体检 skill 本期不做——底座已备好（metrics 的技术指标 + 解禁/大宗/涨停池源），
  下一期只需写 SKILL.md 与注册几条源。

## 后续

1. 个股体检 skill：把那份 15 项清单拆成「脚本取事实 + SKILL 判规则」，复用本底座。
2. 攒够 60 个交易日后回看分位数是否有效，届时再决定要不要补历史回填（东财有日线接口，
   但要按 strict 限流小心拉）。
3. `sources.yaml` 里 `derive` 目前只有 `count_where` 一种；等第三个用例出现再扩，
   不预先造求值器（feeds 的教训）。
