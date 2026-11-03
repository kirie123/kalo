use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bar {
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub adjusted_close: f64,
    pub volume: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundPoint {
    pub date: String,
    pub shares: Option<f64>,
    pub nav: Option<f64>,
    pub net_flow: Option<f64>,
    pub available_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub code: String,
    pub name: String,
    pub bars: Vec<Bar>,
    pub funds: Vec<FundPoint>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub created_at: String,
    pub source: String,
    pub instruments: Vec<Instrument>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub snapshot_id: String,
    pub start: String,
    pub end: String,
    pub capital: f64,
    pub lookback: usize,
    pub rebalance: usize,
    pub holdings: usize,
    pub commission_bps: f64,
    pub minimum_fee: f64,
    pub slippage_bps: f64,
    pub flow_filter: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Equity {
    pub date: String,
    pub equity: f64,
    pub cash: f64,
    pub benchmark: f64,
    pub drawdown: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub date: String,
    pub code: String,
    pub side: String,
    pub quantity: u64,
    pub price: f64,
    pub fee: f64,
    pub cash_after: f64,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub created_at: String,
    pub snapshot_hash: String,
    pub engine_version: String,
    #[serde(default)]
    pub engine_hash: String,
    pub spec: Spec,
    pub equity: Vec<Equity>,
    pub trades: Vec<Trade>,
    pub total_return: f64,
    pub max_drawdown: f64,
    pub fees: f64,
    pub warnings: Vec<String>,
}
