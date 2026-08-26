---
name: glassnode-research
description: Glassnode Research 公开报告的拉取与归档（The Week On-chain 周报 / BTC Market Pulse / Market Compass / Product & Research 全栏目），含图表图片本地化。当用户要求查看、分析 Glassnode 周报、链上周报、加密市场研究报告时使用。
---

# glassnode-research：Glassnode 公开报告归档

拉取 `research.glassnode.com`（Ghost CMS）的**公开**文章，全文转 markdown 存本地，
图表图片下载到本地供读图分析。无需登录、无需 API key。四个栏目全拉：
The Week On-chain（周三）、BTC Market Pulse（周一）、Market Compass、Product & Research。

**只搬事实，结论归调用方。** 归档是原材料；怎么解读由对话里的模型决定。

## 运行方式

纯标准库 Python 脚本（无第三方依赖），解释器走 `~/.kalo/market/py` 这个入口
（它自己会找该用哪个 Python）；没有它时用系统 `python`：

```bash
PY=~/.kalo/market/py            # fallback: python
GN=~/.kalo/skills/glassnode-research/gn.py
$PY $GN doctor
```

## 命令

| 命令 | 用途 | 输出 |
| --- | --- | --- |
| `gn.py doctor` | 环境自检：解释器、网络可达、RSS 最新篇、归档统计 | 人读的表 |
| `gn.py pull` | 拉 RSS 最新 15 篇，按 guid/link 去重存新篇（幂等） | JSON 摘要 |
| `gn.py pull --quiet` | 同上但成功静默 | **正常静默**（cron 用） |
| `gn.py pull --force` | 已归档的也重拉覆盖（正文修过时用） | JSON 摘要 |
| `gn.py backfill [--limit N] [--delay S]` | 走 sitemap 回填历史英文原版（默认 100 篇、间隔 1s） | JSON 摘要 |
| `gn.py list [--category 栏目] [--limit N]` | 列本地归档 | JSON 数组 |
| `gn.py path <slug片段>` | 查某篇的本地文件路径 | 路径 |

`pull --quiet` 的静默是契约（同 market-data 的 `macro append`）：挂 scheduler 的
watch 任务时 stdout 非空即异常。建议每天跑一次即可，新篇会在下次 `list` 里出现。
本 skill 不自动建定时任务，要定时由用户在 scheduler 里配。

回填只取英文原版：翻译版（chinese/vietnamese/french 等首路径段）被过滤；
`/content/` 前缀下的老文是正常英文文章。全量约 740 篇，`--limit 0` 不限。

## 数据落在哪

```
~/.kalo/research/glassnode/
  index.json                        索引：guid → {title, link, published, categories, file, words, images}
  <year>/<date>-<slug>.md           正文 markdown（frontmatter + 正文）
  <year>/assets/<date>-<slug>/      图表图片 img-NN.png（正文里的相对路径指向这里）
```

## 分析流

1. `gn.py pull` 拿新篇；`gn.py list --category "Week On-chain" --limit 4` 定位要读的篇目。
2. 读 `index.json` 里对应 `file` 的 `.md` 正文。
3. **图表是分析的重点**：正文里 `![chart](assets/.../img-NN.png)` 的图在本地，用读图
   能力逐张看——周报的核心信息（链上指标形态）大半在图里，不要只读文字。
4. 结论按 web-research 惯例写 `~/.kalo/research/<topic>.md`，注明引用的报告期数与日期；
   精华入 memory（tags 含 research、glassnode）。

## 边界

- 只拉公开内容，不绕会员墙；RSS/页面给什么拿什么。
- 报告版权归 Glassnode，归档仅供个人研究，不二次分发、不上传第三方。
- 这是研究**文章**归档，不是实时链上数据接口（Glassnode API 是另一个付费产品）。
