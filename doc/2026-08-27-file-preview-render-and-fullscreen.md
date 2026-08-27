# 文件预览：代码语法高亮 + 全屏退出修复

日期：2026-08-27

## 问题

1. **全屏出不来（用户报 bug）**：FilePanel 的预览全屏后，退出全屏的按钮其实存在，
   但只是一个 12px 的暗色图标，无可发现性；也没有 Esc 处理。用户反馈"没有任何
   手段退出全屏"。（FileViewerModal 早有 Esc 逐级退出，FilePanel 漏了。）
2. **代码文件渲染差**：`.py/.ts/.rs` 等所有文本文件走 `PlainText` 纯等宽文本，
   无语法高亮。其余格式此前已覆盖：markdown（react-markdown）、图片（data URL +
   lightbox）、docx/xlsx（自研 OOXML reader）、pdf（webview 内置查看器）。

## 方案

### 全屏退出（FilePanel.tsx）

- 全屏时挂 Esc 监听：Esc → 退出全屏（不回退到关闭预览；关闭用 header 的 ×）。
  模式对齐 `FileViewerModal.tsx:20-29`。
- `PreviewHeader` 在全屏态把图标按钮换成**带文字的按钮**：图标 + "退出全屏" +
  Esc 提示（title）。窗口控制区本来就还在：TitleBar 是 `z-[100]`，覆盖层 z-50
  压在它下面，拖动区与最小化/关闭始终可达。

### 代码高亮（file-kind.ts / FilePreview.tsx / AssistantMessage.tsx）

- `file-kind.ts` 新增 `codeLanguage(path)`：扩展名/文件名 → highlight.js 语言 id
  （ts/py/rs/go/java/c/cpp/json/yaml/toml(→ini)/sh/sql/css/xml 等；Makefile/
  Dockerfile 走 basename）。映射表只列候选，运行时 `hljs.getLanguage` 不存在即
  回退纯文本，不引入新依赖。
- `AssistantMessage.tsx` 的 `highlight()`（带 200 条 LRU 缓存）改为 export，复用。
- `FilePreview.tsx` 新增 `CodeText`：有语言 → 高亮渲染（新增 `.file-code` CSS，
  复用 github-dark 主题底色）；无语言（txt/log/未知）→ 维持原 `PlainText`，
  避免 highlightAuto 对散文乱上色。
- markdown / docx 的"源码"视图一并从 PlainText 换成 `CodeText(lang=markdown)`。

## 边界

- 不加 pdfjs/mammoth 等新依赖（pdf 走 webview 内置、docx 自研已可用；仓库约定
  离线可装，`zip.ts` 注释明确不引 npm 依赖）。
- SVG 维持按文本预览（file-kind 注释里的既定取舍：代码工具里源码比渲染有用）。
- 不做行号、小地图——保持最小改动。
