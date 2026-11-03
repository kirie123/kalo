//! Tax-before-dividend research ledger; receivables are never spendable cash.
use crate::corporate_actions::CorporateAction;
use serde::{Deserialize, Serialize};

pub fn cents(v: f64) -> i64 {
    (v * 100.0).round() as i64
}
pub fn yuan(v: i64) -> f64 {
    v as f64 / 100.0
}

#[derive(Clone)]
pub(crate) struct Entitlement {
    action: CorporateAction,
    shares: u64,
    added: u64,
    cash: i64,
    ex: bool,
    paid: bool,
    listed: bool,
}

#[derive(Default)]
pub struct Account {
    pub cash: i64,
    /// Delivered holdings, including T+1 locked shares; excludes pending bonus shares.
    pub position: u64,
    pub sellable: u64,
    pub cost: i64,
    pub realized: i64,
    pub dividend_income: i64,
    pub receivable: i64,
    pub pending_shares: u64,
    pub(crate) entitlements: Vec<Entitlement>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEntry {
    pub account: String,
    pub action_id: String,
    pub date: String,
    pub stage: String,
    pub eligible_shares: u64,
    pub cash_delta: f64,
    pub share_delta: u64,
    pub receivable: f64,
    pub pending_shares: u64,
    pub position: u64,
    pub sellable: u64,
    pub average_cost: f64,
}

impl Account {
    pub fn new(cash: f64, position: u64, price: f64) -> Self {
        Self {
            cash: cents(cash),
            position,
            sellable: position,
            cost: cents(price * position as f64),
            ..Self::default()
        }
    }
    pub fn average_cost(&self) -> f64 {
        if self.position + self.pending_shares == 0 {
            0.0
        } else {
            yuan(self.cost) / (self.position + self.pending_shares) as f64
        }
    }
    pub fn value(&self, price: f64) -> f64 {
        yuan(self.cash + self.receivable) + (self.position + self.pending_shares) as f64 * price
    }
    pub fn bought(&mut self, quantity: u64, expense: i64) {
        self.cost += expense;
        let _ = quantity;
    }
    /// Called before the position is reduced. Dividends remain separate income.
    pub fn sold(&mut self, quantity: u64, proceeds: i64) {
        let removed = if quantity == self.position + self.pending_shares {
            self.cost
        } else {
            cents(self.average_cost() * quantity as f64)
        };
        self.cost -= removed;
        self.realized += proceeds - removed;
    }
    fn entry(
        &self,
        e: &Entitlement,
        date: &str,
        stage: &str,
        name: &str,
        cash: i64,
        shares: u64,
    ) -> ActionEntry {
        ActionEntry {
            account: name.into(),
            action_id: e.action.id.clone(),
            date: date.into(),
            stage: stage.into(),
            eligible_shares: e.shares,
            cash_delta: yuan(cash),
            share_delta: shares,
            receivable: yuan(self.receivable),
            pending_shares: self.pending_shares,
            position: self.position,
            sellable: self.sellable,
            average_cost: self.average_cost(),
        }
    }
    pub fn record(
        &mut self,
        actions: &[CorporateAction],
        date: &str,
        name: &str,
        ledger: &mut Vec<ActionEntry>,
    ) -> Result<(), String> {
        for a in actions.iter().filter(|a| a.record_date == date) {
            if self.entitlements.iter().any(|e| e.action.id == a.id) {
                return Err("公司行为重复登记".into());
            }
            if self.pending_shares > 0 {
                return Err("前次送转未上市又发生权益登记，尚不能确定登记数量".into());
            }
            let exact = self.position as f64 * a.shares();
            if (exact - exact.round()).abs() > 1e-7 {
                return Err(format!(
                    "{} 产生零碎送转股，无法从单账户重建全市场零碎股分配；本次回测未生成报告",
                    a.id
                ));
            }
            let e = Entitlement {
                action: a.clone(),
                shares: self.position,
                added: exact.round() as u64,
                cash: cents(self.position as f64 * a.cash_per_share),
                ex: false,
                paid: false,
                listed: false,
            };
            ledger.push(self.entry(&e, date, "登记", name, 0, 0));
            self.entitlements.push(e);
        }
        Ok(())
    }
    pub fn open(&mut self, date: &str, name: &str, ledger: &mut Vec<ActionEntry>) {
        self.sellable = self.position;
        let mut pending = std::mem::take(&mut self.entitlements);
        for e in &mut pending {
            if !e.ex && e.action.ex_date.as_str() <= date {
                self.receivable += e.cash;
                self.dividend_income += e.cash;
                self.pending_shares += e.added;
                e.ex = true;
                ledger.push(self.entry(e, date, "除权确权", name, 0, e.added));
            }
            if e.ex && !e.paid && e.action.pay_date.as_deref().is_some_and(|d| d <= date) {
                self.receivable -= e.cash;
                self.cash += e.cash;
                e.paid = true;
                ledger.push(self.entry(e, date, "现金到账", name, e.cash, 0));
            }
            if e.ex && !e.listed && e.action.listing_date.as_deref().is_some_and(|d| d <= date) {
                self.pending_shares -= e.added;
                self.position += e.added;
                self.sellable += e.added;
                e.listed = true;
                ledger.push(self.entry(e, date, "股份上市", name, 0, e.added));
            }
        }
        self.entitlements = pending;
    }
}

#[cfg(test)]
#[path = "corporate_ledger_tests.rs"]
mod tests;
