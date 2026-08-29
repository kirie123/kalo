"""paper-broker 测试：合成数据，不联网（所有交易都显式 --price，settle 用 --prices）。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import broker  # noqa: E402


def ns(**kw) -> argparse.Namespace:
    base = {"price": None, "date": None, "name": None, "prices": None}
    base.update(kw)
    return argparse.Namespace(**base)


def test_init_deposit_withdraw(tmp_path: Path):
    d = tmp_path / "acct"
    sys.argv = ["broker", "init", str(d), "--cash", "100000"]
    broker.main()
    st = json.loads((d / "state.json").read_text(encoding="utf-8"))
    assert st["cash"] == 100000.0

    sys.argv = ["broker", "deposit", str(d), "50000"]
    broker.main()
    sys.argv = ["broker", "withdraw", str(d), "20000"]
    broker.main()
    assert broker.replay(broker.load_ledger(d))["cash"] == 130000.0

    sys.argv = ["broker", "withdraw", str(d), "99999999"]
    with pytest.raises(SystemExit):
        broker.main()


def test_buy_rules_and_fees(tmp_path: Path):
    d = tmp_path / "acct"
    sys.argv = ["broker", "init", str(d), "--cash", "100000"]
    broker.main()

    # 非整手拒绝
    with pytest.raises(SystemExit):
        broker.cmd_buy(d, ns(code="600519", qty=50, price=100.0, date="2026-08-28"))
    # 现金不足拒绝（1000 股 * 100 = 10 万 + 佣金 25 > 10 万）
    with pytest.raises(SystemExit):
        broker.cmd_buy(d, ns(code="600519", qty=1000, price=100.0, date="2026-08-28"))
    # 正常买入：佣金 max(5, 100*100*0.00025=2.5) = 5
    broker.cmd_buy(d, ns(code="600519", qty=100, price=100.0, date="2026-08-28"))
    st = broker.replay(broker.load_ledger(d))
    assert st["cash"] == 100000 - 10000 - 5
    assert st["positions"]["600519"]["lots"][0]["qty"] == 100


def test_t1_rule(tmp_path: Path):
    d = tmp_path / "acct"
    sys.argv = ["broker", "init", str(d), "--cash", "100000"]
    broker.main()
    broker.cmd_buy(d, ns(code="600519", qty=100, price=100.0, date="2026-08-28"))
    # 当日买入当日不可卖
    with pytest.raises(SystemExit):
        broker.cmd_sell(d, ns(code="600519", qty=100, price=110.0, date="2026-08-28"))
    # 次日可卖
    broker.cmd_sell(d, ns(code="600519", qty=100, price=110.0, date="2026-08-29"))
    st = broker.replay(broker.load_ledger(d))
    assert "600519" not in st["positions"]
    # 卖出：11000 - 佣金 5 - 印花税 11 = 10984；已实现 = 10984 - 10000 = 984
    assert st["realized_pnl"] == 984.0
    assert st["cash"] == 100000 - 10000 - 5 + 10984


def test_sell_without_position_rejected(tmp_path: Path):
    d = tmp_path / "acct"
    sys.argv = ["broker", "init", str(d), "--cash", "1000"]
    broker.main()
    with pytest.raises(SystemExit):
        broker.cmd_sell(d, ns(code="000001", qty=100, price=10.0, date="2026-08-28"))


def test_settle_and_pnl(tmp_path: Path, capsys):
    d = tmp_path / "acct"
    sys.argv = ["broker", "init", str(d), "--cash", "100000"]
    broker.main()
    broker.cmd_buy(d, ns(code="600519", qty=100, price=100.0, date="2026-08-27", name="贵州茅台"))
    broker.cmd_settle(d, ns(date="2026-08-28", prices='{"600519": 110.0}'))
    capsys.readouterr()
    broker.cmd_pnl(d, ns())
    out = json.loads(capsys.readouterr().out)
    # 现金 89995 + 持仓 11000 = 100995；总收益 995（含 5 元佣金）
    assert out["last_total_value"] == 100995.0
    assert out["total_pnl"] == 995.0
    assert out["settle_days"] == 1


def test_verify_detects_tampering(tmp_path: Path):
    d = tmp_path / "acct"
    sys.argv = ["broker", "init", str(d), "--cash", "100000"]
    broker.main()
    broker.cmd_buy(d, ns(code="600519", qty=100, price=100.0, date="2026-08-27"))
    assert broker.verify(d) == []

    # 手改 state.json 的现金 → verify 必须报警
    state_path = d / "state.json"
    st = json.loads(state_path.read_text(encoding="utf-8"))
    st["cash"] = 999999.0
    state_path.write_text(json.dumps(st), encoding="utf-8")
    problems = broker.verify(d)
    assert any("现金" in p for p in problems)

    # 手改账本一条记录（价格 100 → 1）→ 哈希链必须断
    lines = (d / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    entry = json.loads(lines[-1])
    entry["price"] = 1.0
    lines[-1] = json.dumps(entry, ensure_ascii=False)
    (d / "ledger.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    problems = broker.verify(d)
    assert any("hash" in p for p in problems)


def test_verify_ok_on_clean_ledger(tmp_path: Path, capsys):
    d = tmp_path / "acct"
    sys.argv = ["broker", "init", str(d), "--cash", "10000"]
    broker.main()
    broker.cmd_buy(d, ns(code="000001", qty=100, price=10.0, date="2026-08-27"))
    broker.cmd_sell(d, ns(code="000001", qty=100, price=11.0, date="2026-08-28"))
    broker.cmd_settle(d, ns(date="2026-08-28", prices="{}"))
    sys.argv = ["broker", "verify", str(d)]
    broker.main()
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["ok"] is True
