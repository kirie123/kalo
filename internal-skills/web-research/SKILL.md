---
name: web-research
description: 在线调研某个主题并输出结构化综述。当用户要求调研、查资料、做 survey、了解某领域或某技术现状时使用。
---

# 在线调研

## 流程

1. 把调研主题拆成 3-5 个具体子问题或关键词。
2. 检索（均无需 API key）：
   - arXiv API：web_fetch http://export.arxiv.org/api/query?search_query=all:<关键词>&max_results=10&sortBy=submittedDate
   - DuckDuckGo HTML：web_fetch https://html.duckduckgo.com/html/?q=<关键词>
3. 精选 5-10 个来源，用 web_fetch 逐一精读正文；正文被截断时增大 maxChars 重抓关键页面。
4. 交叉验证：同一结论至少两个独立来源才作为事实陈述；单一来源的结论标注 [单源]。
5. 综述写入 ~/.kalo/research/<topic>.md：

       # <主题>调研（<日期>）
       ## 结论速览（TL;DR）
       ## 分主题详述（每条结论附来源链接）
       ## 争议与未知
       ## 参考链接清单

6. 精华 memory_save（tags 含 research 与主题标签），第一行一句话结论。

## 要求

- 所有事实性陈述附来源 URL；抓不到就明说，不编造。
- 优先近一两年的资料，注明信息的时间点。
