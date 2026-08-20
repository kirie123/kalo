"""历史落盘：~/.kalo/market/daily.jsonl

append-only，一行一天。选 JSONL 而不是数据库或 CSV：
  - 一行一个原子写，中途断电最多丢当天那一行
  - 字段可以随时增加（新加一条源不需要迁移旧数据）
  - 用任何编辑器 / rg / pandas 都能直接读

同日重复写入按「后写覆盖」处理——手工补跑不该产生两行。
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

MARKET_DIR = Path.home() / ".kalo" / "market"
DAILY_FILE = MARKET_DIR / "daily.jsonl"


def read_all(path: Path | None = None) -> list[dict]:
    """按日期升序读全部历史。坏行跳过而不是让整个分析失败。"""
    f = path or DAILY_FILE
    if not f.exists():
        return []
    rows = []
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    rows.sort(key=lambda r: r.get("date", ""))
    return rows


def series(rows: list[dict], key: str) -> list[Any]:
    """取某个字段的时间序列（缺失的日子保留 None，由 metrics 层清理）。"""
    return [r.get(key) for r in rows]


def append(record: dict, path: Path | None = None) -> bool:
    """写入一天。同日已存在则覆盖那一行。返回是否为新增日期。"""
    f = path or DAILY_FILE
    f.parent.mkdir(parents=True, exist_ok=True)

    today = record.get("date") or date.today().isoformat()
    record["date"] = today

    existing = read_all(f)
    is_new = not any(r.get("date") == today for r in existing)

    if is_new:
        with f.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return True

    # 覆盖同日那行：整体重写（历史规模是「一天一行」，重写成本可忽略）
    merged = [record if r.get("date") == today else r for r in existing]
    tmp = f.with_suffix(".tmp")
    tmp.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in merged) + "\n",
        encoding="utf-8",
    )
    tmp.replace(f)
    return False
