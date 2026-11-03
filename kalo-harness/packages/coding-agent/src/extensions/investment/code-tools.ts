import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { InvestmentClient } from "./client.ts";

function result(operation: string, value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: { type: "investment", operation, result: value },
	};
}
export function registerCodeTools(pi: ExtensionAPI, client: InvestmentClient): void {
	pi.registerTool({
		name: "investment_margin_sync",
		label: "同步两融数据",
		description:
			"Fetch official SSE/SZSE daily margin financing and securities lending balances, purchases, volumes and Hikvision detail for up to 11 published trading dates. No account needed. Data appears in the margin panel and catalog.marginSnapshots. Money is CNY; SZSE rounding precision is explicitly recorded. Balance change is not ETF inflow; missing repayment is null. Observation time is not historical publication time; not available as backtest signals. Waits up to 240 seconds.",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(id, _params, signal, onUpdate) {
			const job = await client.run({ operation: "marginSync" }, id, 240, signal, (j) =>
				onUpdate?.(result("marginSync", j)),
			);
			if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error ?? job.phase);
			return result("marginSync", job);
		},
	});
	pi.registerTool({
		name: "investment_market_sync",
		label: "同步分钟研究数据",
		description:
			"Fetch and validate a frozen 5-minute stock dataset for 002415.SZ (Hikvision). Free recent window only, excludes current and incomplete boundary sessions; validates session gaps and corporate actions against daily prices. Read catalog first. Result appears in the code strategy panel. Waits up to 120 seconds.",
		promptGuidelines: [
			"海康威视做T或KDJ等自定义策略使用分钟数据与代码回测工具，不得静默替换成ETF动量。先查询catalog的supportedMarketData、strategyRuntime与defaultSpec。",
			"策略代码使用Rhai的fn on_bar(ctx)，只看已完成K线；遵守T+1底仓与次根成交。报告区分组合总收益和相对持有增益，不把短窗口实验称为稳健盈利。",
		],
		parameters: Type.Object(
			{ code: Type.Literal("002415.SZ"), timeframe: Type.Literal("5m") },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(id, params, signal, onUpdate) {
			const job = await client.run({ operation: "marketSync", ...params }, id, 120, signal, (j) =>
				onUpdate?.(result("marketSync", j)),
			);
			if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error ?? job.phase);
			return result("marketSync", job);
		},
	});
	pi.registerTool({
		name: "investment_script_backtest",
		label: "运行代码策略回测",
		description:
			"Run custom Rhai strategy code in the Rust event-driven engine. Read catalog for dataset ID, defaultSpec, complete on_bar(ctx) API and example. Supports user-written functions, conditions and persistent ctx.state; return {side: hold|buy|sell, quantity: integer shares, state: object}. No files/network/import/time. Trades at NEXT bar open with T+1 sellable inventory, base position, fees, stamp tax, transfer fees and slippage. All source and parameters are saved in the panel report. Never substitute a canned momentum strategy. Waits up to 120 seconds.",
		parameters: Type.Object(
			{
				spec: Type.Object(
					{
						datasetId: Type.String(),
						title: Type.String({ minLength: 1, maxLength: 100 }),
						source: Type.String({ minLength: 1, maxLength: 16384 }),
						start: Type.String(),
						end: Type.String(),
						cash: Type.Number({ minimum: 0, maximum: 100000000 }),
						basePosition: Type.Integer({ minimum: 0, maximum: 10000000 }),
						tradeSize: Type.Integer({ minimum: 100, maximum: 10000000 }),
						commissionBps: Type.Number({ minimum: 0, maximum: 100 }),
						minimumFee: Type.Number({ minimum: 0, maximum: 1000 }),
						slippageBps: Type.Number({ minimum: 0, maximum: 100 }),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(id, params, signal, onUpdate) {
			const job = await client.run({ operation: "scriptBacktest", spec: params.spec }, id, 120, signal, (j) =>
				onUpdate?.(result("scriptBacktest", j)),
			);
			if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error ?? job.phase);
			return result("scriptBacktest", job);
		},
	});
}
