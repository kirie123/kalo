# internal-skills — 随 Kalo 分发的内置技能

这里是纯 markdown。每个子目录是一个 skill，App 启动时会把
`internal-skills/<name>/**` 下的文件安装到用户全局 skills 根目录
`~/.kalo/skills/<name>/**`，安装后与用户自建 skill 完全同等（设置页 →
Skills 里可看、可改、可删）。

**改内置技能只需改这里的 markdown，不用重建引擎 exe，也不用重编 Rust。**

## 目录

| skill | 用途 |
| --- | --- |
| `knowledge/` | 个人知识库（`~/.kalo/knowledge/`）的存卡与检索规范 |
| `paper-reading/` | 精读论文 → 结构化笔记 + 长期记忆 |
| `web-research/` | 在线调研 → 结构化综述（arXiv / DuckDuckGo + web_fetch） |
| `experiment-runner/` | 按队列跑训练实验并记录结果 |
| `math/` | 数学推导 / 证明 / 猜想验证的协作规范 |
| `market-data/` | 金融取数层：源注册表 + Python CLI（宏观快照 / 历史分位数 / 财报下载） |
| `macro-pulse/` | 宏观风向：读 market-data 的历史给出环境刻画 |
| `filing-digest/` | 财报下载与分析：结构化指标先行，PDF 正文按需检索 |

`market-data/` 是这三者里唯一带脚本的（`md.py` + `lib/` + `sources.yaml` + `tests/`），
另两个是纯 markdown，通过绝对路径调它的 CLI。它的 Python 环境刻意放在数据目录
`~/.kalo/market/venv` 而不是 skill 目录里——akshare + pandas 几百 MB，不该跟着
skill 被复制来复制去，也不该进仓库。

顶层文件（比如这份 README）**不会**被安装，只有子目录里的内容会。所以一个
skill 可以是多文件的：`SKILL.md` 之外还能带脚本、模板等，整个子目录一起装过去。

## 安装与更新规则

安装逻辑在 [`kalo-desktop/src-tauri/src/internal_skills.rs`](../kalo-desktop/src-tauri/src/internal_skills.rs)，
每次 App 启动执行一遍。`~/.kalo/skills/.internal-skills.json` 记录上次安装时
写入内容的指纹，逐个文件判定：

| 目标文件状态 | 动作 |
| --- | --- |
| 不存在 | 安装 |
| 内容与上次安装的一致（用户没改过） | 用这里的新版本覆盖 |
| 内容与上次安装的不一致（用户改过） | 跳过，保留用户版本 |

也就是说：你在这里改一句话，所有没手动改过该 skill 的机器下次启动就拿到新版；
而用户在设置页里的编辑不会被升级冲掉。设置页 → Skills 的「重装内置技能」按钮
可以强制覆盖回这里的版本（会丢弃本地修改）。

从这里删掉一个 skill **不会**删除用户机器上已装好的副本。

## 新增一个内置技能

1. 建目录 `internal-skills/<name>/`，写 `SKILL.md`，frontmatter 至少要有
   `name:` 与 `description:`（`description` 决定引擎什么时候会想起用它）。
2. 重启 App（开发时 `bun run dev` 直接读仓库目录，不用打包）。

无需改任何代码或配置：安装器扫的是目录，`tauri.conf.json` 里
`"../../internal-skills": "internal-skills"` 已把整个目录打进安装包。
