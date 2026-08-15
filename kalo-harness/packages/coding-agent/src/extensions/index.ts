import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import memoryExtension from "./memory/index.ts";
import skillExtension from "./skill/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "memory", factory: memoryExtension, hidden: true },
	{ name: "skill", factory: skillExtension, hidden: true },
];
