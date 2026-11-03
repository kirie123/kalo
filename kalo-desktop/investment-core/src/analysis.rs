//! Deterministic evidence shared by the model tools and panel.
use crate::{Snapshot, Spec};
use serde_json::{json, Value};

pub fn defaults(snapshot: &Snapshot) -> Option<Spec> {
    let bars = &snapshot.instruments.first()?.bars;
    Some(Spec {
        snapshot_id: snapshot.id.clone(),
        codes: Some(
            snapshot
                .instruments
                .iter()
                .map(|i| i.code.clone())
                .collect(),
        ),
        start: bars
            .get(21.max(bars.len().saturating_sub(60)))?
            .date
            .clone(),
        end: bars.last()?.date.clone(),
        capital: 1_000_000.0,
        lookback: 20,
        rebalance: 5,
        holdings: 2.min(snapshot.instruments.len()),
        commission_bps: 2.5,
        minimum_fee: 5.0,
        slippage_bps: 5.0,
        flow_filter: false,
    })
}

pub fn describe(snapshot: &Snapshot) -> Value {
    json!({"id":snapshot.id,"createdAt":snapshot.created_at,"source":snapshot.source,
        "warnings":snapshot.warnings,"defaultSpec":defaults(snapshot),
        "instruments":snapshot.instruments.iter().map(|i| json!({"code":i.code,"name":i.name,"category":crate::universe::find(&i.code).map(|e| e.category),
            "firstDate":i.bars.first().map(|b| &b.date),"lastDate":i.bars.last().map(|b| &b.date),
            "bars":i.bars.len(),"fundPoints":i.funds.len()})).collect::<Vec<_>>()})
}

pub fn flows(snapshot: &Snapshot, days: usize) -> Result<Value, String> {
    if ![1, 5, 20].contains(&days) {
        return Err("资金窗口仅支持 1、5、20 个交易日".into());
    }
    let mut rows = Vec::new();
    for instrument in &snapshot.instruments {
        let dates: Vec<_> = instrument
            .bars
            .iter()
            .rev()
            .take(days)
            .rev()
            .map(|b| &b.date)
            .collect();
        let mut total = 0.0;
        let mut missing = Vec::new();
        let mut evidence = Vec::new();
        for date in &dates {
            let point = instrument.funds.iter().find(|p| &p.date == *date);
            if let Some(n) = point.and_then(|p| p.net_flow).filter(|n| n.is_finite()) {
                total += n;
            } else {
                missing.push(*date);
            }
            evidence.push(json!({"date":date,"observation":point}));
        }
        let valid = dates.len() - missing.len();
        rows.push(json!({"code":instrument.code,"name":instrument.name,"category":crate::universe::find(&instrument.code).map(|e| e.category),
            "start":dates.first(),"end":dates.last(),"validDays":valid,"requestedDays":days,
            "netFlowYuan":if valid == days {Some(total)} else {None},
            "missingDates":missing,"evidence":evidence}));
    }
    let mut ranking: Vec<_> = rows
        .iter()
        .filter_map(|r| Some((r["code"].as_str()?, r["netFlowYuan"].as_f64()?)))
        .collect();
    ranking.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    Ok(
        json!({"snapshotId":snapshot.id,"capturedAt":snapshot.created_at,"days":days,
        "source":snapshot.source,"unit":"CNY","rows":rows,
        "ranking":ranking.iter().map(|(code,flow)|json!({"code":code,"netFlowYuan":flow})).collect::<Vec<_>>(),
        "warnings":snapshot.warnings,
        "method":"相邻交易日份额差 × 当日单位净值；净申购估算，不能拆分总申购/总赎回，也不是二级市场主力资金。缺口不填零；availableAt 为本地观察时间，不能推定历史可得。"}),
    )
}

pub fn compact_result(value: &Value) -> Result<Value, String> {
    if value["kind"] == "marginSnapshot" {
        return Ok(value.clone());
    }
    if value["kind"] == "marketDataset" {
        let data: crate::market_model::Dataset =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        return Ok(
            json!({"kind":data.kind,"id":data.id,"createdAt":data.created_at,"security":data.security,"timeframe":data.timeframe,"source":data.source,"sourceHash":data.source_hash,"bars":data.bars.len(),"sessions":data.sessions,"firstBar":data.bars.first(),"lastBar":data.bars.last(),"warnings":data.warnings,"defaultSpec":crate::strategy_runtime::defaults(&data),"runtime":crate::strategy_runtime::contract()}),
        );
    }
    if value["kind"] == "scriptReport" {
        let mut report = value.clone();
        let obj = report.as_object_mut().ok_or("代码报告格式无效")?;
        let orders = obj.remove("orders").unwrap_or(json!([]));
        let equity = obj.remove("equity").unwrap_or(json!([]));
        let rows = orders.as_array().cloned().unwrap_or_default();
        obj.insert(
            "orders".into(),
            json!(rows.iter().take(200).collect::<Vec<_>>()),
        );
        obj.insert("ordersTruncated".into(), json!(rows.len() > 200));
        obj.insert("orderCount".into(), json!(rows.len()));
        obj.insert(
            "costBreakdown".into(),
            json!({
                "commission": rows.iter().filter_map(|o| o["commission"].as_f64()).sum::<f64>(),
                "stampTax": rows.iter().filter_map(|o| o["stampTax"].as_f64()).sum::<f64>(),
                "transferFee": rows.iter().filter_map(|o| o["transferFee"].as_f64()).sum::<f64>()
            }),
        );
        obj.insert("inventoryRule".into(), json!("T+1只锁定当日新买股份，剩余旧仓仍可卖。例如底仓1000股、卖100再买100后，position=1000、sellable=900，仍可卖旧仓900股；并非每天最多做T一次。是否继续下单由代码条件决定。state里的计数为策略意图，不等于实际成交。归因须核对逐笔订单，不从8笔成交推断每笔均亏或每日仅一次。"));
        obj.insert(
            "filledOrderCount".into(),
            json!(orders.as_array().map_or(0, |a| a
                .iter()
                .filter(|o| o["quantity"].as_u64().unwrap_or(0) > 0)
                .count())),
        );
        obj.insert(
            "rejectedOrders".into(),
            json!(orders
                .as_array()
                .map(|a| a
                    .iter()
                    .filter(|o| o["quantity"] == 0)
                    .take(20)
                    .collect::<Vec<_>>())
                .unwrap_or_default()),
        );
        obj.insert(
            "finalAccount".into(),
            equity
                .as_array()
                .and_then(|a| a.last())
                .cloned()
                .unwrap_or(Value::Null),
        );
        obj.insert("costDefinition".into(), json!("costs为佣金+印花税+过户费，滑点已进入成交价；excessPnl相对于持有同等初始现金与底仓，不等于总收益。逐笔明细在原生面板。"));
        return Ok(report);
    }
    if value.get("instruments").is_some() {
        let snapshot: Snapshot =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        return Ok(describe(&snapshot));
    }
    let mut report = value.clone();
    if let Some(obj) = report.as_object_mut() {
        let trades = obj.remove("trades").unwrap_or(json!([]));
        obj.insert(
            "orderCount".into(),
            json!(trades.as_array().map_or(0, Vec::len)),
        );
        let filled = trades.as_array().map_or(0, |rows| {
            rows.iter()
                .filter(|t| t["quantity"].as_f64().is_some_and(|q| q > 0.0))
                .count()
        });
        let rejected = trades.as_array().map_or(0, Vec::len) - filled;
        obj.insert("filledTradeCount".into(), json!(filled));
        obj.insert("rejectedOrderCount".into(), json!(rejected));
        let traded_codes: std::collections::BTreeSet<_> = trades
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["quantity"].as_f64().is_some_and(|q| q > 0.0))
            .filter_map(|t| t["code"].as_str())
            .collect();
        obj.insert("tradedCodes".into(), json!(traded_codes));
        obj.insert("strategyDefinition".into(), json!("每只标的独立检查正动量；holdings 是最多持仓数及单标的预算分母，并非必须买满。符合条件的不足 holdings 时，其余预算留现金；不要求池内标的同时开仓或同时清仓。"));
        obj.insert(
            "rejectedOrders".into(),
            json!(trades
                .as_array()
                .into_iter()
                .flatten()
                .filter(|t| t["quantity"].as_f64() == Some(0.0))
                .map(|t| json!({"date":t["date"],"code":t["code"],"reason":t["reason"]}))
                .collect::<Vec<_>>()),
        );
        obj.insert("costDefinition".into(), json!("fees 仅为佣金合计；滑点已计入成交价和权益，不能把 fees 当成全部交易成本。orderCount 包括未成交记录，实际成交笔数用 filledTradeCount。"));
        let equity = obj.remove("equity").unwrap_or(json!([]));
        obj.insert(
            "tradingDays".into(),
            json!(equity.as_array().map_or(0, Vec::len)),
        );
        obj.insert(
            "lastEquity".into(),
            equity
                .as_array()
                .and_then(|a| a.last())
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Bar, FundPoint, Instrument};
    #[test]
    fn report_summary_separates_fills_from_rejected_orders() {
        let compact = compact_result(&json!({"trades":[{"quantity":100,"code":"588300.SH"},{"quantity":0,"code":"510300.SH","date":"2026-10-30","reason":"滑点超出日内范围"},{"quantity":200,"code":"588300.SH"}],"equity":[{"equity":1000}],"fees":5})).unwrap();
        assert_eq!(compact["orderCount"], 3);
        assert_eq!(compact["filledTradeCount"], 2);
        assert_eq!(compact["rejectedOrderCount"], 1);
        assert_eq!(compact["tradedCodes"], json!(["588300.SH"]));
        assert_eq!(compact["rejectedOrders"][0]["reason"], "滑点超出日内范围");
        assert_eq!(compact["tradingDays"], 1);
        assert_eq!(compact["lastEquity"]["equity"], 1000);
        assert!(compact.get("trades").is_none());
        assert!(compact["costDefinition"].as_str().unwrap().contains("滑点"));
    }
    #[test]
    fn missing_days_are_not_zero_or_ranked_and_evidence_is_kept() {
        let bar = |date: &str| Bar {
            date: date.into(),
            open: 1.0,
            high: 1.0,
            low: 1.0,
            close: 1.0,
            adjusted_close: 1.0,
            volume: 100.0,
        };
        let mut i = Instrument {
            code: "a".into(),
            name: "A".into(),
            category: String::new(),
            bars: vec![bar("2026-01-05"), bar("2026-01-06")],
            funds: vec![FundPoint {
                date: "2026-01-06".into(),
                shares: Some(10.0),
                nav: Some(1.0),
                net_flow: Some(-5.0),
                available_at: "2026-01-07T01:00:00Z".into(),
            }],
        };
        let mut s = Snapshot {
            id: "snapshot".into(),
            created_at: "now".into(),
            source: "source".into(),
            instruments: vec![i.clone()],
            warnings: vec![],
        };
        let one = flows(&s, 1).unwrap();
        assert_eq!(one["rows"][0]["netFlowYuan"], -5.0);
        assert_eq!(
            one["rows"][0]["evidence"][0]["observation"]["availableAt"],
            "2026-01-07T01:00:00Z"
        );
        let five = flows(&s, 5).unwrap();
        assert!(five["rows"][0]["netFlowYuan"].is_null());
        assert_eq!(five["ranking"], json!([]));
        i.funds.clear();
        s.instruments.push(i);
        assert_eq!(
            flows(&s, 1).unwrap()["rows"][1]["missingDates"],
            json!(["2026-01-06"])
        );
        assert!(flows(&s, 7).is_err());
    }
}
