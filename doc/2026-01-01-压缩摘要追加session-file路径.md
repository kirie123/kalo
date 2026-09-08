# 压缩摘要末尾追加 Session File 路径引用

**日期**: 2026-01-01  
**影响范围**: `kalo-harness/packages/coding-agent/src/core/compaction/compaction.ts`（`compact` 函数）  
**动机**: 压缩后的摘要是 LLM 后续对话的唯一上下文，当摘要中的信息不足时（例如需要完整错误堆栈、详细工具参数、原始 thinking），LLM 无法自行获取更多细节。需要在摘要末尾告知 LLM 原始会话文件的位置和读取方法。

---

## 问题分析

### 当前压缩摘要的内容

1. **LLM 生成的结构化摘要**（Goal / Progress / Decisions / Next Steps / Critical Context）
2. **文件操作列表**（`<read-files>` / `<modified-files>` XML 标签）

**缺失的信息**：
- 原始会话文件的路径（`.jsonl` 格式）
- LLM 如何读取原始会话的指引

### 用户场景

**场景 1**：用户问"之前那个错误的完整堆栈是什么？"  
- 摘要里只保留了错误概要（"构建失败"），完整堆栈被压缩掉了
- LLM 无法回答，只能说"摘要中没有详细信息"

**场景 2**：用户问"我们调用 `read` 工具时用的是哪个路径？"  
- 摘要里只说"读取了配置文件"，具体路径在 tool call 的 arguments 里
- LLM 无法回答，因为 arguments 细节被压缩掉了

**期望行为**：LLM 看到摘要末尾的 session file 路径，主动调用 `read` 工具读取相关行，获取完整细节。

---

## 解决方案：在摘要末尾追加 Session File 引用

### 改动位置

`compaction.ts` 的 `compact()` 函数（900-910 行）

### 改动内容

**1. 新增可选参数 `sessionFile?: string`**

```typescript
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionFile?: string,  // ← 新增
): Promise<CompactionResult>
```

**2. 在摘要末尾追加 session file 引用**

```typescript
// Compute file lists and append to summary
const { readFiles, modifiedFiles } = computeFileLists(fileOps);
summary += formatFileOperations(readFiles, modifiedFiles);

// Append session file reference if available
if (sessionFile) {
	summary += `\n\n<session-file>\n${sessionFile}\n</session-file>\n\n`;
	summary +=
		`**Note for Assistant**: This summary represents a compressed checkpoint. ` +
		`The original conversation is stored at the path above in JSONL format. ` +
		`If you need more specific details (exact tool arguments, full error messages, raw thinking, etc.), ` +
		`you can read segments of the session file using the \`read\` tool with \`offset\` and \`limit\` options. ` +
		`Each line is a JSON object with type/role/content/timestamp fields.`;
}
```

**3. 在两处调用点传入 `sessionFile`**

`agent-session.ts` 的两处 `compact()` 调用：

- **自动压缩**（`_runAutoCompaction` 行 2170）：
  ```typescript
  const compactResult = await compact(
  	preparation,
  	requestModel,
  	apiKey,
  	headers,
  	undefined,
  	this._autoCompactionAbortController.signal,
  	this.thinkingLevel,
  	this.agent.streamFunction,
  	env,
  	this.settingsManager.getRetrySettings(),
  	this._summarizationRetryCallbacks({ source: "compaction", reason }),
  	this.sessionFile,  // ← 传递
  );
  ```

- **手动压缩**（`compactManual` 行 1874）：
  ```typescript
  const result = await compact(
  	preparation,
  	requestModel,
  	apiKey,
  	headers,
  	customInstructions,
  	this._compactionAbortController.signal,
  	this.thinkingLevel,
  	this.agent.streamFunction,
  	env,
  	this.settingsManager.getRetrySettings(),
  	this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
  	this.sessionFile,  // ← 传递
  );
  ```

---

## 效果示例

### 压缩后的 summary（追加部分）

```markdown
<read-files>
src/utils.ts
src/config.ts
</read-files>

<modified-files>
src/main.ts
</modified-files>

<session-file>
~/.kalo/sessions/abc123-def456.jsonl
</session-file>

**Note for Assistant**: This summary represents a compressed checkpoint. The original conversation is stored at the path above in JSONL format. If you need more specific details (exact tool arguments, full error messages, raw thinking, etc.), you can read segments of the session file using the `read` tool with `offset` and `limit` options. Each line is a JSON object with type/role/content/timestamp fields.
```

### LLM 后续行为示例

```
用户: 之前那个错误的完整堆栈是什么？

Assistant (thinking): 摘要里说有个错误但细节被压缩了。
我看到 session file 在 ~/.kalo/sessions/abc123-def456.jsonl，
压缩点在第 45 行（firstKeptEntryId 对应的行数）。
错误应该在压缩前的消息里，我可以读取第 30-45 行找到 assistant 的 error 消息。

[调用 read(path="~/.kalo/sessions/abc123-def456.jsonl", offset=30, limit=15)]
[找到 line 42: {"type":"message","message":{"role":"assistant","stopReason":"error",...}}]
[解析 JSON 提取完整错误堆栈]

完整错误堆栈如下：
Error: Module not found: 'react-dom'
  at resolveModule (webpack.js:123)
  at ...
```

---

## 关键特性

1. **顺序正确**：session file 引用在文件操作列表之后（先展示 `<read-files>`/`<modified-files>`，再展示 `<session-file>`）
2. **仅当可用时追加**：如果 `sessionFile` 为 `undefined`（例如 sessions 功能被禁用），不追加引用
3. **完整指引**：告知 LLM：
   - 这是一个压缩检查点
   - 原始会话在 JSONL 文件里
   - 可用 `read` 工具读取（`offset` + `limit` 分段读取）
   - 每行是一个 JSON 对象（包含 type/role/content/timestamp 字段）

---

## 测试

**新增测试文件**：`packages/coding-agent/test/compaction-session-file-reference.test.ts`

**覆盖场景**：
1. `sessionFile` 提供时，摘要末尾包含 `<session-file>` XML 标签 + 工具提示
2. `sessionFile` 为 `undefined` 时，摘要末尾不包含引用
3. session file 引用在文件操作列表之后（顺序验证）

**测试结果**：3 个测试全部通过

---

## 影响评估

### 用户可见行为

- **Before**：压缩后 LLM 只能看到摘要，无法获取更多细节
- **After**：LLM 看到 session file 路径和读取指引，可以主动调用 `read` 工具获取原始细节

### 性能影响

- 摘要末尾增加约 300 字符（XML 标签 + 工具提示）
- 对压缩性能无影响（只是字符串追加）
- LLM 后续可能增加 `read` 工具调用（但这是按需的，只有用户问到细节时才会触发）

### 兼容性

- 向后兼容：`sessionFile` 是可选参数，不传入时行为不变
- 前端展示：摘要末尾的 `<session-file>` 和提示会直接显示在压缩气泡的可展开内容里（配合前端"压缩气泡可展开"功能）

---

## 文档影响

- **模块职责**：`compact()` 从"生成摘要 + 追加文件列表"扩展为"生成摘要 + 追加文件列表 + 追加 session file 引用"
- **数据流**：`agent-session.ts` 通过 `this.sessionFile` 传递会话文件路径到 `compact()`
- **用户可见交互**：压缩气泡可展开后，末尾显示 session file 路径和 LLM 自助读取指引
