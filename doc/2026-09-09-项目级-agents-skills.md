# 项目级 `.agents/skills` 加载

## 目标

Kalo 桌面端启动会话引擎时，除用户级 `~/.kalo/skills/` 与既有项目配置外，还自动发现当前工作目录下的 `.agents/skills/`。该目录采用中性的 Agent Skills 布局，能够随项目版本管理并被其他兼容 Agent 复用。

## 目录契约

```text
<工作目录>/.agents/skills/<skill-name>/SKILL.md
```

每个 skill 使用 Agent Skills frontmatter，至少包含 `description`；`name` 可省略并回退为父目录名。skill 内引用的相对路径以 `SKILL.md` 所在目录为基准。

本次只自动加载当前工作目录的 `.agents/skills/`，不从桌面端额外注入工作目录祖先路径。harness 自身的交互模式仍可保留其原有祖先目录发现语义。

## 加载流程

1. Rust 会话层以用户选择的工作目录作为 sidecar 的 `current_dir`。
2. 若 `<工作目录>/.agents/skills` 是目录，启动参数追加 `--skill <绝对路径>`。
3. harness 将该显式路径作为 skill 资源扫描；目录不存在时不追加参数，也不产生告警。
4. skill 仍经过 harness 的 frontmatter 校验、忽略规则、名称碰撞与真实路径去重逻辑。

## 安全边界

桌面端使用无交互 RPC 模式，不能展示 harness 的项目目录信任确认。不得用全局 `--approve` 解决该问题，因为它会同时放行工作目录中的设置、扩展、主题和系统提示。

`.agents/skills` 通过窄化的 `--skill` 参数显式加载，只增加 Markdown 指令资源，不改变其他项目资源的信任状态，也不执行扩展代码。工具调用继续受 Kalo 权限模式约束。

路径必须由 Rust `Command::arg` 传入，不做字符串拼接，以兼容 Windows 空格、Unicode 和反斜杠路径。

## 优先级与冲突

沿用 harness 既有 skill 合并规则：先出现的同名 skill 生效，后出现的记录 collision diagnostic。显式 `.agents/skills` 路径不引入新的冲突规则。

## 验证

- 工作目录存在 `.agents/skills` 时，sidecar 参数包含 `--skill` 与该目录绝对路径。
- 目录不存在或同名路径不是目录时，不追加参数。
- Windows 风格含空格路径作为单个参数传递。
- 运行 Rust 单测、harness 定向 skill 测试及仓库 changed-aware 检查。
