use crate::{storage, Bar, FundPoint, Instrument, Snapshot};
use chrono::{FixedOffset, Utc};
use reqwest::blocking::Client;
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, time::Duration};

pub(crate) fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.replace(',', "").parse().ok())
        .filter(|v| v.is_finite())
}
pub(crate) fn get(
    client: &Client,
    root: &Path,
    url: &str,
    params: &[(&str, String)],
    referer: &str,
) -> Result<Value, String> {
    let value = crate::transport::fetch(client, url, params, referer)?;
    storage::save(
        root,
        "raw",
        &uuid::Uuid::new_v4().to_string(),
        &serde_json::json!({"url":url,"params":params,"receivedAt":Utc::now().to_rfc3339(),"body":value}),
    )?;
    Ok(value)
}
pub fn parse_bars(
    value: &Value,
    symbol: &str,
    adjusted: bool,
    today: &str,
) -> Result<Vec<Bar>, String> {
    let data = &value["data"][symbol];
    let rows = if adjusted {
        data.get("qfqday").or_else(|| data.get("day"))
    } else {
        data.get("day")
    };
    let rows = rows
        .and_then(Value::as_array)
        .ok_or("行情字段缺失，请重试或检查供应商接口")?;
    let mut bars = BTreeMap::new();
    for row in rows {
        let date = row[0].as_str().ok_or("行情日期无效")?.to_string();
        chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| "行情日期格式无效")?;
        if date.as_str() >= today {
            continue;
        }
        let vals: Vec<_> = (1..=5)
            .map(|i| number(&row[i]).ok_or("行情数值无效"))
            .collect::<Result<_, _>>()?;
        let (open, close, high, low, volume) = (vals[0], vals[1], vals[2], vals[3], vals[4]);
        if low <= 0.0
            || high < low
            || open < low
            || open > high
            || close < low
            || close > high
            || volume < 0.0
        {
            return Err(format!("{symbol} {date} OHLC/成交量不合法"));
        }
        if bars
            .insert(
                date.clone(),
                Bar {
                    date,
                    open,
                    high,
                    low,
                    close,
                    adjusted_close: close,
                    volume: volume * 100.0,
                },
            )
            .is_some()
        {
            return Err("行情日期重复".into());
        }
    }
    if bars.len() < 30 {
        return Err(format!("{symbol} 历史不足 30 个交易日"));
    }
    Ok(bars.into_values().collect())
}
pub fn sync(root: &Path) -> Result<Snapshot, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("Mozilla/5.0 KaloInvestment/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let today = Utc::now()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .format("%Y-%m-%d")
        .to_string();
    let mut instruments = vec![];
    let mut warnings = vec![];
    for entry in crate::universe::ENTRIES {
        let code = &entry.code[..6];
        eprintln!("同步 {code} 日线");
        let market = entry.code.split_once('.').ok_or("证券代码缺少市场")?.1;
        let symbol = format!("{}{code}", market.to_lowercase());
        let url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
        let raw = get(
            &client,
            root,
            url,
            &[("param", format!("{symbol},day,,,320,"))],
            "https://gu.qq.com/",
        )?;
        let adj = get(
            &client,
            root,
            url,
            &[("param", format!("{symbol},day,,,320,qfq"))],
            "https://gu.qq.com/",
        )?;
        let mut bars = parse_bars(&raw, &symbol, false, &today)?;
        let adjusted = parse_bars(&adj, &symbol, true, &today)?;
        let map: BTreeMap<_, _> = adjusted
            .iter()
            .map(|b| (b.date.as_str(), b.close))
            .collect();
        for bar in &mut bars {
            bar.adjusted_close = *map.get(bar.date.as_str()).ok_or("复权与原始行情日期不齐")?;
        }
        instruments.push(Instrument {
            code: entry.code.into(),
            name: entry.name.into(),
            category: entry.category.into(),
            bars,
            funds: vec![],
        });
    }
    let dates: Vec<_> = instruments[0]
        .bars
        .iter()
        .rev()
        .take(6)
        .map(|b| b.date.clone())
        .collect();
    let mut shares: BTreeMap<(String, String), f64> = BTreeMap::new();
    for date in &dates {
        eprintln!("同步 {date} 上交所份额");
        let response = get(
            &client,
            root,
            "https://query.sse.com.cn/commonQuery.do",
            &[
                ("isPagination", "true".into()),
                ("pageHelp.pageSize", "10000".into()),
                ("pageHelp.pageNo", "1".into()),
                ("sqlId", "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L".into()),
                ("STAT_DATE", date.clone()),
            ],
            "https://www.sse.com.cn/",
        );
        match response {
            Ok(value) => {
                if let Some(rows) = value["result"].as_array() {
                    for row in rows {
                        if row["STAT_DATE"].as_str() != Some(date) {
                            continue;
                        }
                        if let (Some(code), Some(n)) =
                            (row["SEC_CODE"].as_str(), number(&row["TOT_VOL"]))
                        {
                            if n > 0.0 {
                                shares.insert((format!("{code}.SH"), date.clone()), n * 10000.0);
                            }
                        }
                    }
                } else {
                    warnings.push(format!("{date} 上交所份额返回字段缺失"));
                }
            }
            Err(e) => warnings.push(format!("{date} 份额：{e}")),
        }
    }
    for instrument in instruments.iter().filter(|i| i.code.ends_with(".SZ")) {
        eprintln!("同步 {} 深交所份额", instrument.code);
        match crate::szse::shares(&client, root, &instrument.code[..6], &dates) {
            Ok(rows) => {
                for (date, qty) in rows {
                    shares.insert((instrument.code.clone(), date), qty);
                }
            }
            Err(e) => warnings.push(format!("{} 深交所份额：{e}", instrument.code)),
        }
    }
    // Preserve first-observed timestamps only when the observed values are unchanged.
    let previous = storage::catalog(root)?;
    let prior: Option<Snapshot> = previous["snapshots"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    for instrument in &mut instruments {
        let code = &instrument.code[..6];
        eprintln!("同步 {code} 单位净值");
        let response = get(
            &client,
            root,
            "https://api.fund.eastmoney.com/f10/lsjz",
            &[
                ("fundCode", code.into()),
                ("pageIndex", "1".into()),
                ("pageSize", "30".into()),
            ],
            "https://fundf10.eastmoney.com/",
        );
        let mut navs = BTreeMap::new();
        match response {
            Ok(v) => {
                if let Some(rows) = v["Data"]["LSJZList"].as_array() {
                    for row in rows {
                        if let (Some(d), Some(n)) = (row["FSRQ"].as_str(), number(&row["DWJZ"])) {
                            if n > 0.0 {
                                navs.insert(d.to_string(), n);
                            }
                        }
                    }
                } else {
                    warnings.push(format!("{code} 净值字段缺失"));
                }
            }
            Err(e) => warnings.push(format!("{code} 净值：{e}")),
        }
        let mut points: BTreeMap<String, FundPoint> = prior
            .as_ref()
            .and_then(|p| p.instruments.iter().find(|x| x.code == instrument.code))
            .map(|p| {
                p.funds
                    .iter()
                    .cloned()
                    .map(|f| (f.date.clone(), f))
                    .collect()
            })
            .unwrap_or_default();
        for date in dates.iter().rev() {
            let old = points.get(date);
            let qty = shares
                .get(&(instrument.code.clone(), date.clone()))
                .copied()
                .or_else(|| old.and_then(|p| p.shares));
            let nav = navs.get(date).copied().or_else(|| old.and_then(|p| p.nav));
            let previous_date = instrument
                .bars
                .iter()
                .position(|b| &b.date == date)
                .and_then(|i| i.checked_sub(1))
                .map(|i| instrument.bars[i].date.clone());
            let previous_shares = previous_date.as_ref().and_then(|d| {
                shares
                    .get(&(instrument.code.clone(), d.clone()))
                    .copied()
                    .or_else(|| points.get(d).and_then(|p| p.shares))
            });
            let net_flow = qty
                .zip(nav)
                .zip(previous_shares)
                .map(|((q, n), old)| (q - old) * n);
            let available_at = old
                .filter(|o| o.shares == qty && o.nav == nav && o.net_flow == net_flow)
                .map(|o| o.available_at.clone())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            points.insert(
                date.clone(),
                FundPoint {
                    date: date.clone(),
                    shares: qty,
                    nav,
                    net_flow,
                    available_at,
                },
            );
        }
        instrument.funds = points.into_values().collect();
        if instrument
            .funds
            .iter()
            .rev()
            .take(5)
            .filter(|f| f.net_flow.is_some())
            .count()
            < 5
        {
            warnings.push(format!(
                "{} 最近 5 日资金窗口不完整，不能生成完整排名",
                instrument.code
            ));
        }
    }
    Ok(Snapshot {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: now,
        source: "腾讯日线 / 上交所及深交所份额 / 东方财富单位净值".into(),
        instruments,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_rejects_invalid_ohlc() {
        let value =
            serde_json::json!({"data":{"sh510300":{"day":[["2026-01-02","5","2","4","1","12"]]}}});
        assert!(parse_bars(&value, "sh510300", false, "2026-11-03")
            .unwrap_err()
            .contains("OHLC"));
    }
}
