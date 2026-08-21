/**
 * Todo extension — gives the model a todo_write tool for planning multi-step work.
 *
 * Whole-list replacement: every call carries the COMPLETE list and replaces the
 * previous one. There are no per-item edits, so the model never has to remember
 * item ids across a compaction — it just restates the current plan, which it
 * already knows. The snapshot rides `AgentToolResult.details`, so it lands in
 * the session jsonl and reaches the desktop client unchanged, and branching
 * automatically yields the list as it stood at that point in history.
 *
 * Design: doc/2026-08-21-todo-write-任务清单.md
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const STATUSES = ["pending", "in_progress", "completed"] as const;

type TodoStatus = (typeof STATUSES)[number];

interface TodoItem {
	content: string;
	status: TodoStatus;
}

interface TodoCounts {
	pending: number;
	inProgress: number;
	completed: number;
}

interface TodoDetails {
	todos: TodoItem[];
	counts: TodoCounts;
}

const TodoParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "任务内容，一句祈使句" }),
			status: StringEnum(STATUSES, { description: "pending 未开始 | in_progress 正在做 | completed 已完成" }),
		}),
		{ description: "完整的任务清单，整表替换上一版" },
	),
});

/**
 * Validate what the schema can't express and canonicalize: trimmed non-empty
 * unique content, at most one in_progress. Throwing (rather than silently
 * fixing) is deliberate — the model learns the rule from the error, whereas a
 * silent correction lets it keep writing broken lists forever.
 */
function toTodoList(raw: { content: string; status: TodoStatus }[]): TodoItem[] {
	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	let active = 0;
	for (const item of raw) {
		const content = item.content.trim();
		if (content.length === 0) throw new Error("todo_write：content 不能为空");
		if (seen.has(content)) throw new Error(`todo_write：任务重复 ${JSON.stringify(content)}`);
		seen.add(content);
		if (item.status === "in_progress") active++;
		todos.push({ content, status: item.status });
	}
	if (active > 1) throw new Error(`todo_write：同时最多一条 in_progress（当前 ${active} 条）`);
	return todos;
}

function countBy(todos: TodoItem[]): TodoCounts {
	return {
		pending: todos.filter((t) => t.status === "pending").length,
		inProgress: todos.filter((t) => t.status === "in_progress").length,
		completed: todos.filter((t) => t.status === "completed").length,
	};
}

export default function todoExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo_write",
		label: "Todo",
		description:
			"Record and update a structured task list for the current work. Send the ENTIRE list every call — " +
			"it REPLACES the previous list (no partial updates, no per-item edits). Use it to plan multi-step " +
			"work and show progress: add one todo per concrete step before you start. Keep AT MOST ONE todo " +
			"in_progress at a time; while work remains, exactly one task should be in_progress. Mark a todo " +
			"completed the moment it is done (do not batch completions). Skip the list for trivial single-step tasks.",
		promptSnippet: "todo_write(todos) — 记录/更新当前工作的任务清单（整表替换）",
		promptGuidelines: [
			"多步骤任务（3 步以上）开工前先用 todo_write 列出计划，每完成一步立刻更新状态",
			"todo_write 每次传完整清单覆盖上一版；同时只保留一条 in_progress，单步小任务不必建清单",
		],
		parameters: TodoParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const todos = toTodoList(params.todos);
			const counts = countBy(todos);
			return {
				content: [
					{
						type: "text",
						text: `任务清单已更新：${counts.completed} 已完成，${counts.inProgress} 进行中，${counts.pending} 待办。`,
					},
				],
				details: { todos, counts } satisfies TodoDetails,
			};
		},

		renderCall(args, theme, _context) {
			const total = args.todos.length;
			const done = args.todos.filter((t) => t.status === "completed").length;
			return new Text(
				theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${done}/${total} 已完成`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			const { todos, counts } = details;
			if (todos.length === 0) return new Text(theme.fg("dim", "清单已清空"), 0, 0);

			// Collapsed: the finished ones are noise, the active one is the point.
			const shown = expanded ? todos : todos.filter((t) => t.status !== "completed");
			let text = theme.fg("muted", `${counts.completed}/${todos.length} 已完成`);
			for (const todo of shown) {
				const mark =
					todo.status === "completed"
						? theme.fg("success", "✓")
						: todo.status === "in_progress"
							? theme.fg("accent", "▶")
							: theme.fg("dim", "○");
				const body = todo.status === "completed" ? theme.fg("dim", todo.content) : theme.fg("muted", todo.content);
				text += `\n${mark} ${body}`;
			}
			if (!expanded && counts.completed > 0) {
				text += `\n${theme.fg("dim", `… ${counts.completed} 条已完成`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
