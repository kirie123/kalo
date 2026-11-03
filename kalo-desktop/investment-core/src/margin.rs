use crate::sources::{get_evidence, number};
use chrono::{Duration, FixedOffset, NaiveDate, Utc};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub date: String,
    pub financing_balance: f64,
    pub financing_buy: f64,
    pub financing_repay: Option<f64>,
    pub short_balance: f64,
    pub short_volume: f64,
    pub short_sell_volume: f64,
    pub total_balance: f64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginSnapshot {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub created_at: String,
    pub source: String,
    pub source_hash: String,
    pub raw_ids: Vec<String>,
    pub shanghai: Vec<Point>,
    pub shenzhen: Vec<Point>,
    pub hikvision: Vec<Point>,
    pub warnings: Vec<String>,
}
fn nonnegative(value: &Value) -> Result<f64, String> {
    let cleaned = value.as_str().map(|s| Value::String(s.replace(',', "")));
    number(cleaned.as_ref().unwrap_or(value))
        .filter(|n| *n >= 0.0)
        .ok_or("两融字段缺失或非有效非负数".into())
}
fn balanced(p: &Point, tolerance: f64) -> Result<(), String> {
    if (p.financing_balance + p.short_balance - p.total_balance).abs() > tolerance {
        return Err(format!("{} 两融余额与分项不一致", p.date));
    }
    Ok(())
}
fn sse(value: &Value, start: &str, end: &str) -> Result<Vec<Point>, String> {
    let rows = value["result"].as_array().ok_or("沪市两融结果缺失")?;
    if value["pageHelp"]["total"].as_u64() != Some(rows.len() as u64)
        || value["pageHelp"]["pageCount"].as_u64().unwrap_or(2) > 1
    {
        return Err("沪市两融返回分页不完整".into());
    }
    let mut dates = BTreeSet::new();
    let mut result = vec![];
    for row in rows {
        let raw = row["opDate"].as_str().ok_or("沪市两融缺少日期")?;
        let date = NaiveDate::parse_from_str(raw, "%Y%m%d")
            .map_err(|_| "两融日期无效")?
            .to_string();
        if date.as_str() < start
            || date.as_str() > end
            || !dates.insert(date.clone())
            || !row["stockCode"].is_null()
        {
            return Err("沪市两融日期重复、越界或非汇总结果".into());
        }
        let p = Point {
            date,
            financing_balance: nonnegative(&row["rzye"])?,
            financing_buy: nonnegative(&row["rzmre"])?,
            financing_repay: if row["rzche"].is_null() {
                None
            } else {
                Some(nonnegative(&row["rzche"])?)
            },
            short_balance: nonnegative(&row["rqylje"])?,
            short_volume: nonnegative(&row["rqyl"])?,
            short_sell_volume: nonnegative(&row["rqmcl"])?,
            total_balance: nonnegative(&row["rzrqjyzl"])?,
        };
        balanced(&p, 2.0)?;
        result.push(p);
    }
    result.sort_by(|a, b| a.date.cmp(&b.date));
    if result.len() < 2 {
        return Err("沪市两融历史不足两个交易日".into());
    }
    Ok(result
        .into_iter()
        .rev()
        .take(11)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect())
}
fn unit(label: &str, money: bool) -> Result<f64, String> {
    let tokens: &[(&str, f64)] = if money {
        &[("(亿元)", 1e8), ("(万元)", 1e4), ("(元)", 1.0)]
    } else {
        &[("(亿股/亿份)", 1e8), ("(万股/万份)", 1e4), ("(股/份)", 1.0)]
    };
    tokens
        .iter()
        .find(|(text, _)| label.ends_with(text))
        .map(|(_, factor)| *factor)
        .ok_or_else(|| format!("未识别的两融单位：{label}"))
}
fn szse(value: &Value, date: &str, detail: bool) -> Result<Point, String> {
    let tab = if detail { "tab2" } else { "tab1" };
    let table = value
        .as_array()
        .and_then(|a| a.iter().find(|v| v["metadata"]["tabkey"] == tab))
        .ok_or("深市两融表缺失")?;
    let meta = &table["metadata"];
    let rows = table["data"].as_array().ok_or("深市两融数据缺失")?;
    if meta["catalogid"] != "1837_xxpl"
        || meta["subname"] != date
        || rows.len() != 1
        || !table["error"].is_null()
    {
        return Err(format!("{date} 深市两融日期、表类型或数量不符"));
    }
    if detail
        && (meta["recordcount"].as_u64() != Some(1)
            || meta["pagecount"].as_u64() != Some(1)
            || rows[0]["zqdm"] != "002415")
    {
        return Err("深市两融证券过滤或分页不完整".into());
    }
    let read = |field: &str, title: &str, money: bool| -> Result<(f64, f64), String> {
        let label = meta["cols"][field].as_str().ok_or("两融列元数据缺失")?;
        if !label.starts_with(title) {
            return Err("两融字段名称发生变化".into());
        }
        let factor = unit(label, money)?;
        Ok((nonnegative(&rows[0][field])? * factor, factor * 0.005))
    };
    let (financing_balance, fe) = read("jrrzye", "融资余额", true)?;
    let (short_balance, se) = read("jrrjye", "融券余额", true)?;
    let (total_balance, te) = read("jrrzrjye", "融资融券余额", true)?;
    let p = Point {
        date: date.into(),
        financing_balance,
        financing_buy: read("jrrzmr", "融资买入额", true)?.0,
        financing_repay: None,
        short_balance,
        short_volume: read("jrrjyl", "融券余量", false)?.0,
        short_sell_volume: read("jrrjmc", "融券卖出量", false)?.0,
        total_balance,
    };
    balanced(&p, fe + se + te + 1.0)?;
    Ok(p)
}
pub fn sync(root: &Path) -> Result<MarginSnapshot, String> {
    let today = Utc::now()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .date_naive();
    let end = today - Duration::days(1);
    let start = today - Duration::days(45);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(8))
        .user_agent("Mozilla/5.0 KaloInvestment/0.2")
        .build()
        .map_err(|e| e.to_string())?;
    eprintln!("同步沪市两融交易日与汇总");
    let (raw, id) = get_evidence(
        &client,
        root,
        "https://query.sse.com.cn/marketdata/tradedata/queryMargin.do",
        &[
            ("isPagination", "true".into()),
            ("beginDate", start.format("%Y%m%d").to_string()),
            ("endDate", end.format("%Y%m%d").to_string()),
            ("tabType", "".into()),
            ("stockCode", "".into()),
            ("pageHelp.pageSize", "60".into()),
            ("pageHelp.pageNo", "1".into()),
        ],
        "https://www.sse.com.cn/",
    )?;
    let shanghai = sse(&raw, &start.to_string(), &end.to_string())?;
    let mut raw_ids = vec![id];
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&raw).map_err(|e| e.to_string())?);
    let (mut shenzhen, mut hikvision) = (vec![], vec![]);
    for p in &shanghai {
        eprintln!("同步深市及海康两融 {}", p.date);
        let (raw, id) = get_evidence(
            &client,
            root,
            "https://www.szse.cn/api/report/ShowReport/data",
            &[
                ("SHOWTYPE", "JSON".into()),
                ("CATALOGID", "1837_xxpl".into()),
                ("txtDate", p.date.clone()),
                ("txtZqdm", "002415".into()),
                ("tab1PAGENO", "1".into()),
                ("tab2PAGENO", "1".into()),
            ],
            "https://www.szse.cn/disclosure/margin/margin/index.html",
        )?;
        shenzhen.push(szse(&raw, &p.date, false)?);
        hikvision.push(szse(&raw, &p.date, true)?);
        raw_ids.push(id);
        hash.update(serde_json::to_vec(&raw).map_err(|e| e.to_string())?);
    }
    Ok(MarginSnapshot { kind:"marginSnapshot".into(),schema_version:1,id:uuid::Uuid::new_v4().to_string(),created_at:Utc::now().to_rfc3339(),source:"上海证券交易所 / 深圳证券交易所".into(),source_hash:format!("{:x}",hash.finalize()),raw_ids,shanghai,shenzhen,hikvision,warnings:vec!["数据按已公布交易日展示，并非盘中实时。createdAt为本地首次观察，历史发布时间未验证，不直接用于历史策略信号。".into(),"深交所网页融资金额按0.01亿元取整，余额变化为近似值；未提供的融资偿还额留空。汇总包含调出标的证券的余额。".into(),"融券余额受数量和价格共同影响；余额变化不等于融资买入额，也不等于ETF净申购。".into()] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Value {
        json!([{"metadata":{"catalogid":"1837_xxpl","subname":"2026-11-02","tabkey":"tab2","pagecount":1,"recordcount":1,"cols":{"jrrzye":"融资余额<br>(亿元)","jrrzmr":"融资买入额<br>(亿元)","jrrjye":"融券余额<br>(万元)","jrrjyl":"融券余量<br>(万股/万份)","jrrjmc":"融券卖出量<br>(万股/万份)","jrrzrjye":"融资融券余额<br>(亿元)"}},"data":[{"zqdm":"002415","jrrzye":"37.28","jrrzmr":"1.07","jrrjye":"2,403.67","jrrjyl":"68.85","jrrjmc":"1.79","jrrzrjye":"37.52"}],"error":null}])
    }
    #[test]
    fn mixed_units_rounding_and_missing_repayment_are_preserved() {
        let p = szse(&fixture(), "2026-11-02", true).unwrap();
        assert!((p.financing_balance - 3_728_000_000.0).abs() < 1.0);
        assert!((p.short_balance - 24_036_700.0).abs() < 1.0);
        assert!((p.short_volume - 688_500.0).abs() < 1.0);
        assert!(p.financing_repay.is_none());
    }
    #[test]
    fn wrong_date_security_units_and_truncated_pages_fail() {
        assert!(szse(&fixture(), "2026-10-30", true).is_err());
        for (path, value) in [
            ("/0/data/0/zqdm", json!("000001")),
            ("/0/metadata/pagecount", json!(2)),
            ("/0/metadata/cols/jrrzye", json!("融资余额<br>(美元)")),
            ("/0/data/0/jrrzrjye", json!("80")),
        ] {
            let mut f = fixture();
            *f.pointer_mut(path).unwrap() = value;
            assert!(szse(&f, "2026-11-02", true).is_err());
        }
    }
}
