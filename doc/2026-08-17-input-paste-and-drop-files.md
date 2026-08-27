# 输入框支持粘贴文件与拖拽文件

## 目标

输入框现在只支持两种加附件的方式：

- 点「+」走 `@tauri-apps/plugin-dialog` 的 `open()`，拿到路径后调 `read_attachment`；
- `Ctrl+V` 粘贴**图片**（`clipboardData.items` 里 `image/*`），走 `addImageAttachment`。

希望把「像粘贴图片一样」的体验推广到任意支持的附件类型：

1. 从资源管理器复制文件后，在输入框 `Ctrl+V` 直接变成附件；
2. 把文件从资源管理器拖到窗口里，落下即变成附件。

两者最终都产出和「+」选文件一样的 `AttachmentDraft`（图片 → base64，文档/文本 → 抽取后的文本）。

> **已被 [2026-08-20-附件改为路径引用](./2026-08-20-附件改为路径引用.md) 取代的部分**：
> 非图片附件不再抽取正文，`AttachmentDraft` 的 text 变体换成 `{ kind: "file", name, path }`；
> `read_attachment_bytes` 改名 `save_attachment_bytes`，落盘到 `~/.kalo/attachments/` 且不再删除。
> 下文的「后端：`read_attachment_bytes`」小节与「影响面」只反映 08-17 当时的设计。
> 拖拽与粘贴的**入口**逻辑（`onDragDropEvent`、`clipboardData.files`、附件名去重）仍然有效。

## 关键约束

- **拖拽拿不到 HTML5 事件**：Tauri v2 `dragDropEnabled` 默认为 true，webview 会吞掉 `dragover`/`drop`。必须用
  `getCurrentWebview().onDragDropEvent()`，它给的是 `enter | over | drop | leave` 加**真实文件路径数组**。
  因此拖拽路径可以完全复用 `chatStore.addAttachments(paths)`，后端零改动。
- **粘贴拿不到路径**：`clipboardData.files` 里的 `File` 只有 name + 字节，没有磁盘路径（浏览器安全模型）。
  所以粘贴分支需要一条新的按字节读取的命令。

## 设计

### 后端：`read_attachment_bytes`

`files.rs` 新增：

```rust
pub fn read_attachment_bytes(name: &str, data_base64: &str) -> Result<AttachmentData, String>
```

实现方式是把字节落到 `%TEMP%/kalo-paste/<unique>/<sanitized name>`，再调用既有的 `read_attachment`，
读完删掉临时目录。这样 pdf / xlsx / docx / pptx 的抽取逻辑（都是基于路径的 API）不用改写成流式版本，
扩展名分派、大小上限、截断规则全部一致。

- 唯一目录名 = `pid-纳秒-自增计数`，避免同名文件互相覆盖。
- 文件名做净化（去掉路径分隔符与 `..`），只保留 basename。
- 粘贴总量上限 `MAX_PASTE_BYTES = 32MB`，超过直接报错（图片仍另有 10MB 上限）。
- 无论成功失败都清理临时目录（best-effort）。

注册为 `#[tauri::command(async)] read_attachment_bytes(name, data_base64)`。

### 前端

- `pi-bridge.ts`：`readAttachmentBytes(name, dataBase64)`。
- `chat-store.ts`：
  - 新增 `addFiles(files: File[])`：逐个读成 base64，`image/*` 走内存直挂（免一次 IPC 往返 + 免落盘），
    其余走 `readAttachmentBytes`；失败 toast，与 `addAttachments` 行为一致。
    截图这类裸位图在 webview 里名字统一是 `image.png`，仍沿用原来的「粘贴图片-N.png」命名；
    真实文件保留原名。`addImageAttachment` 被 `addFiles` 取代，删除。
  - **附件名去重**：`attachments` 目前以 `name` 作 React key、也以 `name` 作删除依据，
    拖入两个同名文件会互相打架。抽出 `uniqueName()`，重名追加 `(2)`、`(3)`。
    `addAttachments` / `addImageAttachment` / `addFiles` 统一走它。
- `InputBox.tsx`：
  - `onPaste` 改为先看 `clipboardData.files`；非空则 `preventDefault()` 并交给 `addFiles`，
    没有文件时不拦截（保持纯文本粘贴）。原来的 `items` + `image/*` 分支被 `files` 覆盖，删掉。
  - 新增 `useEffect` 订阅 `onDragDropEvent`：`enter`/`over` 置 `dragging=true`，`leave` 清除，
    `drop` 时清除并 `addAttachments(paths)`。
  - `dragging` 时在输入框卡片上盖一层虚线边框提示「松开以添加附件」。

### 落点选择

拖拽命中判定用**整窗**而不是只认输入框矩形：`onDragDropEvent` 给的是物理像素坐标，
和 DOM 矩形比对要自己乘 `devicePixelRatio`，且聊天区有缩放，容易错位；
而「拖到窗口任意位置都加附件」也是聊天类应用的通行行为。提示层仍画在输入框上，指向明确。

拖进来的是目录时，`read_attachment` 会返回 `not a file`，走既有的 warning toast。

## 影响面

- 新增 Rust 命令一个，无新依赖。
- `AttachmentDraft` 结构不变，`sendPrompt` 的消费逻辑不变。
- placeholder 文案更新为提示可粘贴/拖拽文件。
