# Glassnode Research 公开报告拉取（glassnode-research skill）

日期：2026-08-27

## 背景与目标

用户希望 Kalo 桌面端能拉取 Glassnode Research（https://research.glassnode.com/）公开发布的
每周报告并基于其分析。本文记录拉取通道的调研结论与实现方案。

## 拉取通道调研结论（2026-08-26 实测）

`research.glassnode.com` 是 **Ghost CMS** 站点（响应头 `ghost-fastly`），公开内容无需
登录、无需 API key：

- **RSS 全文订阅**：`https://research.glassnode.com/rss/`，最新 15 篇，
  `content:encoded` 含**完整 HTML 正文**（实测最新 Week On-chain 约 23KB HTML /
  1500 词，从 Executive Summary 到结尾免责声明完整）。
- **栏目靠 category 区分**：`The Week On-chain`（每周三，旗舰周报）、
  `BTC Market Pulse`（每周一）、`Market Compass`、`Product & Research`。用户要求全拉。
- **历史回填**：`sitemap.xml → sitemap-posts.xml` 共 2105 篇文章 URL，其中约 1360 篇
  是翻译版（首路径段为 `cn/chinese/vietnamese/french/turkish/spanish/farsi/polish/
  japanese/greek/russian/portuguese/arabic/es`），过滤后英文原版约 740 篇；另有 9 篇
  老文挂在 `/content/` 前缀下，属正常文章。文章页是服务端渲染静态 HTML，正文在
  `<section class="gh-content gh-canvas">`，标题/时间可取 meta `og:title` /
  `article:published_time`。
- **图表是图片**：一期周报约 13 张图。文本转换会丢图表，需下载图片到本地供模型读图。

## 方案选型：internal skill，不做进 feeds

现有两条数据通路里：

- **feeds 引擎（gateway）不匹配**：定位是秒级行情滚动条，快照是一行渲染文本，四种
  抽取器（path/regex/index/const）解析不了带命名空间的 RSS XML，也无归档概念。
- **internal skill + Python 脚本**（采用）：与 `market-data` 的 `md.py` 同一模式。
  新 skill 为 `internal-skills/glassnode-research/`，纯标准库实现（无 akshare/pandas
  依赖），解释器复用 App 启动时无条件写出的 `~/.kalo/market/py` shim
  （`market_env.rs`，`main.rs:606` 调用），fallback 到系统 `python`。

数据落在 `~/.kalo/research/glassnode/`（与 web-research 的 `~/.kalo/research/` 同根）：

```
~/.kalo/research/glassnode/
  index.json                 {guid: {slug,title,link,published,categories,file,words,images}}
  <year>/<date>-<slug>.md    正文 markdown（frontmatter + 正文，图片指向本地相对路径）
  <year>/assets/<date>-<slug>/img-NN.<ext>   图表图片
```

## 命令设计（gn.py，纯标准库）

| 命令 | 用途 |
| --- | --- |
| `gn.py doctor` | 环境自检（解释器、网络可达、归档统计），不联网数据写入 |
| `gn.py pull [--quiet]` | 拉 RSS，按 guid 去重存新篇；`--quiet` 成功静默（挂 scheduler watch 用，契约同 `macro append`） |
| `gn.py backfill [--limit N] [--delay S]` | 走 sitemap 回填历史英文原版，默认 limit=100、delay=1s |
| `gn.py list [--category X] [--limit N]` | 列出本地归档（JSON） |
| `gn.py path <slug>` | 打印某篇的本地文件路径 |

## 分析流（agent 消费方式）

1. `gn.py pull` 拿新篇（或用户开口才拉）；
2. 读 `index.json` 选篇，读对应 `.md` 正文；
3. 图表在同级 `assets/` 下，用读图能力逐张分析；
4. 分析结论按 web-research 惯例写 `~/.kalo/research/<topic>.md`，精华入 memory。

定时拉取由用户在 scheduler 配 watch 任务（如每天一次 `pull --quiet`），skill 不自动建任务。

## 边界

- 只拉公开内容，不绕过任何会员墙；RSS 给什么拿什么。
- 报告版权归 Glassnode 所有，归档仅供个人研究，不二次分发。
- 不做实时链上数据（那是 Glassnode API 的付费领域），本 skill 只覆盖研究文章。
