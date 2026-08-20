---
name: market-data
description: 金融数据取数层：宏观指标（美元指数/中美国债/黄金/BTC/A股量能）与财报下载的统一 CLI。当需要拉行情、查财务数据、看历史分位数、或其他 skill（macro-pulse / filing-digest）需要事实数据时使用。
---

# market-data 取数层

**只产出事实，不下结论。** 数值、分位数、变化率由脚本算；"偏紧""过热""该买"这类判断
属于调用方 skill 里的模型。这条线同时是 token 边界：线以下每天自动跑、零 token，
线以上只在用户开口时才动模型。

## 运行方式

解释器不在这个目录里（akshare + pandas 有几百 MB，不该跟着 skill 被复制来复制去），
也不要写死某个 venv 路径——**用 `~/.kalo/market/py` 这个入口**，它自己会去找该用哪个
Python（专用 venv → uv 管的 → 系统的），在 Windows 和类 Unix 上都是同一行：

```bash
PY=~/.kalo/market/py
SKILL=~/.kalo/skills/market-data
$PY $SKILL/md.py macro now
```

跑不起来时第一步是自检，它会说清楚缺什么：

```bash
$PY $SKILL/md.py doctor
```

环境没就绪（缺 Python 或缺依赖）时初始化一次，联网、几分钟：

```bash
bash $SKILL/setup.sh                  # 也可以点：设置 → Skills → 市场数据运行环境
bash $SKILL/setup.sh --mirror https://pypi.tuna.tsinghua.edu.cn/simple
```

想指定别的解释器：`export KALO_MARKET_PYTHON=/path/to/python`。

## 命令

| 命令 | 用途 | 输出 |
| --- | --- | --- |
| `md.py doctor` | 环境自检：解释器、依赖、已攒的数据 | 人读的表格（不联网） |
| `md.py probe [--all\|<id>]` | 逐源实测，框架自检 | 人读的表格 |
| `md.py get <source-id>` | 取单源事实 | JSON |
| `md.py macro now` | 全部宏观源当前快照 | JSON |
| `md.py macro append` | 快照追加进 `daily.jsonl` | **正常静默**（cron 用） |
| `md.py macro analyze [--window 250]` | 读历史算分位数与变化 | 紧凑 JSON（约 1.3 KB） |
| `md.py filing list <code> [--type 年报]` | 巨潮定期报告清单 | JSON |
| `md.py filing get <code> [--year --type]` | 下载 PDF 并抽文本 | JSON（落盘路径） |
| `md.py filing metrics <code> [--periods 12]` | 东财 F10 结构化财务指标 | JSON |
| `md.py stock checkup <code> [--days 20]` | 个股体检三大类事实 | 紧凑 JSON（约 7 KB） |

`--fresh` 绕过缓存强制重取（`probe` / `get` / `macro now` / `stock checkup`）。

**`macro append` 的静默是契约**：它挂在 scheduler 的 `watch` 任务上，stdout 非空
即被判定为异常并推飞书。所以只有「多数源失败」才输出；单源失败是常态，已经记进
当天那行的 `errors[]` 里，不值得每天打扰人。

## 数据落在哪

```
~/.kalo/market/daily.jsonl     每日宏观快照，一行一天，append-only（同日重跑覆盖）
~/.kalo/market/cache/<id>.json 当日取数缓存（按源 ttl）
~/.kalo/market/py              解释器入口（Kalo 生成，改了不会被覆盖）
~/.kalo/market/venv/           setup.sh 建的专用 Python 环境
```

## 加一条源

改 `sources.yaml` 就行，不用碰代码。四种字段抽取器（与 gateway 的 feeds 同一套心智）：

```yaml
- id: dxy
  name: 美元指数
  group: macro              # macro 组的源会被 macro now/append 采集
  kind: http                # http | akshare
  url: "https://hq.sinajs.cn/list=DINIW"
  encoding: gbk
  headers: { Referer: "https://finance.sina.com.cn" }
  rate: normal              # normal | strict（strict 走长 TTL，实测会被限流）
  ttl: 300
  parse: { type: text }     # text | json | dataframe
  fields:
    dxy: { index: 1, sep: ",", digits: 4 }   # 或 {path: a.b.0} / {regex: ..., group: 1} / {const: ...}
  verified_at: "2026-08-20"
  verified_sample: 'var hq_str_DINIW="17:13:15,98.6322,...";'
```

`verified_at` / `verified_sample` 是**必填**：选源的判据是「能不能在这台机器上裸取到」，
不是「文档上写着有没有」。加完跑 `md.py probe <id>` 确认字段真的抽出来了。

### 个股源（`group: stock`）与宏观源的两点不同

1. **返回的是表不是标量**。K 线、解禁记录、公告清单都是多行，`fields` 那套「一个字段
   抽一个值」套不上，由 `fetch_rows()` 整段取出交给 `lib/stock.py` 计算。这类源
   `fields` 留空即可。
2. **URL 带占位符**，由 `stock.code_params()` 按代码算好传入：

   | 占位符 | 含义 | 示例 |
   | --- | --- | --- |
   | `{code}` | 6 位代码 | `600519` |
   | `{secid}` | 东财 secid（1=沪 0=深） | `1.600519` |
   | `{secucode}` | 东财 SECUCODE | `600519.SH` |
   | `{tencent}` | 腾讯/新浪前缀代码 | `sh600519` |
   | `{orgid}` | 巨潮 orgId | `gssh0600519` |
   | `{cninfo_column}` | 巨潮 column | `sse` / `szse` |

   因为带占位符，这类源必须写 `probe_with: { code: "..." }`，否则 `md.py probe`
   打出去的是一条含大括号的废 URL。**样本代码要挑真有数据的那只**——解禁源用茅台会
   返回「数据为空」，看起来像源坏了，所以那条填的是 688981。

   缓存也按代码分开（`<id>-<code>.json`），否则查完茅台再查平安会读到茅台的 K 线。

## 已知的坑（实测得来）

- `push2*.eastmoney.com` 连续请求几十次后**整体限流**，换 UA 无效，可持续数小时；
  同一时刻 `hq.sinajs.cn` / `datacenter.eastmoney.com` / `push2ex` 全部正常。
  所以关键指标不单一依赖 push2，且缓存是必需品不是优化。**akshare 内部打的是同一批
  接口**，装了 akshare 也逃不掉，缓存层因此包住 akshare 调用而不只是 HTTP。
- 本机系统代理会拒掉部分东财域名，取数默认直连（`trust_env=False`），最后一次重试
  才改走代理。
- 新浪行情要 `Referer: finance.sina.com.cn` + GBK 解码，否则空返回或乱码。
- 美元指数只有无前缀的 `DINIW` 这一个代码可用（`hf_DX` / `hf_DXY` / 东财 `100.UDI` 全空）。
- 东财 F10 财务接口必须 `columns=ALL`，逐个列名会返回「字段不存在」。
- 东财报表名猜不得，但猜错有明确反馈（`9501 报表配置不存在`）：质押是 `RPT_CSDC_LIST`、
  解禁是 `RPT_LIFT_STAGE`、增减持是 `RPT_SHARE_HOLDER_INCREASE`、F10 概念板块是
  `RPT_F10_CORETHEME_BOARDTYPE`（且必须 `source=HSF10&client=PC`）。
  `9201 返回数据为空` 是另一回事——报表活着，只是这只票没这项记录。
- 日线走腾讯 `web.ifzq.gtimg.cn` 的 **qfq(前复权)**：push2his 会限流，而不复权序列
  在分红除权处会造出假跳空，MA/MACD 全废。
- `akshare.stock_gpzy_pledge_ratio_em` 实测已坏（`TypeError`），质押直接打接口。

## 边界

不做实时行情、不做图表、不做回测、**不给投资建议、不自动下单**。
