import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { InvestmentClient } from "./client.ts";

const spec = Type.Object(
	{
		snapshotId: Type.String(),
		codes: Type.Optional(Type.Array(Type.String(), { minItems: 1, uniqueItems: true })),
		start: Type.String(),
		end: Type.String(),
		capital: Type.Number({ minimum: 1000, maximum: 100000000 }),
		lookback: Type.Integer({ minimum: 2, maximum: 120 }),
		rebalance: Type.Integer({ minimum: 1, maximum: 60 }),
		holdings: Type.Integer({ minimum: 1 }),
		commissionBps: Type.Number({ minimum: 0, maximum: 100 }),
		minimumFee: Type.Number({ minimum: 0, maximum: 1000 }),
		slippageBps: Type.Number({ minimum: 0, maximum: 100 }),
		flowFilter: Type.Boolean(),
	},
	{ additionalProperties: false },
);

function result(operation: string, value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: { type: "investment", operation, result: value },
	};
}

export default function investmentExtension(pi: ExtensionAPI): void {
	const port = Number(process.env.KALO_INVESTMENT_PORT);
	const token = process.env.KALO_INVESTMENT_TOKEN;
	if (
		!token ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		process.env.KALO_UNATTENDED === "1" ||
		process.env.KALO_TASK_ROLE
	)
		return;
	const client = new InvestmentClient(port, token);
	pi.registerTool({
		name: "investment_catalog",
		label: "投行数据与实验",
		description:
			"Read the Kalo investment panel's real snapshot coverage, ETF codes/categories, default backtest specifications and report summaries. Supports configured Shanghai-listed broad-market, STAR/ChiNext innovation and sector ETFs. Read before analysis or backtesting; never invent codes, snapshot IDs or dates. Old snapshots may contain only three broad-market ETFs; sync when requested ETFs are missing.",
		promptSnippet: "investment_catalog — 查询投行数据、可回测区间、默认参数及历史报告",
		promptGuidelines: [
			"用户要求同步 ETF、分析资金或回测时使用 investment 工具，结果会直接呈现在投行面板。不要用 shell 绕过工具或编造结果。",
			"先读 catalog；无数据时按用户的研究请求同步。沿用明确的快照 ID，完整说明默认参数与用户参数。unsupported 标的/策略应说明限制，不能静默替换。",
			"回测特定板块或双创时，从 catalog 按 category/name 选择实际代码写入 spec.codes，并使 holdings 不超过选池数量。资金工具返回全池，分析时按返回的 category 分组，说明实际覆盖；双创50覆盖科创板与创业板，不等于单独创业板ETF。",
		],
		parameters: Type.Object({}),
		async execute() {
			return result("catalog", await client.request({ operation: "catalog" }));
		},
	});
	pi.registerTool({
		name: "investment_sync",
		label: "同步投行免费数据",
		description:
			"Fetch real free ETF prices, fund shares and NAV into an immutable snapshot. Uses the same task slot as the investment panel. Waits up to 240 seconds; running means not finished. No provider account required.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(id, _params, signal, onUpdate) {
			const job = await client.run({ operation: "sync" }, id, 240, signal, (j) =>
				onUpdate?.(result("sync", { jobId: j.id, status: j.status, phase: j.phase })),
			);
			if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error ?? job.phase);
			return result("sync", job);
		},
	});
	pi.registerTool({
		name: "investment_flows",
		label: "分析 ETF 资金",
		description:
			"Calculate net-subscription estimates for a fixed snapshot over the latest 1, 5 or 20 trading days. Returns dated evidence, missing dates, coverage and ranking; opens the same snapshot/window in the panel. Units are yuan (CNY). Not exchange trading flow, gross subscriptions/redemptions, or a buy recommendation.",
		parameters: Type.Object({
			snapshotId: Type.String(),
			days: Type.Union([Type.Literal(1), Type.Literal(5), Type.Literal(20)]),
		}),
		async execute(_id, params) {
			return result("flows", await client.request({ operation: "flows", ...params }));
		},
	});
	pi.registerTool({
		name: "investment_backtest",
		label: "运行投行回测",
		description:
			"Run the Rust daily long-only ETF momentum rotation engine using a complete specification. Read investment_catalog first for a real defaultSpec and alter only parameters the user requested. Previous-close signal / next-open fills, 100-share lots, fees and slippage. flowFilter requires data observed before each historical decision and may fail; never silently disable it. Saved report appears in the panel. Waits up to 120 seconds.",
		parameters: Type.Object({ spec }),
		executionMode: "sequential",
		async execute(id, params, signal, onUpdate) {
			const job = await client.run({ operation: "backtest", spec: params.spec }, id, 120, signal, (j) =>
				onUpdate?.(result("backtest", { jobId: j.id, status: j.status, phase: j.phase })),
			);
			if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error ?? job.phase);
			return result("backtest", job);
		},
	});
	pi.registerTool({
		name: "investment_status",
		label: "读取投行任务结果",
		description:
			"Read a job started by this chat. waitSeconds optionally waits up to 600 seconds without shell polling. Completed results include snapshot/report IDs and evidence; failed or cancelled is not success.",
		parameters: Type.Object({
			jobId: Type.String(),
			waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 600 })),
		}),
		async execute(_id, params, signal) {
			return result("status", await client.wait(params.jobId, params.waitSeconds ?? 0, signal));
		},
	});
	pi.registerTool({
		name: "investment_cancel",
		label: "取消投行任务",
		description:
			"Cancel a running investment job started by this chat. Completed reports remain intact. The operator can also cancel from the panel.",
		parameters: Type.Object({ jobId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			return result("cancel", await client.request({ operation: "cancel", ...params }));
		},
	});
}
