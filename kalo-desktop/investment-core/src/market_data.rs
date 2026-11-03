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

pub(crate) fn slots_for(minutes: u32) -> Vec<u32> {
    (1..=120 / minutes)
        .map(|n| 9 * 60 + 30 + n * minutes)
        .chain((1..=120 / minutes).map(|n| 13 * 60 + n * minutes))
        .collect()
}
#[cfg(test)]
pub(crate) fn slots() -> Vec<u32> {
    slots_for(5)
}

pub fn normalize(
    value: &Value,
    daily: &[Bar],
    today: &str,
    minutes: u32,
) -> Result<(Vec<MarketBar>, Vec<String>, Vec<String>), String> {
    if ![5, 15, 30, 60].contains(&minutes) {
        return Err("不支持的分钟周期".into());
    }
    let rows = value.as_array().ok_or("分钟行情缺失")?;
    let mut blocked = Vec::new();
    let mut groups: BTreeMap<String, Vec<(u32, MarketBar)>> = BTreeMap::new();
    let mut last = String::new();
    for row in rows {
        let stamp = row["day"].as_str().ok_or("分钟K线时间缺失")?;
        let dt = NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S")
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
        if dt.second() != 0 || !slots_for(minutes).contains(&minute) {
            return Err(format!("{stamp} 不在连续交易结束时刻内"));
        }
        let vals = ["open", "close", "high", "low", "volume"]
            .iter()
            .map(|i| number(&row[*i]).ok_or("分钟OHLCV无效"))
            .collect::<Result<Vec<_>, _>>()?;
        let (open, close, high, low, volume) = (vals[0], vals[1], vals[2], vals[3], vals[4]);
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
        if (factor - 1.0).abs() > 0.002 && !blocked.contains(&day) {
            blocked.push(day.clone());
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
    let mut warnings = vec![
        "免费源最多返回1970根分钟K线，覆盖随周期而变；当日与不完整边界日不纳入冻结数据。".into(),
    ];
    for (day, rows) in groups {
        let actual: Vec<_> = rows.iter().map(|r| r.0).collect();
        if actual != slots_for(minutes) {
            if Some(&day) == first.as_ref() || Some(&day) == last.as_ref() {
                warnings.push(format!("排除边界不完整交易日 {day}（{} 根）", rows.len()));
                continue;
            }
            return Err(format!(
                "{day} 盘中K线缺口（{} 根），不允许填充后回测",
                rows.len()
            ));
        }
        let d = daily.iter().find(|b| b.date == day).unwrap();
        if (rows.last().unwrap().1.close - d.close).abs() > 0.011 {
            return Err(format!("{day} 分钟收盘与日线不一致"));
        }
        result.extend(rows.into_iter().map(|r| r.1));
    }
    if result.len() < 32 {
        return Err("至少需要32根完整交易日行情，以预留30根指标预热".into());
    }
    let start = &result[0].session;
    let end = &result.last().unwrap().session;
    for day in daily.iter().filter(|d| &d.date >= start && &d.date <= end) {
        if !result.iter().any(|b| b.session == day.date) {
            return Err(format!("{} 整日分钟行情缺失，不能视为休市", day.date));
        }
    }
    blocked.retain(|day| result.iter().any(|b| &b.session == day));
    Ok((result, warnings, blocked))
}

pub fn sync(
    root: &Path,
    input: &str,
    timeframe: &str,
    settlement: Option<u8>,
) -> Result<Dataset, String> {
    let code = crate::securities::code(input)?;
    let minutes = crate::securities::minutes(timeframe)?;
    let symbol = format!("{}{}", code[7..].to_lowercase(), &code[..6]);
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("Mozilla/5.0 KaloInvestment/0.3")
        .build()
        .map_err(|e| e.to_string())?;
    let today = Utc::now()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .format("%Y-%m-%d")
        .to_string();
    eprintln!("核实 {code} 证券身份与交易规则");
    let (quote, qid) = get_evidence(
        &client,
        root,
        &format!("https://qt.gtimg.cn/q={symbol}"),
        &[],
        "https://gu.qq.com/",
    )?;
    let security = crate::securities::from_quote(
        &code,
        quote.as_str().ok_or("证券报价格式无效")?,
        settlement,
    )?;
    eprintln!("同步 {} {timeframe} 历史", security.name);
    let (minute, mid) = get_evidence(
        &client,
        root,
        "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData",
        &[
            ("symbol", symbol.clone()),
            ("scale", minutes.to_string()),
            ("ma", "no".into()),
            ("datalen", "1970".into()),
        ],
        "https://finance.sina.com.cn/",
    )?;
    eprintln!("核对交易日、日线与公司行为");
    let url = "https://ifzq.gtimg.cn/appstock/app/fqkline/get";
    let (raw, rid) = get_evidence(
        &client,
        root,
        url,
        &[("param", format!("{symbol},day,,,2000,"))],
        "https://gu.qq.com/",
    )?;
    let (adj, aid) = get_evidence(
        &client,
        root,
        url,
        &[("param", format!("{symbol},day,,,2000,qfq"))],
        "https://gu.qq.com/",
    )?;
    let mut daily = parse_bars(&raw, &symbol, false, &today)
        .map_err(|e| format!("{code} 日线校验失败：{e}。免费源未覆盖时不能生成替代历史。"))?;
    let adjusted = parse_bars(&adj, &symbol, true, &today)?;
    // Tencent caps adjusted history independently from raw history. Keep the
    // shared calendar; normalize still rejects any minute outside that evidence.
    let first_adjusted = &adjusted.first().ok_or("复权日历为空")?.date;
    daily.retain(|b| &b.date >= first_adjusted);
    for bar in &mut daily {
        bar.adjusted_close = adjusted
            .iter()
            .find(|a| a.date == bar.date)
            .ok_or("复权日历缺口")?
            .close;
    }
    let (bars, mut warnings, blocked_sessions) = normalize(&minute, &daily, &today, minutes)?;
    warnings.push(
        "涨跌幅按同步时已核实规则模拟，未还原历史ST变更及上市初期特殊规则；公司行为以已核实分派条款入账，未知事件保留隔离。"
            .into(),
    );
    if security.asset_type == "etf" {
        warnings.push(format!(
            "ETF 库存采用 T+{}，{}；ETF 不计股票印花税与过户费。",
            security.settlement_days,
            if settlement.is_some() {
                "由同步时选择的交易规则指定，请核对基金交易机制"
            } else {
                "默认采用保守T+1；确认支持日内回转的ETF可选择T+0后重新同步"
            }
        ));
    }
    let sessions = bars
        .iter()
        .map(|b| b.session.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let source_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!([quote, minute, raw, adj]))
                .map_err(|e| e.to_string())?
        )
    );
    let mut data = Dataset {
        corporate_actions: vec![],
        series_key: crate::market_archive::SINA_SERIES.into(),
        kind: "marketDataset".into(),
        schema_version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        created_at: Utc::now().to_rfc3339(),
        security,
        timeframe: timeframe.into(),
        timezone: "Asia/Shanghai".into(),
        price_basis: "raw".into(),
        source: "新浪分钟 / 腾讯证券报价与原始、前复权日线".into(),
        source_hash,
        raw_ids: vec![qid, mid, rid, aid],
        bars,
        sessions,
        warnings,
        blocked_sessions,
    };
    crate::market_archive::extend(root, &mut data, &daily, &today)?;
    crate::action_source::attach(&client, root, &mut data, &daily)?;
    Ok(data)
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
                    rows.push(serde_json::json!({"day":format!("{d} {:02}:{:02}:00", m / 60, m % 60),"open":"10","close":"10","high":"11","low":"9","volume":"10000"}));
                }
            }
        }
        (serde_json::json!(rows), daily)
    }
    #[test]
    fn sessions_exclude_today_and_lunch_is_not_a_gap() {
        let (v, d) = fixture();
        let (bars, _, _) = normalize(&v, &d, "2026-10-29", 5).unwrap();
        assert_eq!(bars.len(), 96);
        assert_eq!(bars[0].volume, 10000.0);
        assert!(bars[24].end.contains("13:05"));
    }
    #[test]
    fn duplicate_gap_and_corporate_action_fail() {
        let (v, d) = fixture();
        let mut dup = v.clone();
        dup[1] = dup[0].clone();
        assert!(normalize(&dup, &d, "2026-10-30", 5).is_err());
        let mut gap = v.clone();
        gap.as_array_mut().unwrap().remove(60);
        assert!(normalize(&gap, &d, "2026-10-30", 5).is_err());
        let mut action = d.clone();
        action[2].adjusted_close = 11.0;
        assert_eq!(normalize(&v, &action, "2026-10-30", 5).unwrap().2.len(), 2);
    }
}
