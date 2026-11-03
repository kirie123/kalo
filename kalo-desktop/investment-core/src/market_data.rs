use crate::{
    market_model::*,
    sources::{get_evidence, number, parse_bars},
    Bar,
};
use chrono::{FixedOffset, NaiveDateTime, Timelike, Utc};
use reqwest::blocking::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};

pub(crate) fn slots() -> Vec<u32> {
    (0..24)
        .map(|n| 9 * 60 + 35 + n * 5)
        .chain((0..24).map(|n| 13 * 60 + 5 + n * 5))
        .collect()
}

pub fn normalize(
    value: &Value,
    daily: &[Bar],
    today: &str,
) -> Result<(Vec<MarketBar>, Vec<String>), String> {
    let rows = value["data"]["sz002415"]["m5"]
        .as_array()
        .ok_or("海康威视5分钟行情缺失")?;
    let mut groups: BTreeMap<String, Vec<(u32, MarketBar)>> = BTreeMap::new();
    let mut last = String::new();
    for row in rows {
        let stamp = row[0].as_str().ok_or("分钟K线时间缺失")?;
        let dt = NaiveDateTime::parse_from_str(stamp, "%Y%m%d%H%M")
            .map_err(|_| "分钟K线时间格式无效")?;
        if stamp <= last.as_str() {
            return Err("分钟K线乱序或重复".into());
        }
        last = stamp.into();
        let day = dt.format("%Y-%m-%d").to_string();
        // Freeze completed sessions; never treat a current bar or session as complete.
        if day.as_str() >= today {
            continue;
        }
        let minute = dt.hour() * 60 + dt.minute();
        if !slots().contains(&minute) {
            return Err(format!("{stamp} 不在连续交易5分钟结束时刻内"));
        }
        let vals = (1..=5)
            .map(|i| number(&row[i]).ok_or("分钟OHLCV无效"))
            .collect::<Result<Vec<_>, _>>()?;
        let (open, close, high, low, volume) =
            (vals[0], vals[1], vals[2], vals[3], vals[4] * 100.0);
        if low <= 0.0
            || low > open
            || low > close
            || high < open
            || high < close
            || !volume.is_finite()
            || volume < 0.0
        {
            return Err("分钟OHLCV范围或单位无效".into());
        }
        let index = daily
            .iter()
            .position(|b| b.date == day)
            .ok_or_else(|| format!("{day} 缺少日线交易日证据"))?;
        let previous = index
            .checked_sub(1)
            .and_then(|i| daily.get(i))
            .ok_or("缺少前收盘价")?;
        let d = &daily[index];
        if low < d.low - 0.011 || high > d.high + 0.011 {
            return Err(format!("{day} 分钟价格与日线范围不一致"));
        }
        let factor = (d.close / d.adjusted_close) / (previous.close / previous.adjusted_close);
        if (factor - 1.0).abs() > 0.002 {
            return Err(format!(
                "{day} 疑似除权除息，当前分钟撮合不支持，请使用公司行为已处理的数据集"
            ));
        }
        groups.entry(day.clone()).or_default().push((
            minute,
            MarketBar {
                end: dt.format("%Y-%m-%dT%H:%M:00+08:00").to_string(),
                session: day,
                open,
                high,
                low,
                close,
                volume,
                previous_close: previous.close,
            },
        ));
    }
    let first = groups.keys().next().cloned();
    let last = groups.keys().last().cloned();
    let mut result = Vec::new();
    let mut warnings =
        vec!["免费源仅提供近期分钟窗口；当前交易日不纳入冻结数据集，不代表多年历史覆盖。".into()];
    for (day, rows) in groups {
        let actual: Vec<_> = rows.iter().map(|r| r.0).collect();
        if actual != slots() {
            if Some(&day) == first.as_ref() || Some(&day) == last.as_ref() {
                warnings.push(format!(
                    "排除边界不完整交易日 {day}（{}/48 根）",
                    rows.len()
                ));
                continue;
            }
            return Err(format!(
                "{day} 盘中K线缺口（{}/48 根），不允许填充后回测",
                rows.len()
            ));
        }
        let d = daily.iter().find(|b| b.date == day).unwrap();
        if (rows.last().unwrap().1.close - d.close).abs() > 0.011 {
            return Err(format!("{day} 分钟收盘与日线不一致"));
        }
        result.extend(rows.into_iter().map(|r| r.1));
    }
    if result.len() < 96 {
        return Err("至少需要两个完整交易日的5分钟行情".into());
    }
    let start = &result[0].session;
    let end = &result.last().unwrap().session;
    for day in daily.iter().filter(|d| &d.date >= start && &d.date <= end) {
        if !result.iter().any(|b| b.session == day.date) {
            return Err(format!("{} 整日分钟行情缺失，不能视为休市", day.date));
        }
    }
    Ok((result, warnings))
}

pub fn sync(root: &Path, code: &str, timeframe: &str) -> Result<Dataset, String> {
    let security = security(code)?;
    if timeframe != "5m" {
        return Err("当前免费分钟适配器已校验5m周期，其他周期尚未接入".into());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("Mozilla/5.0 KaloInvestment/0.2")
        .build()
        .map_err(|e| e.to_string())?;
    let today = Utc::now()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .format("%Y-%m-%d")
        .to_string();
    eprintln!("同步海康威视5分钟原始行情");
    let (minute, mid) = get_evidence(
        &client,
        root,
        "https://ifzq.gtimg.cn/appstock/app/kline/mkline",
        &[("param", "sz002415,m5,,320".into())],
        "https://gu.qq.com/",
    )?;
    eprintln!("核对交易日、前收盘和公司行为");
    let (raw, rid) = get_evidence(
        &client,
        root,
        "https://ifzq.gtimg.cn/appstock/app/fqkline/get",
        &[("param", "sz002415,day,,,320,".into())],
        "https://gu.qq.com/",
    )?;
    let (adj, aid) = get_evidence(
        &client,
        root,
        "https://ifzq.gtimg.cn/appstock/app/fqkline/get",
        &[("param", "sz002415,day,,,320,qfq".into())],
        "https://gu.qq.com/",
    )?;
    let mut daily = parse_bars(&raw, "sz002415", false, &today)?;
    let adjusted = parse_bars(&adj, "sz002415", true, &today)?;
    for bar in &mut daily {
        bar.adjusted_close = adjusted
            .iter()
            .find(|a| a.date == bar.date)
            .ok_or("复权日历缺口")?
            .close;
    }
    let (bars, warnings) = normalize(&minute, &daily, &today)?;
    let sessions = bars
        .iter()
        .map(|b| b.session.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let source_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!([minute, raw, adj])).map_err(|e| e.to_string())?
        )
    );
    Ok(Dataset {
        kind: "marketDataset".into(),
        schema_version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        created_at: Utc::now().to_rfc3339(),
        security,
        timeframe: timeframe.into(),
        timezone: "Asia/Shanghai".into(),
        price_basis: "raw".into(),
        source: "腾讯5分钟 / 腾讯原始与前复权日线交叉校验".into(),
        source_hash,
        raw_ids: vec![mid, rid, aid],
        bars,
        sessions,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Vec<Bar>) {
        let mut rows = vec![];
        let mut daily = vec![];
        for d in ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"] {
            daily.push(Bar {
                date: d.into(),
                open: 10.0,
                close: 10.0,
                high: 11.0,
                low: 9.0,
                adjusted_close: 10.0,
                volume: 480000.0,
            });
            if d != "2026-10-26" {
                for m in slots() {
                    rows.push(serde_json::json!([
                        format!("{}{:02}{:02}", d.replace('-', ""), m / 60, m % 60),
                        "10",
                        "10",
                        "11",
                        "9",
                        "100"
                    ]));
                }
            }
        }
        (serde_json::json!({"data":{"sz002415":{"m5":rows}}}), daily)
    }
    #[test]
    fn sessions_exclude_today_and_lunch_is_not_a_gap() {
        let (v, d) = fixture();
        let (bars, _) = normalize(&v, &d, "2026-10-29").unwrap();
        assert_eq!(bars.len(), 96);
        assert_eq!(bars[0].volume, 10000.0);
        assert!(bars[24].end.contains("13:05"));
    }
    #[test]
    fn duplicate_gap_and_corporate_action_fail() {
        let (v, d) = fixture();
        let mut dup = v.clone();
        dup["data"]["sz002415"]["m5"][1] = dup["data"]["sz002415"]["m5"][0].clone();
        assert!(normalize(&dup, &d, "2026-10-30").is_err());
        let mut gap = v.clone();
        gap["data"]["sz002415"]["m5"]
            .as_array_mut()
            .unwrap()
            .remove(60);
        assert!(normalize(&gap, &d, "2026-10-30").is_err());
        let mut action = d.clone();
        action[2].adjusted_close = 11.0;
        assert!(normalize(&v, &action, "2026-10-30").is_err());
    }
}
