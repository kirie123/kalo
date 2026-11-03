//! SZSE historical ETF size. Dates are observation dates, amounts are 万份.
use crate::sources::{get, number};
use reqwest::blocking::Client;
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

fn parse(value: &Value, code: &str, dates: &[String]) -> Result<BTreeMap<String, f64>, String> {
    let report = value
        .as_array()
        .and_then(|a| a.first())
        .ok_or("基金规模报表缺失")?;
    let meta = &report["metadata"];
    if !report["error"].is_null()
        || meta["catalogid"] != "scsj_fund_jjgm"
        || meta["pagecount"].as_u64().unwrap_or(2) > 1
        || !meta["cols"]["current_size"]
            .as_str()
            .unwrap_or("")
            .contains("万份")
    {
        return Err("基金规模报表类型、单位或分页异常，请重试".into());
    }
    let rows = report["data"].as_array().ok_or("基金规模明细缺失")?;
    if meta["recordcount"].as_u64() != Some(rows.len() as u64) {
        return Err("基金规模记录不完整".into());
    }
    let mut result = BTreeMap::new();
    for row in rows {
        if row["fund_code"].as_str() != Some(code) {
            return Err("基金规模返回了其他证券".into());
        }
        let date = row["size_date"].as_str().ok_or("基金规模统计日缺失")?;
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "基金规模统计日无效")?;
        if !dates.iter().any(|d| d == date) {
            return Err("基金规模返回了窗口外日期".into());
        }
        let qty = number(&row["current_size"])
            .filter(|q| *q > 0.0)
            .ok_or("基金份额无效")?
            * 10000.0;
        if !qty.is_finite() || result.insert(date.into(), qty).is_some() {
            return Err("基金份额溢出或统计日重复".into());
        }
    }
    Ok(result)
}

pub fn shares(
    client: &Client,
    root: &Path,
    code: &str,
    dates: &[String],
) -> Result<BTreeMap<String, f64>, String> {
    let start = dates.iter().min().ok_or("行情窗口为空")?;
    let end = dates.iter().max().ok_or("行情窗口为空")?;
    let value = get(
        client,
        root,
        "https://www.szse.cn/api/report/ShowReport/data",
        &[
            ("SHOWTYPE", "JSON".into()),
            ("CATALOGID", "scsj_fund_jjgm".into()),
            ("TABKEY", "tab1".into()),
            ("jjlb", "ETF".into()),
            ("txtDm", code.into()),
            ("txtStart", start.clone()),
            ("txtEnd", end.clone()),
            ("PAGENO", "1".into()),
        ],
        "https://www.szse.cn/market/fund/volume/etf/index.html",
    )?;
    parse(&value, code, dates)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::json!([{"metadata":{"catalogid":"scsj_fund_jjgm","pagecount":1,"recordcount":1,"cols":{"current_size":"基金规模<br>(万份)"}},"data":[{"size_date":"2026-11-02","fund_code":"159915","current_size":"3,916,845.49"}],"error":null}])
    }
    fn read(v: &Value) -> Result<BTreeMap<String, f64>, String> {
        parse(v, "159915", &["2026-11-02".into()])
    }
    #[test]
    fn units_and_date_are_preserved() {
        assert_eq!(read(&fixture()).unwrap()["2026-11-02"], 39168454900.0);
    }
    #[test]
    fn rejects_wrong_security_date_unit_and_truncated_pages() {
        for (path, replacement) in [
            ("/0/data/0/fund_code", serde_json::json!("159949")),
            ("/0/data/0/size_date", serde_json::json!("2026-11-03")),
            ("/0/data/0/current_size", serde_json::json!("--")),
            ("/0/metadata/cols/current_size", serde_json::json!("份")),
            ("/0/metadata/pagecount", serde_json::json!(2)),
            ("/0/metadata/recordcount", serde_json::json!(2)),
        ] {
            let mut v = fixture();
            *v.pointer_mut(path).unwrap() = replacement;
            assert!(read(&v).is_err(), "{path}");
        }
    }
    #[test]
    fn rejects_duplicates_instead_of_double_counting() {
        let mut v = fixture();
        let row = v[0]["data"][0].clone();
        v[0]["data"].as_array_mut().unwrap().push(row);
        v[0]["metadata"]["recordcount"] = 2.into();
        assert!(read(&v).is_err());
    }
}
