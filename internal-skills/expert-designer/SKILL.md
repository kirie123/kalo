---
name: expert-designer
description: 创建数字专家或带主理人和独立成员的专家团（独立工作目录、记忆、技能、定时任务），也可引导导入 WorkBuddy 专家包。当用户说「新建专家」「创建专家团」「创建数字员工」时使用。
---

# expert-designer 数字专家创建引导

数字专家 = 注册表项 + 专家定义目录 + 目录里的 AGENTS.md 宪章。专家定义目录通过 `definitionDir` 注册，
提供角色、技能（`<definitionDir>/.kalo/skills/`）与隔离记忆（`<definitionDir>/.kalo/memory/`）。
每次任务的工作目录由用户单独选择，不能把定义目录作为默认工作目录。

你（当前这个普通会话）的职责是**把专家规划出来并落盘**，不是替它干活。

## 四步流程

### 1. 问清使命

与用户对话澄清，一次问完，不要挤牙膏：

- **干什么**：一句话使命（写进注册表的 `mission` 与宪章开头）
- **盯什么数据**：需要什么数据源/输入（决定要不要挂 market-data、feeds、watch 任务）
- **多久跑一次**：每日/每周/手动触发（决定 cron）
- **产出给谁看**：文件沉淀在哪、要不要飞书推送
- **一个专家还是专家团**：用户已说明成员分工时直接按团队处理，明确一个主理人和各成员边界。

### 2. 选目录、规划结构

- 确定专家定义目录（默认 `~/.kalo/agent/experts/<id>/`）。创建它。不要据此改变当前任务目录。
- 定义目录放角色、规则、技能与专家记忆。投资任务的 `broker/ decisions/ reviews/`、论文任务的
  `papers/ summaries/` 等业务数据，放在另外选择的任务目录中。
- 固定只有两件必需品（引擎约定，不要改名）：
  - `<definitionDir>/.kalo/skills/`：专家专属技能
  - `<definitionDir>/.kalo/memory/`：专家记忆（引擎自动用，手工建空目录即可）

### 3. 写宪章 + 注册

**`<definitionDir>/AGENTS.md`**（专家宪章，中文），至少包含：

- 使命一句话 + 职责边界（做什么、不做什么）
- 目录约定：每个子目录/文件放什么
- 工作纪律：数据从哪来、产出写到哪、什么情况下停下来问人
- 复盘节奏（如有）：多久回看一次、复盘产物放哪

**注册**：编辑 `~/.kalo/experts.json`（不存在则新建），追加：

```json
{
  "experts": [
    {
      "id": "trader-consumer",
      "name": "消费复苏投研",
      "definitionDir": "<专家定义目录的绝对路径>",
      "mission": "…一句话使命…",
      "createdAt": "2026-08-29",
      "enabled": true
    }
  ]
}
```

`id` 规则：1-64 位字母数字/`-`/`_`，稳定不改。写之前先读现有文件，**保留已有专家，只追加**。

### 专家团的额外定义

专家团仍是一个注册项；增加 `kind: "team"`、`entryAgent` 和 `members`，并把**同一个完整注册项**写到 `<definitionDir>/.kalo/expert.json`。例如在现有注册项上增加：

```json
{
  "kind": "team",
  "entryAgent": "editor-lead",
  "members": [
    { "id": "editor-lead", "name": "主编", "profession": "编排与验收", "agentPath": "agents/editor-lead.md" },
    { "id": "writer", "name": "作者", "profession": "撰稿", "agentPath": "agents/writer.md" }
  ]
}
```

每个 `agentPath` 都要创建真实文件，文件开头是 YAML frontmatter（`name` 必须等于成员 ID），其后写职责、输入、输出和交接规则：

```markdown
---
name: writer
description: 接收主编任务并撰稿
---
你是团队撰稿人。只执行收到的任务，产出落盘，最终回复完整返回主编。
```

定义目录 AGENTS.md 只写共享职责与纪律；主理人和成员各自的职责分别写入角色文件，避免所有成员都误认自己是主理人。团队共享定义目录的技能与记忆；成员有独立会话历史，执行时使用当前任务目录。主理人用 `agent(subagent_type="writer", prompt="完整任务与路径", tools=["read", "write"])` 派发，写文件/运行脚本分别显式授予 write/bash；工具结果自动回传，续写只传返回的 childId 到 resume，不能把成员 ID 当 childId。

已有 WorkBuddy 专家包时，优先让用户在「数字专家 → 导入」选择包根目录，或执行 `kalo --import-expert <目录>`。导入会保留技能、脚本、素材与角色正文，并安装到 `~/.kalo/agent/experts/<包名>/`；同名目录不覆盖。不要把包正文中的其他宿主工具名当成 Kalo 工具。

### 4. 配定时任务（需要才配）

编辑 `~/.kalo/agent/schedules.json` 的 `tasks` 数组，给专家的周期性工作建任务，
**每个任务带 `"expertId": "<专家id>"`**、`"cwd": "<独立任务目录>"`，cwd 不能指向专家定义目录：

- `watch`（零 token）：跑脚本，stdout 非空才推飞书。用于数据落盘、阈值告警、
  `broker.py verify` 这类机械活。
- `agent`（烧 token）：到点起无头专家会话跑 `prompt`。用于分析、决策、复盘。

写之前同样先读现有文件、保留已有任务。cron 是 5 字段本地时区（`分 时 日 月 周`）。

## 收尾

把规划结果汇总给用户确认：目录结构、宪章要点、定时任务表。用户点头后，
告诉TA去「数字专家」面板查看，或直接在面板里「开始会话」给专家下达第一条指令。

## 不做

- 不替专家执行它的日常工作（那是专家自己的会话/定时任务的事）。
- 任务产出写入任务目录，专家定义目录只存角色、技能和专家记忆。
- 投资类专家需要虚拟账号时，引导用户使用 `paper-broker` skill（账本放 `<workdir>/broker/`）。
