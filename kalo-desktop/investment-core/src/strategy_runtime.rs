use crate::market_model::{Dataset, ScriptSpec};
use rhai::{Dynamic, Engine, Scope, AST};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const EXAMPLE: &str = r#"// 选定证券 / KDJ(9,3,3) / 卖出旧仓后回补
// 修改阈值、条件和状态即可定义新策略；订单在下一根K线开盘撮合。
fn on_bar(ctx) {
    let order = #{ side: "hold", quantity: 0, state: ctx.state };
    if !ctx.kdj.ready { return order; }
    // 尾盘尝试恢复底仓，不保证成交；未回补数量会进入报告。
    if ctx.time >= "14:45" {
        if ctx.position < ctx.basePosition {
            order.side = "buy";
            order.quantity = ctx.basePosition - ctx.position;
        }
        return order;
    }
    let cross_down = ctx.previousKdj.k >= ctx.previousKdj.d && ctx.kdj.k < ctx.kdj.d;
    let cross_up = ctx.previousKdj.k <= ctx.previousKdj.d && ctx.kdj.k > ctx.kdj.d;
    if cross_down && ctx.kdj.k > 60.0 && ctx.position >= ctx.basePosition && ctx.sellable >= ctx.tradeSize {
        order.side = "sell";
        order.quantity = ctx.tradeSize;
    } else if cross_up && ctx.kdj.k < 40.0 && ctx.position < ctx.basePosition {
        order.side = "buy";
        order.quantity = ctx.tradeSize;
    }
    order
}"#;

pub fn warmup_start(data: &Dataset) -> usize {
    match data.blocked_sessions.last() {
        None => 30,
        Some(day) => data
            .bars
            .iter()
            .position(|b| &b.session > day)
            .map_or(data.bars.len(), |i| i + 30),
    }
}

pub fn defaults(dataset: &Dataset) -> Option<ScriptSpec> {
    Some(ScriptSpec {
        dataset_id: dataset.id.clone(),
        title: format!("{} KDJ 底仓做T", dataset.security.name),
        source: EXAMPLE.into(),
        start: dataset.bars.get(warmup_start(dataset))?.end.clone(),
        end: dataset.bars.last()?.end.clone(),
        cash: 100_000.0,
        base_position: 1000,
        trade_size: crate::securities::minimum(&dataset.security),
        commission_bps: 2.5,
        minimum_fee: 5.0,
        slippage_bps: 5.0,
    })
}
pub fn contract() -> Value {
    json!({"language":"rhai","entry":"fn on_bar(ctx)","maxSourceBytes":16384,"maxOperationsPerBar":100000,
        "inputs":["code","date","time","history (至当前收盘，最多120根，OHLCV)","kdj / previousKdj (9,3,3; K,D初值50; ready)","cash","position","sellable","basePosition","tradeSize","state"],
        "output":{"side":"hold | buy | sell","quantity":"非负整数股，数量须遵守security.lotSize及科创板最少200股、其他证券最少100股","state":"传递到下一根K线的JSON对象，可省略以保留"},
        "execution":"次根开盘，跨日订单失效；按冻结security.settlementDays控制T+0/T+1库存，初始底仓计入资产；不开放文件、网络、时间与模块加载。",
        "range":"必须使用dataset.defaultSpec.start或更晚的时刻，开始之前至少留30根预热K线；不能直接用firstBar作为start。",
        "example":EXAMPLE})
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Kdj {
    pub k: f64,
    pub d: f64,
    pub j: f64,
    pub ready: bool,
}
pub fn kdj(dataset: &Dataset) -> Vec<Kdj> {
    let (mut k, mut d) = (50.0, 50.0);
    let mut segment = 0;
    dataset
        .bars
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if dataset.blocked_sessions.contains(&b.session)
                && (i == 0 || dataset.bars[i - 1].session != b.session)
            {
                segment = i;
                k = 50.0;
                d = 50.0;
            }
            if i - segment < 8 {
                return Kdj {
                    k,
                    d,
                    j: 50.0,
                    ready: false,
                };
            }
            let window = &dataset.bars[i - 8..=i];
            let high = window
                .iter()
                .map(|b| b.high)
                .fold(f64::NEG_INFINITY, f64::max);
            let low = window.iter().map(|b| b.low).fold(f64::INFINITY, f64::min);
            let rsv = if high > low {
                (b.close - low) / (high - low) * 100.0
            } else {
                50.0
            };
            k = k * 2.0 / 3.0 + rsv / 3.0;
            d = d * 2.0 / 3.0 + k / 3.0;
            Kdj {
                k,
                d,
                j: 3.0 * k - 2.0 * d,
                ready: true,
            }
        })
        .collect()
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub side: String,
    pub quantity: u64,
    #[serde(default)]
    pub state: Option<Value>,
}
pub struct Runtime {
    engine: Engine,
    ast: AST,
}
impl Runtime {
    pub fn new(source: &str) -> Result<Self, String> {
        if source.is_empty() || source.len() > 16384 {
            return Err("策略代码必须为1–16384字节".into());
        }
        let mut engine = Engine::new();
        engine.disable_symbol("eval");
        engine
            .set_max_operations(100_000)
            .set_max_call_levels(16)
            .set_max_expr_depths(32, 32)
            .set_max_array_size(4096)
            .set_max_map_size(4096)
            .set_max_string_size(16384)
            .set_max_variables(128)
            .set_max_functions(32);
        engine.on_print(|_| {});
        engine.on_debug(|_, _, _| {});
        let ast = engine
            .compile(source)
            .map_err(|e| format!("策略编译失败：{e}"))?;
        Ok(Self { engine, ast })
    }
    pub fn call(&self, context: Value) -> Result<Intent, String> {
        let input = rhai::serde::to_dynamic(context).map_err(|e| e.to_string())?;
        let result = self
            .engine
            .call_fn::<Dynamic>(&mut Scope::new(), &self.ast, "on_bar", (input,))
            .map_err(|e| format!("策略运行失败：{e}"))?;
        let intent: Intent = rhai::serde::from_dynamic(&result)
            .map_err(|e| format!("策略返回需包含side和整数quantity：{e}"))?;
        if !["hold", "buy", "sell"].contains(&intent.side.as_str())
            || intent.quantity > 10_000_000
            || (intent.side == "hold" && intent.quantity != 0)
        {
            return Err("策略订单方向或数量无效".into());
        }
        if let Some(state) = &intent.state {
            if !state.is_object()
                || serde_json::to_vec(state).map_err(|e| e.to_string())?.len() > 8192
            {
                return Err("策略state必须为不超过8KiB的对象".into());
            }
        }
        Ok(intent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_and_invalid_results_are_errors() {
        assert!(Runtime::new("fn on_bar(ctx) { while true {} }")
            .unwrap()
            .call(json!({}))
            .is_err());
        assert!(Runtime::new("import \"secret\" as x;").is_err());
        assert!(Runtime::new("fn on_bar(ctx) { eval(\"40+2\") }").is_err());
        assert!(
            Runtime::new("fn on_bar(ctx) { #{ side: \"sell\", quantity: -100 } }")
                .unwrap()
                .call(json!({}))
                .is_err()
        );
        assert!(Runtime::new("fn on_bar(ctx) { timestamp() }")
            .unwrap()
            .call(json!({}))
            .is_err());
    }
    #[test]
    fn state_and_functions_support_custom_logic() {
        let runtime=Runtime::new("fn amount(n) { n * 100 } fn on_bar(ctx) { #{side: \"buy\",quantity:amount(ctx.state.n),state:#{n:ctx.state.n+1}} }").unwrap();
        let result = runtime.call(json!({"state":{"n":2}})).unwrap();
        assert_eq!(result.quantity, 200);
        assert_eq!(result.state.unwrap()["n"], 3);
    }
}
