//! Free implemented-distribution terms + payment calendar + issuer listing notice.
use crate::{
    corporate_actions::CorporateAction,
    market_model::Dataset,
    sources::{get_evidence, number},
    Bar,
};
use reqwest::blocking::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

fn date(v: &Value) -> Result<String, String> {
    let s = v.as_str().and_then(|s| s.get(..10)).ok_or("分派日期缺失")?;
    let d = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| "分派日期格式错误")?;
    if d.to_string() != s {
        return Err("分派日期格式错误".into());
    }
    Ok(s.into())
}
fn ratio(row: &Value, field: &str) -> Result<f64, String> {
    if row.get(field).is_none() {
        return Err(format!("分派字段缺失：{field}"));
    }
    if row[field].is_null() {
        return Ok(0.0);
    }
    let n = number(&row[field]).ok_or_else(|| format!("分派数值无效：{field}"))? / 10.0;
    if !(0.0..=100.0).contains(&n) {
        return Err("分派比例超出范围".into());
    }
    Ok(n)
}
fn fetch_rows(
    client: &Client,
    root: &Path,
    code: &str,
    report: &str,
) -> Result<(Vec<Value>, Vec<String>), String> {
    let mut rows = Vec::new();
    let mut evidence = Vec::new();
    for page in 1..=10 {
        let (v, id) = get_evidence(
            client,
            root,
            "https://datacenter.eastmoney.com/securities/api/data/v1/get",
            &[
                ("reportName", report.into()),
                ("columns", "ALL".into()),
                ("filter", format!("(SECUCODE=\"{code}\")")),
                ("pageSize", "100".into()),
                ("pageNumber", page.to_string()),
                ("sortColumns", "EX_DIVIDEND_DATE".into()),
                ("sortTypes", "1".into()),
                ("source", "HSF10".into()),
                ("client", "PC".into()),
            ],
            "https://emweb.securities.eastmoney.com/",
        )?;
        if v["success"] != true {
            return Err(format!("公司行为接口 {report} 未返回成功，已有数据保留"));
        }
        let list = v["result"]["data"]
            .as_array()
            .ok_or("公司行为列表缺失，不能视为无分红")?;
        rows.extend(list.iter().cloned());
        evidence.push(id);
        let pages = v["result"]["pages"]
            .as_u64()
            .ok_or("公司行为分页信息缺失")?;
        if pages <= page {
            return Ok((rows, evidence));
        }
    }
    Err("公司行为历史超过分页上限，未生成不完整快照".into())
}

/// Only parse an explicitly named listing-date sentence; never infer from ex-date.
pub(crate) fn listing_date(text: &str) -> Result<String, String> {
    let s: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    for label in [
        "起始交易日为",
        "新增无限售条件流通股份上市日",
        "新增无限售流通股份上市日",
        "红股上市日为",
    ] {
        if let Some((_, tail)) = s.split_once(label) {
            let Some(index) = tail.find(|c: char| c.is_ascii_digit()) else {
                continue;
            };
            if tail[..index]
                .chars()
                .any(|c| !matches!(c, ':' | '：' | '为' | '|'))
            {
                continue;
            }
            let head: String = tail.chars().take(36).collect();
            let parts: Vec<_> = head
                .split(|c: char| !c.is_ascii_digit())
                .filter(|p| !p.is_empty())
                .take(3)
                .collect();
            if parts.len() == 3 && parts[0].len() == 4 {
                let d = format!(
                    "{}-{:02}-{:02}",
                    parts[0],
                    parts[1].parse::<u32>().map_err(|_| "上市月无效")?,
                    parts[2].parse::<u32>().map_err(|_| "上市日无效")?
                );
                return date(&Value::String(d));
            }
        }
    }
    Err("实施公告未能核实送转股份上市日期".into())
}

fn action(
    client: &Client,
    root: &Path,
    row: &Value,
    calendars: &[Value],
    data: &Dataset,
    daily: &[Bar],
    evidence: &[String],
) -> Result<CorporateAction, String> {
    if row["SECUCODE"] != data.security.code {
        return Err("公司行为证券不匹配".into());
    }
    if row["ASSIGN_PROGRESS"] != "实施分配" {
        return Err("分派尚未实施".into());
    }
    let ex = date(&row["EX_DIVIDEND_DATE"])?;
    let record = date(&row["EQUITY_RECORD_DATE"])?;
    let matches: Vec<_> = calendars
        .iter()
        .filter(|c| {
            c["SECUCODE"] == data.security.code
                && date(&c["EX_DIVIDEND_DATE"]).ok().as_ref() == Some(&ex)
                && date(&c["EQUITY_RECORD_DATE"]).ok().as_ref() == Some(&record)
                && c["ASSIGN_PROGRESS"] == "实施方案"
        })
        .collect();
    if matches.len() != 1 {
        return Err("实施日历缺失或重复，不能推断到账日期".into());
    }
    let c = matches[0];
    let cash = ratio(row, "PRETAX_BONUS_RMB")?;
    let bonus = ratio(row, "BONUS_RATIO")?;
    let transfer = ratio(row, "IT_RATIO")?;
    let index = daily
        .iter()
        .position(|d| d.date == ex)
        .ok_or("除权日不在日线证据中")?;
    let prev = index
        .checked_sub(1)
        .and_then(|i| daily.get(i))
        .ok_or("缺少除权前收盘")?;
    if prev.date != record {
        return Err("登记日至除权日存在缺口或停牌，暂不能核实权益".into());
    }
    let reference = (prev.close - cash) / (1.0 + bonus + transfer);
    let d = &daily[index];
    let observed = prev.close * (d.close / d.adjusted_close) / (prev.close / prev.adjusted_close);
    // Daily adjusted quotes are rounded to cents; never infer distribution amounts from them.
    if ex >= data.sessions[0] && (reference - observed).abs() > 0.03_f64.max(prev.close * 0.0003) {
        return Err("分派方案与日线复权变化不符，可能有差异化分红或其他公司行为".into());
    }
    let mut ids = evidence.to_vec();
    let info = c["INFO_CODE"]
        .as_str()
        .filter(|s| s.starts_with("AN") && s[2..].chars().all(|c| c.is_ascii_digit()))
        .ok_or("实施公告标识缺失")?;
    let listing = if bonus + transfer > 0.0 {
        let (notice, id) = get_evidence(
            client,
            root,
            "https://np-cnotice-stock.eastmoney.com/api/content/ann",
            &[
                ("art_code", info.into()),
                ("client_source", "web".into()),
                ("page_index", "1".into()),
            ],
            "https://data.eastmoney.com/",
        )?;
        if notice["data"]["art_code"] != info
            || notice["data"]["page_size"].as_u64() != Some(1)
            || !notice["data"]["security"]
                .as_array()
                .is_some_and(|a| a.iter().any(|s| s["stock"] == data.security.code[..6]))
        {
            return Err("股份上市公告不完整或证券不匹配".into());
        }
        ids.push(id);
        Some(listing_date(
            notice["data"]["notice_content"]
                .as_str()
                .ok_or("公告正文缺失")?,
        )?)
    } else {
        None
    };
    let a = CorporateAction {
        id: format!("{}:{ex}:{info}", data.security.code),
        record_date: record,
        ex_date: ex,
        pay_date: if cash > 0.0 {
            Some(date(&c["PAY_CASH_DATE"])?)
        } else {
            None
        },
        listing_date: listing,
        cash_per_share: cash,
        bonus_per_share: bonus,
        transfer_per_share: transfer,
        announced_at: date(&row["NOTICE_DATE"])?,
        reference_price: (reference / data.security.tick_size).round() * data.security.tick_size,
        source: format!(
            "https://data.eastmoney.com/notices/detail/{}/{info}.html",
            &data.security.code[..6]
        ),
        evidence_ids: ids,
    };
    a.validate()?;
    Ok(a)
}

pub fn attach(
    client: &Client,
    root: &Path,
    data: &mut Dataset,
    daily: &[Bar],
) -> Result<(), String> {
    if data.security.asset_type != "stock" {
        return Ok(());
    }
    let (rows, mut evidence) = fetch_rows(client, root, &data.security.code, "RPT_SHAREBONUS_DET")?;
    let (calendar, ids) = fetch_rows(client, root, &data.security.code, "RPT_F10_DIVIDEND_MAIN")?;
    evidence.extend(ids);
    let first = data.sessions.first().ok_or("交易日为空")?.clone();
    let last = data.sessions.last().unwrap().clone();
    let mut events = std::collections::BTreeMap::new();
    for row in &rows {
        if row["SECUCODE"] != data.security.code {
            return Err("公司行为列表包含其他证券，未生成快照".into());
        }
        let Ok(ex) = date(&row["EX_DIVIDEND_DATE"]) else {
            if row["ASSIGN_PROGRESS"] == "实施分配" {
                return Err("已实施分派缺少除权日，不能推定无公司行为".into());
            }
            continue;
        };
        if ex > last {
            continue;
        }
        // An earlier ex-date can still have unpaid dividends or unlisted shares
        // at the beginning of the minute window. Preserve that boundary evidence.
        if ex < first
            && !calendar.iter().any(|c| {
                date(&c["EX_DIVIDEND_DATE"]).ok().as_ref() == Some(&ex)
                    && date(&c["PAY_CASH_DATE"]).is_ok_and(|d| d >= first)
            })
        {
            if ratio(row, "BONUS_RATIO")? + ratio(row, "IT_RATIO")? == 0.0 {
                continue;
            }
            if daily.first().is_none_or(|d| ex <= d.date) {
                continue;
            }
        }
        if events.contains_key(&ex) {
            events.insert(ex, Err("同日实施明细重复，需核实".into()));
            continue;
        }
        events.insert(
            ex,
            action(client, root, row, &calendar, data, daily, &evidence),
        );
    }
    data.corporate_actions.clear();
    for (day, result) in events {
        match result {
            Ok(a) => {
                if a.ex_date < first
                    && a.pay_date
                        .iter()
                        .chain(a.listing_date.iter())
                        .all(|d| d < &first)
                {
                    continue;
                }
                data.blocked_sessions.retain(|d| d != &day);
                data.raw_ids.extend(a.evidence_ids.iter().cloned());
                data.corporate_actions.push(a);
            }
            Err(e) => {
                data.blocked_sessions.push(day.clone());
                data.warnings
                    .push(format!("{day} 公司行为未核实：{e}；不能跨该日回测。"));
            }
        }
    }
    data.raw_ids.extend(evidence);
    data.raw_ids.sort();
    data.raw_ids.dedup();
    data.blocked_sessions.sort();
    data.blocked_sessions.dedup();
    data.warnings.push("公司行为采用税前股息口径，未模拟个人差别化红利所得税；已核实事件可连续回测，未核实日期仍隔离。".into());
    data.source_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                &data.source_hash,
                &data.raw_ids,
                &data.corporate_actions,
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
    #[test]
    fn listing_dates_require_explicit_named_evidence() {
        assert_eq!(
            listing_date("本次所送（转）的无限售条件流通股的起始交易日为 2026 年 5 月 26 日。")
                .unwrap(),
            "2026-05-26"
        );
        assert_eq!(
            listing_date("新增无限售条件流通股份上市日 2026/6/5").unwrap(),
            "2026-06-05"
        );
        assert!(listing_date("除权日2026年5月26日，股份上市日另行通知").is_err());
        assert!(listing_date("起始交易日为2026年2月30日").is_err());
        assert!(listing_date("新增无限售条件流通股份上市日现金红利发放日2026/6/5").is_err());
    }
    #[test]
    fn distribution_units_and_dates_are_validated() {
        assert_eq!(
            ratio(&serde_json::json!({"cash":7.5}), "cash").unwrap(),
            0.75
        );
        assert!(ratio(&serde_json::json!({"cash":"missing"}), "cash").is_err());
        assert!(ratio(&serde_json::json!({}), "cash").is_err());
        assert!(ratio(&serde_json::json!({"cash":-1}), "cash").is_err());
        assert!(date(&serde_json::json!("2026-02-30 00:00:00")).is_err());
        assert!(date(&Value::Null).is_err());
    }
}
