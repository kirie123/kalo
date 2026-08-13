# Kalo

AI coding agent 桌面客户端：Tauri v2 + React 界面，通过子进程驱动 pi 引擎（NDJSON RPC 协议），Codex 风格 UI（明暗双主题）。

## 仓库结构

- [`kalo-desktop/`](kalo-desktop/) — 桌面端（Tauri v2 + React 18 + Tailwind）
- [`kalo-harness/`](kalo-harness/) — pi agent 引擎（fork 自 [earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)，MIT）

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
cd kalo-harness && npm ci --ignore-scripts && npm run build
cd ../kalo-desktop && npm install && npm run tauri dev
```

引擎打包与桌面端发布见 [kalo-desktop/README.md](kalo-desktop/README.md)。

## License

MIT（kalo-harness 沿用其上游 MIT 许可，见 kalo-harness/LICENSE）
