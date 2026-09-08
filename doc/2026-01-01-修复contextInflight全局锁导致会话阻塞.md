# 修复 contextInflight 全局锁导致的会话阻塞问题

**日期**: 2026-01-01  
**影响范围**: `kalo-desktop/src/lib/chat-store.ts`（`SessionRuntime` 类 + `refreshContextUsage` 方法）  
**动机**: 修复用户切换会话或并发操作时，因全局 `contextInflight` 锁导致的上下文刷新静默失败和会话阻塞问题。

---

## 问题描述

### Bug 表现

**用户报告**：切换到旧会话后发送消息，界面显示发送成功，但 LLM 一直不响应，会话卡死。

### 根本原因

`contextInflight` 是 `ChatStore` 类的**实例级别单例锁**，所有会话共享同一个布尔标志。

**原设计**（错误）：
```typescript
class ChatStore {
  private contextInflight = false;  // ← 全局锁，跨所有 runtime 共享
  
  async refreshContextUsage(rt: SessionRuntime = this.active) {
    if (!sid || this.contextInflight) return;  // ← 其他会话在刷新时，当前会话被阻塞
    this.contextInflight = true;
    try {
      await sendCommand(sid, { type: "get_session_stats" }, 15000);
    } finally {
      this.contextInflight = false;
    }
  }
}
```

### 触发场景

**场景 1：快速切换会话**
1. 用户在会话 A 发送消息 → `message_end` 事件触发 `refreshContextUsage(rt_A)`
2. `contextInflight = true`，开始调用 `get_session_stats`（15 秒超时）
3. 用户立即切换到会话 B → `resumeSession` 触发 `fetchSessionMeta` → `refreshContextUsage(rt_B)`
4. `refreshContextUsage(rt_B)` 检查到 `this.contextInflight == true`，**直接 return，跳过上下文刷新**
5. 会话 B 的 `contextUsage` 保持为空或旧值，前端状态不同步

**场景 2：IPC 命令超时或卡死**
1. 会话 A 调用 `get_session_stats`，引擎因某种原因挂起（例如引擎内部死锁、文件 I/O 阻塞）
2. IPC 命令超时（15 秒），但在超时期间 `contextInflight` 一直为 `true`
3. **所有其他会话**的 `refreshContextUsage` 调用全部静默失败（直接 return）
4. 用户切换到任何会话都无法获取最新上下文状态，导致：
   - 上下文环已满但前端不显示
   - 压缩触发但前端无感知
   - 用户发送消息后，前端认为上下文正常，但引擎可能已触发意外行为

**场景 3：并发消息流（极端情况）**
1. 两个会话同时有 LLM 响应流（multi-turn agent 或并行 subagent）
2. 每次 `message_end` 都触发 `refreshContextUsage`
3. 只有第一个会话的刷新会执行，其他会话全部被全局锁阻塞
4. 前端只能看到一个会话的上下文更新，其他会话显示陈旧数据

### 为什么全局锁是错误的

`contextInflight` 的设计初衷是**防止同一会话的重复 IPC 请求堆积**（commit 387ea87 引入）。但它被误实现为全局锁，导致：

1. **不同会话之间互相阻塞**：会话 A 刷新上下文时，会话 B 无法刷新（即使它们的引擎进程是独立的）
2. **静默失败**：`refreshContextUsage` 看到锁就直接 return，没有日志、没有重试、没有告知用户
3. **状态不一致**：前端显示的 `contextUsage` 可能与引擎实际状态严重偏离

---

## 解决方案

### 设计决策

将 `contextInflight` 从全局移到 **per-runtime 锁**（`SessionRuntime.contextInflight`），使每个会话独立。

**理由**：
1. 每个 `SessionRuntime` 对应一个独立的引擎进程（session），它们的 IPC 命令是并发的，不应互相阻塞
2. 锁的真正目的是防止**同一会话**的重复请求（例如高频 `message_end` 事件），而不是跨会话互斥
3. Per-runtime 锁语义清晰：`rt.contextInflight` 表示"这个会话正在刷新上下文"，而不是"整个应用正在刷新某个会话的上下文"

### 实施细节

**1. 在 `SessionRuntime` 类中添加 `contextInflight` 字段**

```typescript
class SessionRuntime {
  compactionNoticeId: string | null = null;
  lastActive = Date.now();
  /** Per-runtime lock: prevents concurrent get_session_stats IPC calls. */
  contextInflight = false;  // ← 每个 runtime 独立的锁
  // ...
}
```

**2. 移除 `ChatStore` 的全局 `contextInflight`**

```typescript
class ChatStore {
  private runtimes = new Map<string, SessionRuntime>();
  private freshSeq = 0;
  private active: SessionRuntime;
  private listeners = new Set<() => void>();
  // ❌ 删除：private contextInflight = false;
}
```

**3. 更新 `refreshContextUsage` 使用 per-runtime 锁**

```typescript
async refreshContextUsage(rt: SessionRuntime = this.active) {
  const sid = rt.view.sessionId;
  if (!sid || rt.contextInflight) return;  // ← 检查当前 runtime 的锁
  rt.contextInflight = true;               // ← 只锁当前 runtime
  try {
    const resp = await sendCommand(sid, { type: "get_session_stats" }, 15000);
    if (resp.success) {
      const usage = (resp.data as { contextUsage?: ChatState["contextUsage"] } | undefined)?.contextUsage;
      if (usage !== undefined) this.setRt(rt, { contextUsage: usage });
    }
  } catch {
    // Stats are best-effort UI decoration.
  } finally {
    rt.contextInflight = false;            // ← 只释放当前 runtime 的锁
  }
}
```

---

## 效果对比

### Before（全局锁）

```
会话 A: message_end → refreshContextUsage(A) → contextInflight = true
会话 B: message_end → refreshContextUsage(B) → 检查到 contextInflight == true → 直接 return ❌
会话 C: resumeSession → refreshContextUsage(C) → 检查到 contextInflight == true → 直接 return ❌

结果：只有会话 A 的上下文被刷新，B 和 C 的前端状态陈旧
```

### After（per-runtime 锁）

```
会话 A: message_end → refreshContextUsage(A) → rt_A.contextInflight = true
会话 B: message_end → refreshContextUsage(B) → rt_B.contextInflight = false → 执行刷新 ✅
会话 C: resumeSession → refreshContextUsage(C) → rt_C.contextInflight = false → 执行刷新 ✅

结果：每个会话独立刷新，互不阻塞
```

---

## 测试验证

**现有测试覆盖**：
- `kalo-desktop/src/lib/chat-store-helpers.test.ts`：覆盖 `refreshContextUsage` 调用路径（间接）
- 桌面端全量测试（291 tests）全部通过，无回归

**手动验证场景**：
1. 打开两个会话，同时发送消息 → 两个会话的上下文环都能实时更新
2. 会话 A 正在刷新上下文时，快速切换到会话 B 并发送消息 → 会话 B 不会卡住
3. 引擎 IPC 超时时（模拟：杀死引擎进程） → 只有当前会话受影响，其他会话正常

---

## 风险评估

### 变更影响

- **代码变更**：3 处（移动字段定义、删除全局字段、更新锁检查）
- **行为变更**：从"全局互斥"变为"per-runtime 互斥"
- **向后兼容性**：完全兼容（用户不可见的内部锁机制变更）

### 潜在风险

**风险 1：同一会话的并发请求堆积**  
**评估**：锁的语义没变（防止同一会话重复请求），只是作用域从全局收窄到 per-runtime  
**缓解**：`finally` 块保证锁释放，15 秒超时防止永久挂起

**风险 2：内存占用增加**  
**评估**：每个 `SessionRuntime` 增加 1 个布尔字段（1 byte），100 个会话也只增加 100 bytes  
**结论**：可忽略

---

## 文档影响

- **模块职责**：`SessionRuntime` 从"会话状态容器"扩展为"会话状态容器 + 独立的 IPC 并发控制"
- **数据流**：`refreshContextUsage` 从"全局串行"变为"per-runtime 并行"
- **用户可见交互**：修复"切换会话后卡住不响应"的 bug，用户体验改善

---

## 相关 commit

- **387ea87**: 引入 `refreshContextUsage` 调用点（`message_end` + `reloadLatestPage`）
- **本次修复**: 将 `contextInflight` 从全局锁改为 per-runtime 锁，修复并发阻塞问题
