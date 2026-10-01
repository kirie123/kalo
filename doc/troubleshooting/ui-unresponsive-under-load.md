# 高负载时输入框「看着正常、敲字没反应」（进程被效率模式/自身渲染开销饿死，不是被禁用）

## 症状

- 让 Kalo 跑模型训练（或任何吃满 CPU 的任务）时，等待期间对话输入框**外观一切正常**，但敲键盘没有任何反应：没有字符、没有对话框、没有报错。
- 任务管理器的内存压力通常同时存在（如 WSL `vmmem` 占几 GB 到十几 GB）。
- 停止训练或等负载下去后，界面自行恢复，输入又能打字——所以很容易被当成"偶发卡顿"忽略。
- 事件日志里能查到 `kalo.exe` 的 Application Hang：

  ```
  级别: 错误  来源: Application Hang  事件 ID: 1002
  应用程序 kalo.exe ... 已停止与 Windows 的交互
  AppHangXProcB1 ... msedgewebview2.exe
  ```

## 快速排查

1. 先在代码里确认"禁用"只有一条路：`InputBox.tsx` 的 `disabled={chat.hasPendingAsk}`。若屏幕上没有 `AskUserPanel` 问题卡，就不是被禁用，而是界面没在响应。
2. 复现时看任务管理器：`com.kalo.dev` 的 `msedgewebview2.exe` 渲染进程是否带**效率模式**标记；敲字时该进程 CPU 是否为 0%、内存是否骤降（被换页裁剪的迹象）。
3. 查 Application 事件日志有没有 `kalo.exe` / `msedgewebview2.exe` 的 1002（Application Hang）。
4. 量体渲染开销：把当时那段流式输出长度拿去跑一次 remark/rehype 全量解析（40 KB ≈ 65 ms，80 KB ≈ 141 ms），对照 store 的 ~20 次/秒 flush —— 每 delta 全量重解析才是主因。
5. 排除"巨块 `<pre>` 拖垮布局"这条：256 KB 文本在 `<pre white-space:pre-wrap>` 里只有 9–17 ms 布局，不是主因。

## 根因

两条原因叠加，都是"让 UI 进程排不上队"，不是功能开关：

1. **系统侧**：i9-13900KF 这类 P+E 混合核机器上，Windows 会给**非前台**窗口应用「效率模式」（EcoQoS：绑 E 核 + 限频）。训练把线程铺满时，被压到 E 核的 WebView2 渲染进程最先饿死；叠加内存压力，它的工作集被裁剪，切回来时渲染进程还在换页——画面停在最后一帧，输入事件没人处理。
2. **Kalo 自身**：流式输出时每个 delta 都把整段累计 Markdown 重新解析一遍（`memo` 只挡已结束的块），40 KB 时均 49 ms / 最差 136 ms，而 delta 每秒来好几次 → 主线程自己就被吃满，即使系统不饿它也没法及时回显。

另有一个**独立的真 bug**（同一症状的窄路径）：时间线为空 + 有待答提问时，`AskUserPanel` 只在 `ChatView` 渲染、空会话走 `EmptyState`，于是输入框被禁用却没有任何问题卡——看着完全正常，敲字则毫无反应。

## 修复

- 桌面端 `src-tauri/src/priority.rs`（Windows 窄适配层）：自身进程与所有 `msedgewebview2.exe` 后代 `SetPriorityClass(ABOVE_NORMAL)`，并用 `SetProcessInformation(ProcessPowerThrottling, EXECUTION_SPEED=0)` 关掉 EcoQoS；后台线程前 10 轮每 500 ms、之后每 5 s 重扫，覆盖懒创建/崩溃重建的渲染进程。**不抬 pi sidecar / gateway**（它们和用户的任务是同侪）。
- `src/lib/stream-render.ts` + `StreamingText.tsx`：流式块 300 ms 节流（前沿提交 + 尾部补提交），超过 24 KB 期间先按纯文本渲染、流结束再做完整 Markdown。
- `src/lib/tool-output.ts` + `ToolCallGroup.OutputPre`：工具输出保留头尾（默认 400 行 / 20 000 字符），中间省略并给「显示全部」。
- `EmptyState` 也渲染 `AskUserPanel`；`InputBox` 的禁用态加说明行 + 置灰，并支持"打字即聚焦"（命中测试保证有浮层覆盖时不抢焦点）。

详见 `doc/2026-10-01-高负载下界面响应与输入可见性.md`。

## 验证

- 复现条件：跑满 CPU 的任务 + 长回答流式输出，输入框打字应当跟手（改动前会明显迟滞）。
- 长回答（> 24 KB）流式期间界面可交互，结束后排版与改动前一致。
- 大输出卡片显示「已省略 N 字符」+「显示全部」可展开全文。
- 空会话触发一次提问：问题卡可见。
- 点消息区（不点输入框）直接敲字：字符落进输入框；点按钮后按空格：激活按钮。
- `cargo test priority::`、`npx vitest run src/lib/stream-render.test.ts src/lib/tool-output.test.ts` 通过。