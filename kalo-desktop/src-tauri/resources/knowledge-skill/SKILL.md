---
name: knowledge
description: 个人知识库（~/.kalo/knowledge）的存取与检索。当会话产出可复用的结论/经验时，主动建议用户存卡；用户说「存」「存入知识库」时执行 save。需要引用过往经验时用 search；会话主题涉及训练/投资/数学时可主动 recall 相关卡片。
---

# knowledge — 个人知识库技能

知识库是纯 markdown 文件，位于 `~/.kalo/knowledge/`：

```
~/.kalo/knowledge/
  cards/            # 通用经验卡（跨领域）
  training-notes/   # 训练实验结论
  investing/        # 交易日志、复盘、策略笔记
  math/             # 探索笔记：猜想→验证→结论/反例
  INDEX.md          # 全库目录（title + tags + 路径），由你维护
```

## save：把当前会话的结论存为经验卡

触发时机：会话产生了**可复用的结论**（实验结论、排错经验、策略复盘、定理/反例）时，
主动问一句「这个结论值得存入知识库吗？」，用户同意后才写。质量优先于数量，
不确定就不要存。

卡片格式（frontmatter 字段必须齐全）：

```markdown
---
title: 一句话结论式标题
domain: training-notes        # cards | training-notes | investing | math
tags: [hrm, prefixlm, ablation]
date: 2026-08-15              # 今天
source_session: a3f9c2        # 当前会话 id（能拿到就填）
---
## 背景
（实验设置 / 问题上下文 / 变量控制）
## 结论
（一句话核心结论 + 置信度：高/中/低）
## 证据
（关键数据、命令输出摘录，宁缺毋滥）
## 反例/边界
（什么情况下不成立；没有就写「暂未发现」）
```

写入步骤：
1. 按内容选择 domain 目录（拿不准用 `cards/`）。
2. 文件名用结论的短 slug（小写字母/数字/连字符，如 `prefixlm-beats-causallm-hrm.md`）。
3. 写入卡片后，**必须更新 `INDEX.md`**：在对应域的分节下追加一行
   `- [标题](相对路径) — tags: a, b（日期）`。INDEX.md 不存在就创建并带上四域分节。

## search：检索知识库

用 ripgrep 全文检索（个人量级毫秒级，不要建索引/数据库）：

```bash
rg -i -l "关键词" ~/.kalo/knowledge/          # 命中文件
rg -i "关键词" ~/.kalo/knowledge/ -g '*.md'   # 带上下文
```

标签检索：`rg -l "tags:.*\btag\b" ~/.kalo/knowledge/`。
回答时给出命中卡片的**标题 + 结论段摘要 + 文件路径**，最多 5 张，按相关度排序。

## recall：会话开始时自动唤起

当用户的开场话题明显涉及训练实验、投资或数学探索时，先做一次针对性 search
（话题关键词 + 相关标签），把最相关的 3-5 张卡的「标题 + 结论」注入你的上下文，
再继续工作。检索为空就直接继续，不要编造不存在的卡片。
