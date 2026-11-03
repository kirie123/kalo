pub mod analysis;
pub mod engine;
pub mod model;
pub mod sources;
pub mod storage;
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
        if result.get("instruments").is_some() {
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
        Request::Sync {} => {
            let snapshot = sources::sync(root)?;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        Request::Backtest { spec } => {
            let snapshot: Snapshot = storage::read(root, "snapshots", &spec.snapshot_id)?;
            let report = engine::run(&snapshot, &spec)?;
            serde_json::to_value(report).map_err(|e| e.to_string())
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
