pub mod analysis;
pub mod engine;
pub mod margin;
pub mod market_data;
pub mod market_model;
pub mod model;
pub mod script_engine;
pub mod sources;
pub mod storage;
pub mod strategy_runtime;
mod szse;
mod transport;
pub mod universe;
pub use model::*;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Sync {},
    Backtest { spec: Spec },
    MarketSync { code: String, timeframe: String },
    ScriptBacktest { spec: market_model::ScriptSpec },
    MarginSync {},
}

pub fn execute(root: &Path, request: Request) -> Result<serde_json::Value, String> {
    let result = compute(root, request)?;
    commit(root, &result)?;
    Ok(result)
}

pub fn commit(root: &Path, result: &serde_json::Value) -> Result<(), String> {
    let id = result["id"].as_str().ok_or("结果缺少 ID")?;
    storage::save(
        root,
        if result["kind"] == "marginSnapshot" {
            "margin"
        } else if result["kind"] == "marketDataset" {
            "datasets"
        } else if result["kind"] == "scriptReport" {
            "script-reports"
        } else if result.get("instruments").is_some() {
            "snapshots"
        } else {
            "reports"
        },
        id,
        result,
    )
}

fn compute(root: &Path, request: Request) -> Result<serde_json::Value, String> {
    match request {
        Request::MarginSync {} => {
            serde_json::to_value(margin::sync(root)?).map_err(|e| e.to_string())
        }
        Request::Sync {} => {
            let snapshot = sources::sync(root)?;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        Request::Backtest { spec } => {
            let snapshot: Snapshot = storage::read(root, "snapshots", &spec.snapshot_id)?;
            let report = engine::run(&snapshot, &spec)?;
            serde_json::to_value(report).map_err(|e| e.to_string())
        }
        Request::MarketSync { code, timeframe } => {
            serde_json::to_value(market_data::sync(root, &code, &timeframe)?)
                .map_err(|e| e.to_string())
        }
        Request::ScriptBacktest { spec } => {
            let dataset = storage::read(root, "datasets", &spec.dataset_id)?;
            serde_json::to_value(script_engine::run(&dataset, &spec)?).map_err(|e| e.to_string())
        }
    }
}

pub fn worker(root: &Path, defer_commit: bool) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut input = String::new();
    std::io::stdin()
        .take(65537)
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    if input.len() > 65536 {
        return Err("请求过大".into());
    }
    let request = serde_json::from_str(&input).map_err(|e| format!("请求无效：{e}"))?;
    let result = if defer_commit {
        compute(root, request)?
    } else {
        execute(root, request)?
    };
    std::io::stdout()
        .write_all(
            serde_json::to_string(&result)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())
}
