import type { InlineExtension } from "../core/extensions/types.ts";
import kaloSkillsExtension from "./kalo-skills/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import memoryExtension from "./memory/index.ts";
import skillExtension from "./skill/index.ts";
import webFetchExtension from "./webfetch/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "memory", factory: memoryExtension, hidden: true },
	{ name: "skill", factory: skillExtension, hidden: true },
	{ name: "kalo-skills", factory: kaloSkillsExtension, hidden: true },
	{ name: "webfetch", factory: webFetchExtension, hidden: true },
	{ name: "mcp", factory: mcpExtension, hidden: true },
];
