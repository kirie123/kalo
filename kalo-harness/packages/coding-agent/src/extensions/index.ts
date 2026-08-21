import type { InlineExtension } from "../core/extensions/types.ts";
import kaloJobsExtension from "./kalo-jobs/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import memoryExtension from "./memory/index.ts";
import sessionNamerExtension from "./session-namer/index.ts";
import skillExtension from "./skill/index.ts";
import subagentExtension from "./subagent/index.ts";
import todoExtension from "./todo/index.ts";
import webFetchExtension from "./webfetch/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "memory", factory: memoryExtension, hidden: true },
	{ name: "skill", factory: skillExtension, hidden: true },
	{ name: "kalo-jobs", factory: kaloJobsExtension, hidden: true },
	{ name: "webfetch", factory: webFetchExtension, hidden: true },
	{ name: "mcp", factory: mcpExtension, hidden: true },
	{ name: "subagent", factory: subagentExtension, hidden: true },
	{ name: "todo", factory: todoExtension, hidden: true },
	{ name: "session-namer", factory: sessionNamerExtension, hidden: true },
];
