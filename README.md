# Kalo

AI coding agent 桌面客户端：Tauri v2 + React 界面，Codex 风格 UI（明暗双主题）。

> Kalo 基于 [pi](https://github.com/earendil-works/pi) agent 引擎构建——桌面端通过子进程驱动 `pi --mode rpc`，使用其 NDJSON RPC 协议通信。`kalo-harness/` 是 pi 的 vendored 源码（MIT）。

## 为什么做 Kalo

**构建一个属于你自己的桌面端 Agent。**

市面上的 Agent 客户端层出不穷，但都是别人的产品：界面改不了、数据在别人手里、能力边界由厂商划定。Kalo 想做的是另一件事——一个你可以完全拥有、自由改造的个人 Agent 桌面端：

- **用于个人学习**：随时追问、让 Agent 带你读代码、读文档，把"查资料"变成"对话式探索"
- **用于工作开发**：接入自己的模型或中转服务，跑在你自己的项目目录里，工具调用、diff、上下文占用全都看得见
- **用于沉淀知识**：所有会话以 JSONL 落盘在本地，可回溯、可检索、可二次加工，长期使用下来就是你自己的知识库

引擎与界面解耦（pi 引擎 + NDJSON RPC 协议）：你可以换引擎、改界面、加能力，把它打磨成你想要的样子。这也是 Kalo 开源的原因——欢迎 fork，做出属于你自己的 Agent。

## 仓库结构

- [`kalo-desktop/`](kalo-desktop/) — 桌面端（Tauri v2 + React 18 + Tailwind）
- [`kalo-harness/`](kalo-harness/) — [pi agent](https://github.com/earendil-works/pi) 引擎源码

## 功能

- 会话流式输出、工具调用折叠展示、edit 行级 diff 渲染
- 多项目管理 + 历史会话恢复（分段加载）
- 模型可视化配置（自定义 provider / baseUrl / API Key，写入引擎的 models.json / auth.json）
- 附件（图片 / PDF / Excel / Word / PPT / 文本）
- 文件面板（目录树浏览 + 内容预览）
- 上下文占用圆环 + 一键压缩
- Skills 管理

## 快速开始

```bash
# 首次：安装依赖并构建引擎
bun run setup

# 调试启动（vite + tauri dev）
bun run dev

# 构建 Windows 安装包（NSIS，输出在 kalo-desktop/src-tauri/target/release/bundle/）
bun run build

# 仅重新构建引擎 exe（kalo-harness → kalo-desktop/src-tauri/binaries/）
bun run build:engine
```

> 需要 [Bun](https://bun.sh)、Node ≥ 22 与 Rust 工具链（MSVC）。各子目录也可用 npm 单独操作，详见 [kalo-desktop/README.md](kalo-desktop/README.md)。

## License

MIT（kalo-harness 沿用其上游 [pi](https://github.com/earendil-works/pi) 的 MIT 许可，见 kalo-harness/LICENSE）
