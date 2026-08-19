---
name: paper-reading
description: 精读论文并沉淀结构化笔记与长期记忆。当用户给出论文 PDF、arXiv 链接/ID，或要求读论文、总结论文方法时使用。
---

# 论文阅读与沉淀

## 获取全文

- 用户拖入对话的 PDF 可直接阅读。
- 本地目录中的 PDF 用 Python 提取文本（逐页拼接）：

      python -c "import pypdf, sys; r = pypdf.PdfReader(sys.argv[1]); print('\n'.join((p.extract_text() or '') for p in r.pages))" <pdf路径>

- arXiv 论文：web_fetch 抓取 https://ar5iv.org/abs/<id> 全文，失败则抓 https://arxiv.org/abs/<id> 摘要页；都失败时请用户提供 PDF。

## 产出（两层，都要做）

1. 结构化笔记，写入 ~/.kalo/papers/<slug>.md（slug 取论文短名，如 transformer-xl）：

       # <标题>（作者，年份）<链接>
       ## 问题与动机
       ## 核心 idea（一句话）
       ## 方法拆解
       ## 关键实验与消融
       ## 局限性
       ## 可复用点（对我的研究）
       ## 相关论文与记忆

2. 精华沉淀：memory_save（tags 含 paper 与主题标签），content 第一行是一句话 idea，正文放关键数字与结论。这样以后任何对话聊到相关主题都能联想到。

## 要求

- 笔记用中文，术语保留英文原文。
- 不逐节翻译，抓主线：问题 → idea → 证据 → 局限。
- 不确定的数字或结论标注 [待核实]。
