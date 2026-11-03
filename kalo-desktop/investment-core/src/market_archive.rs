//! Extend immutable local history only where an overlapping window proves continuity.
use crate::{market_model::Dataset, Bar};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

fn merge(current: &mut Dataset, old: &Dataset) -> Result<bool, String> {
    if old.security != current.security
        || old.timeframe != current.timeframe
        || old.price_basis != current.price_basis
        || old.bars.is_empty()
        || current.bars.is_empty()
    {
        return Ok(false);
    }
    let current_by_time: BTreeMap<_, _> =
        current.bars.iter().map(|b| (b.end.as_str(), b)).collect();
    let overlaps: Vec<_> = old
        .bars
        .iter()
        .filter_map(|a| current_by_time.get(a.end.as_str()).map(|b| (a, *b)))
        .collect();
    if overlaps.is_empty() {
        return Ok(false);
    }
    for (a, b) in overlaps {
        if [
            a.open - b.open,
            a.close - b.close,
            a.high - b.high,
            a.low - b.low,
        ]
        .iter()
        .any(|v| v.abs() > 0.000001)
            || (a.volume - b.volume).abs() > 0.01
            || (a.previous_close - b.previous_close).abs() > 0.000001
        {
            return Err(format!(
                "{} 与本地历史发生冲突，未覆盖旧数据；请核对供应商修订后再同步",
                a.end
            ));
        }
    }
    let mut map = BTreeMap::new();
    for b in old.bars.iter().chain(current.bars.iter()) {
        map.insert(b.end.clone(), b.clone());
    }
    if map.len() == current.bars.len() {
        return Ok(false);
    }
    if map.len() > 10000 {
        return Err("本地合并超过10000根上限，请使用更大周期".into());
    }
    current.bars = map.into_values().collect();
    current
        .blocked_sessions
        .extend(old.blocked_sessions.iter().cloned());
    current.raw_ids.extend(old.raw_ids.iter().cloned());
    Ok(true)
}

pub fn extend(root: &Path, data: &mut Dataset, daily: &[Bar]) -> Result<(), String> {
    let dir = root.join("datasets");
    if !dir.exists() {
        return Ok(());
    }
    let mut merged = 0;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let old: Dataset = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("本地分钟历史损坏：{e}"))?;
        if merge(data, &old)? {
            merged += 1;
        }
    }
    data.sessions = data
        .bars
        .iter()
        .map(|b| b.session.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for pair in daily.windows(2) {
        let prev = &pair[0];
        let d = &pair[1];
        if data.sessions.contains(&d.date)
            && ((d.close / d.adjusted_close) / (prev.close / prev.adjusted_close) - 1.0).abs()
                > 0.002
        {
            data.blocked_sessions.push(d.date.clone());
        }
    }
    data.blocked_sessions.sort();
    data.blocked_sessions.dedup();
    data.raw_ids.sort();
    data.raw_ids.dedup();
    if merged > 0 {
        data.warnings.push(format!(
            "已合并 {merged} 份有一致重叠区间的本地历史，旧数据保留。"
        ));
    }
    data.source_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                &data.source_hash,
                &data.raw_ids,
                &data.bars,
                &data.blocked_sessions
            ))
            .map_err(|e| e.to_string())?
        )
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market_model::*;
    #[test]
    fn archive_extends_overlap_but_rejects_revised_prices_and_skips_gaps() {
        let make = |times: &[&str]| Dataset {
            kind: "marketDataset".into(),
            schema_version: 1,
            id: String::new(),
            created_at: String::new(),
            security: security("002415.SZ").unwrap(),
            timeframe: "5m".into(),
            timezone: "Asia/Shanghai".into(),
            price_basis: "raw".into(),
            source: String::new(),
            source_hash: String::new(),
            raw_ids: vec![],
            sessions: vec![],
            warnings: vec![],
            blocked_sessions: vec![],
            bars: times
                .iter()
                .map(|t| MarketBar {
                    end: t.to_string(),
                    session: "day".into(),
                    open: 10.0,
                    close: 10.0,
                    high: 10.0,
                    low: 10.0,
                    volume: 100.0,
                    previous_close: 10.0,
                })
                .collect(),
        };
        let mut now = make(&["b", "c"]);
        let old = make(&["a", "b"]);
        assert!(merge(&mut now, &old).unwrap());
        assert_eq!(now.bars.len(), 3);
        let mut conflict = old.clone();
        conflict.bars[1].close = 11.0;
        assert!(merge(&mut now, &conflict).is_err());
        assert!(!merge(&mut now, &make(&["z"])).unwrap());
    }
}
