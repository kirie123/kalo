//! Extend a verified window using compatible immutable history, never across providers.
use crate::{market_model::Dataset, Bar};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

pub(crate) const SINA_SERIES: &str = "sina-kline-v1/close-time/shares";
const TENCENT_SERIES: &str = "tencent-mkline-v1/close-time/shares";

fn series(data: &Dataset) -> Option<&str> {
    if !data.series_key.is_empty() {
        return Some(&data.series_key);
    }
    // Read-only compatibility for the two adapters shipped before seriesKey.
    match data.source.as_str() {
        "新浪分钟 / 腾讯证券报价与原始、前复权日线" => Some(SINA_SERIES),
        "腾讯5分钟 / 腾讯原始、前复权日线交叉校验" => Some(TENCENT_SERIES),
        _ => None,
    }
}

fn same_market(a: &Dataset, b: &Dataset) -> bool {
    a.security == b.security
        && a.timeframe == b.timeframe
        && a.price_basis == b.price_basis
        && a.timezone == b.timezone
        && a.schema_version == b.schema_version
        && a.kind == b.kind
}

#[derive(Debug, PartialEq)]
enum Merge { Unrelated, Foreign, Disconnected, Contained, Extended }

fn merge(current: &mut Dataset, old: &Dataset) -> Result<Merge, String> {
    if !same_market(current, old) || old.bars.is_empty() || current.bars.is_empty() {
        return Ok(Merge::Unrelated);
    }
    if series(current).is_none() || series(current) != series(old) {
        return Ok(Merge::Foreign);
    }
    let current_by_time: BTreeMap<_, _> = current.bars.iter().map(|b| (b.end.as_str(), b)).collect();
    let overlaps: Vec<_> = old.bars.iter().filter_map(|a| current_by_time.get(a.end.as_str()).map(|b| (a, *b))).collect();
    if overlaps.is_empty() {
        return Ok(Merge::Disconnected);
    }
    for (a, b) in overlaps {
        let fields: Vec<_> = [
            ("open", a.open, b.open, 0.000001),
            ("close", a.close, b.close, 0.000001),
            ("high", a.high, b.high, 0.000001),
            ("low", a.low, b.low, 0.000001),
            ("volume", a.volume, b.volume, 0.01),
            ("previousClose", a.previous_close, b.previous_close, 0.000001),
        ].into_iter().filter(|(_, x, y, tolerance)| (x-y).abs() > *tolerance).map(|(name, _, _, _)| name).collect();
        if !fields.is_empty() {
            return Err(format!("{} 重叠字段不一致：{}", a.end, fields.join("、")));
        }
    }
    let mut map = BTreeMap::new();
    for b in old.bars.iter().chain(current.bars.iter()) {
        map.insert(b.end.clone(), b.clone());
    }
    if map.len() == current.bars.len() {
        return Ok(Merge::Contained);
    }
    if map.len() > 10000 {
        return Err("合并超过10000根上限，请使用更大周期".into());
    }
    current.bars = map.into_values().collect();
    current.raw_ids.extend(old.raw_ids.iter().cloned());
    Ok(Merge::Extended)
}

fn verify_extension(data: &mut Dataset, daily: &[Bar], today: &str) -> Result<(), String> {
    let rows: Result<Vec<_>, String> = data.bars.iter().map(|b| {
        let stamp = b.end.strip_suffix("+08:00").ok_or("历史时间缺少北京时间偏移")?;
        if !stamp.starts_with(&format!("{}T", b.session)) {
            return Err("历史交易日与K线时间不一致".into());
        }
        Ok(serde_json::json!({"day":stamp.replace('T', " "),"open":b.open,"high":b.high,"low":b.low,"close":b.close,"volume":b.volume}))
    }).collect();
    let minutes = crate::securities::minutes(&data.timeframe)?;
    let (bars, _, blocked) = crate::market_data::normalize(&serde_json::Value::Array(rows?), daily, today, minutes)?;
    if bars.len() != data.bars.len() {
        return Err("历史含未完成交易日，不能通过删除边界后拼接".into());
    }
    data.bars = bars;
    data.blocked_sessions = blocked;
    Ok(())
}

pub fn extend(root: &Path, data: &mut Dataset, daily: &[Bar], today: &str) -> Result<(), String> {
    let dir = root.join("datasets");
    let mut candidates = Vec::new();
    let mut notes = Vec::new();
    if dir.exists() {
        let mut paths: Vec<_> = std::fs::read_dir(dir).map_err(|e| e.to_string())?
            .map(|e| e.map(|entry| entry.path()).map_err(|e| e.to_string())).collect::<Result<_,_>>()?;
        paths.sort();
        for path in paths {
            if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let loaded = std::fs::read(&path).map_err(|e| e.to_string())
                .and_then(|bytes| serde_json::from_slice::<Dataset>(&bytes).map_err(|e| e.to_string()));
            match loaded {
                Ok(old) if same_market(data, &old) => candidates.push(old),
                Ok(_) => {},
                Err(_) => notes.push(format!("历史文件 {} 无法读取，已隔离；未覆盖原文件。", path.file_stem().unwrap_or_default().to_string_lossy())),
            }
        }
    }
    // Closest windows first permits deterministic chained extension toward older dates.
    candidates.sort_by(|a,b| (&b.bars.last().map(|r| &r.end), &b.created_at, &b.id).cmp(&(&a.bars.last().map(|r| &r.end), &a.created_at, &a.id)));
    for old in candidates {
        let mut candidate = data.clone();
        let outcome = merge(&mut candidate, &old).and_then(|result| {
            if result == Merge::Extended { verify_extension(&mut candidate, daily, today)?; }
            Ok(result)
        });
        match outcome {
            Ok(Merge::Extended) => {
                *data = candidate;
                notes.push(format!("已合并同源连续历史 {}，旧快照保留。", old.id));
            },
            Ok(Merge::Foreign) => notes.push(format!("历史 {} 的分钟来源或口径不同，未拼接；当前保留新来源的已校验窗口，旧快照与报告不变。", old.id)),
            Ok(Merge::Disconnected) => notes.push(format!("历史 {} 没有重叠区间，未拼接，未填充行情缺口。", old.id)),
            Err(reason) => notes.push(format!("未合并历史 {}：{reason}。当前保留已校验窗口，旧快照与报告不变。", old.id)),
            _ => {},
        }
    }
    data.sessions = data.bars.iter().map(|b| b.session.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    data.raw_ids.sort();
    data.raw_ids.dedup();
    data.warnings.extend(notes);
    data.source_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&(
        &data.series_key, &data.source_hash, &data.raw_ids, &data.bars, &data.blocked_sessions,
    )).map_err(|e| e.to_string())?));
    Ok(())
}

#[cfg(test)]
#[path = "market_archive_tests.rs"]
mod tests;
