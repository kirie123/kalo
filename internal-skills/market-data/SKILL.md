---
name: market-data
description: 金融数据取数层：宏观指标（美元指数/中美国债/黄金/BTC/A股量能）与财报下载的统一 CLI。当需要拉行情、查财务数据、看历史分位数、或其他 skill（macro-pulse / filing-digest）需要事实数据时使用。
---

# market-data 取数层

**只产出事实，不下结论。** 数值、分位数、变化率由脚本算；"偏紧""过热""该买"这类判断
属于调用方 skill 里的模型。这条线同时是 token 边界：线以下每天自动跑、零 token，
线以上只在用户开口时才动模型。

## 运行方式

Python 环境不在这个目录里，在数据目录 `~/.kalo/market/venv`（akshare + pandas 有
几百 MB，不该跟着 skill 被复制来复制去）：

```bash
PY=~/.kalo/market/venv/Scripts/python.exe     # Windows；类 Unix 是 bin/python
SKILL=~/.kalo/skills/market-data
$PY $SKILL/md.py macro now
```

环境不存在时重建（需要 uv，`winget install --id=astral-sh.uv`）：

```bash
uv venv --python 3.12 ~/.kalo/market/venv
uv pip install --python ~/.kalo/market/venv/Scripts/python.exe -r $SKILL/requirements.txt
```

## 命令

| 命令 | 用途 | 输出 |
| --- | --- | --- |
| `md.py probe [--all\|<id>]` | 逐源实测，框架自检 | 人读的表格 |
| `md.py get <source-id>` | 取单源事实 | JSON |
| `md.py macro now` | 全部宏观源当前快照 | JSON |
| `md.py macro append` | 快照追加进 `daily.jsonl` | **正常静默**（cron 用） |
| `md.py macro analyze [--window 250]` | 读历史算分位数与变化 | 紧凑 JSON（约 1.3 KB） |

`--fresh` 绕过缓存强制重取（`probe` / `get` / `macro now`）。

**`macro append` 的静默是契约**：它挂在 scheduler 的 `watch` 任务上，stdout 非空
即被判定为异常并推飞书。所以只有「多数源失败」才输出；单源失败是常态，已经记进
当天那行的 `errors[]` 里，不值得每天打扰人。

## 数据落在哪

```
~/.kalo/market/daily.jsonl     每日宏观快照，一行一天，append-only（同日重跑覆盖）
~/.kalo/market/cache/<id>.json 当日取数缓存（按源 ttl）
~/.kalo/market/venv/           Python 环境
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

## 边界

不做实时行情、不做图表、不做回测、**不给投资建议、不自动下单**。
