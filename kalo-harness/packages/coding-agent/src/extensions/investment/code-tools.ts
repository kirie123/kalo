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
			"Fetch verified A-share or ETF minute history by any six-digit code or code.SH/SZ/BJ. Supports 5m/15m/30m/60m; free source returns at most 1970 bars (about 40 trading days at 5m, 490 at 60m), extends matching local history. Coverage depends on source availability; never invent missing history. Corporate-action dates are stored as blockedSessions; choose defaultSpec or a range with 30 warmup bars that does not cross an action. Optional settlementDays=0 only for ETFs confirmed to allow intraday resale; defaults conservatively to 1. Result appears in the code strategy panel. Waits up to 120 seconds.",
		promptGuidelines: [
			"严格保留用户指定的策略条件。初始底仓不等于必须维持的最低仓位；发现仓位漂移要解释，不得擅自更换为另一策略或反复扩展实验覆盖原报告。编译修复须保留原信号含义。",
			"任意A股或ETF的做T、KDJ等自定义策略使用分钟数据与代码回测工具，不得静默替换成ETF动量。先查询catalog的supportedMarketData、strategyRuntime与defaultSpec。",
			"策略代码使用Rhai的fn on_bar(ctx)，只看已完成K线；遵守冻结证券的数量、税费、T+0/T+1规则与次根成交。报告区分组合总收益和相对持有增益，不把短窗口实验称为稳健盈利。",
		],
		parameters: Type.Object(
			{
				code: Type.String({ pattern: "^[0-9]{6}(\\.(SH|SZ|BJ))?$" }),
				timeframe: Type.Union([Type.Literal("5m"), Type.Literal("15m"), Type.Literal("30m"), Type.Literal("60m")]),
				settlementDays: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1)])),
			},
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
			"Run custom Rhai strategy code in the Rust event-driven engine. Read catalog for dataset ID, defaultSpec, blockedSessions, complete on_bar(ctx) API and example. Supports user-written functions, conditions and persistent ctx.state; return {side: hold|buy|sell, quantity: integer shares, state: object}. No files/network/import/time. Trades at NEXT bar open with frozen security inventory and quantity rules, base position, fees and slippage. ETFs have no stock stamp/transfer tax. Does not cross unsupported corporate actions. All source and parameters are saved in the panel report. Never substitute a canned momentum strategy. Waits up to 120 seconds.",
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
