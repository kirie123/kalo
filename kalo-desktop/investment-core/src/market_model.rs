use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Security {
    pub code: String,
    pub name: String,
    pub exchange: String,
    pub asset_type: String,
    pub currency: String,
    pub tick_size: f64,
    pub lot_size: u64,
    pub settlement_days: u8,
    pub price_limit: f64,
}
#[cfg(test)]
pub fn security(code: &str) -> Result<Security, String> {
    if code != "002415.SZ" {
        return Err(
            "代码策略当前已校验海康威视 002415.SZ；其他证券需先接入交易规则与数据验证".into(),
        );
    }
    Ok(Security {
        code: code.into(),
        name: "海康威视".into(),
        exchange: "SZSE".into(),
        asset_type: "stock".into(),
        currency: "CNY".into(),
        tick_size: 0.01,
        lot_size: 100,
        settlement_days: 1,
        price_limit: 0.10,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketBar {
    pub end: String,
    pub session: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub previous_close: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    #[serde(default)]
    pub corporate_actions: Vec<crate::corporate_actions::CorporateAction>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub series_key: String,
    #[serde(default)]
    pub blocked_sessions: Vec<String>,
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub created_at: String,
    pub security: Security,
    pub timeframe: String,
    pub timezone: String,
    pub price_basis: String,
    pub source: String,
    pub source_hash: String,
    pub raw_ids: Vec<String>,
    pub bars: Vec<MarketBar>,
    pub sessions: Vec<String>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptSpec {
    pub dataset_id: String,
    pub title: String,
    pub source: String,
    pub start: String,
    pub end: String,
    pub cash: f64,
    pub base_position: u64,
    pub trade_size: u64,
    pub commission_bps: f64,
    pub minimum_fee: f64,
    pub slippage_bps: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOrder {
    pub signal_at: String,
    pub executed_at: Option<String>,
    pub side: String,
    pub requested: u64,
    pub quantity: u64,
    pub price: f64,
    pub commission: f64,
    pub stamp_tax: f64,
    pub transfer_fee: f64,
    pub cash_after: f64,
    pub position_after: u64,
    pub sellable_after: u64,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEquity {
    #[serde(default)]
    pub dividend_receivable: f64,
    #[serde(default)]
    pub pending_shares: u64,
    #[serde(default)]
    pub average_cost: f64,
    #[serde(default)]
    pub realized_pnl: f64,
    #[serde(default)]
    pub dividend_income: f64,
    pub time: String,
    pub equity: f64,
    pub benchmark: f64,
    pub cash: f64,
    pub position: u64,
    pub sellable: u64,
    pub k: f64,
    pub d: f64,
    pub j: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptReport {
    #[serde(default)]
    pub accounting: String,
    #[serde(default)]
    pub corporate_actions: Vec<crate::corporate_actions::CorporateAction>,
    #[serde(default)]
    pub action_ledger: Vec<crate::corporate_ledger::ActionEntry>,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    pub kind: String,
    pub id: String,
    pub created_at: String,
    pub dataset_hash: String,
    pub engine_hash: String,
    pub spec: ScriptSpec,
    pub security: Security,
    pub equity: Vec<ScriptEquity>,
    pub orders: Vec<ScriptOrder>,
    pub initial_equity: f64,
    pub total_return: f64,
    pub benchmark_return: f64,
    pub excess_pnl: f64,
    pub max_drawdown: f64,
    pub costs: f64,
    pub warnings: Vec<String>,
}

fn default_timeframe() -> String {
    "5m".into()
}
