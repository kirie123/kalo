//! Frozen, evidenced distribution terms. Prices remain raw for execution.
use crate::market_model::{Dataset, MarketBar};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorporateAction {
    pub id: String,
    pub record_date: String,
    pub ex_date: String,
    pub pay_date: Option<String>,
    pub listing_date: Option<String>,
    pub cash_per_share: f64,
    pub bonus_per_share: f64,
    pub transfer_per_share: f64,
    pub announced_at: String,
    pub reference_price: f64,
    pub source: String,
    pub evidence_ids: Vec<String>,
}
impl CorporateAction {
    pub fn shares(&self) -> f64 {
        self.bonus_per_share + self.transfer_per_share
    }
    pub fn validate(&self) -> Result<(), String> {
        for date in [&self.record_date, &self.ex_date, &self.announced_at]
            .into_iter()
            .chain(self.pay_date.iter())
            .chain(self.listing_date.iter())
        {
            let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| "公司行为日期无效")?;
            if d.to_string() != *date {
                return Err("公司行为日期非标准格式".into());
            }
        }
        if self.id.is_empty()
            || self.source.is_empty()
            || self.evidence_ids.is_empty()
            || self.record_date >= self.ex_date
            || self.announced_at > self.record_date
            || [
                self.cash_per_share,
                self.bonus_per_share,
                self.transfer_per_share,
            ]
            .iter()
            .any(|n| !n.is_finite() || *n < 0.0 || *n > 100.0)
            || self.cash_per_share + self.shares() <= 0.0
            || !self.reference_price.is_finite()
            || self.reference_price <= 0.0
        {
            return Err("公司行为条款、证据或除权参考价无效".into());
        }
        if self.cash_per_share > 0.0 && self.pay_date.as_ref().is_none_or(|d| d < &self.ex_date) {
            return Err("缺少有效现金到账日".into());
        }
        if self.shares() > 0.0 && self.listing_date.as_ref().is_none_or(|d| d < &self.ex_date) {
            return Err("缺少有效送转股份上市日".into());
        }
        Ok(())
    }
}

pub fn validate(data: &Dataset, start: usize, end: usize, base: u64) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut last_date = "";
    for a in &data.corporate_actions {
        a.validate()?;
        if !seen.insert(&a.ex_date) {
            return Err("同日重复公司行为，须重新核实数据".into());
        }
        if a.ex_date.as_str() <= last_date {
            return Err("公司行为时间乱序，须重新同步".into());
        }
        last_date = &a.ex_date;
        if a.ex_date >= data.bars[start].session && a.record_date <= data.bars[end].session {
            let record = data
                .sessions
                .iter()
                .position(|d| d == &a.record_date)
                .ok_or("公司行为缺少登记日行情，请同步更长历史")?;
            if data.sessions.get(record + 1) != Some(&a.ex_date) {
                return Err("登记日与除权日之间行情不连续，不能推断权益".into());
            }
        }
        let last = a
            .pay_date
            .iter()
            .chain(a.listing_date.iter())
            .chain(std::iter::once(&a.ex_date))
            .max()
            .unwrap();
        if base > 0 && a.record_date < data.bars[start].session && last >= &data.bars[start].session
        {
            return Err(format!(
                "{} 的登记日在回测起点前，初始底仓未提供待到账权益；请从 {} 或更早开始",
                a.id, a.record_date
            ));
        }
    }
    Ok(())
}

/// Point-in-time adjustment: only events effective by `as_of` may alter history.
pub fn history(data: &Dataset, from: usize, to: usize) -> Vec<MarketBar> {
    let as_of = &data.bars[to].session;
    let mut rows = data.bars[from..=to].to_vec();
    for a in &data.corporate_actions {
        if &a.ex_date > as_of {
            continue;
        }
        let ratio = 1.0 + a.shares();
        for b in &mut rows {
            if b.session == a.ex_date {
                b.previous_close = a.reference_price;
            }
            if b.session >= a.ex_date {
                continue;
            }
            b.open = (b.open - a.cash_per_share) / ratio;
            b.high = (b.high - a.cash_per_share) / ratio;
            b.low = (b.low - a.cash_per_share) / ratio;
            b.close = (b.close - a.cash_per_share) / ratio;
            b.previous_close = (b.previous_close - a.cash_per_share) / ratio;
            b.volume *= ratio;
        }
    }
    rows
}
