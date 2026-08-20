"""源注册表：读 sources.yaml，做 URL 模板替换与字段抽取。

这一层只认「字段」，不认「股票」「收益率」这些领域概念——领域知识全在
sources.yaml 与各 skill 的 SKILL.md 里。抽取器刻意做小到四种形态且不含
任何求值器，与 gateway/src/feeds.ts 同一套取舍：这些配置会被模型读写，
一个能求值的字段等于开了任意代码执行的口子。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import yaml

SOURCES_FILE = Path(__file__).resolve().parent.parent / "sources.yaml"


@dataclass
class Source:
    id: str
    name: str
    kind: str  # http | akshare
    group: str = "macro"
    url: str | None = None
    call: str | None = None  # akshare 函数名
    encoding: str = "utf-8"
    headers: dict[str, str] = field(default_factory=dict)
    method: str = "GET"  # GET | POST（巨潮的公告查询只认 POST）
    body: dict[str, str] = field(default_factory=dict)
    rate: str = "normal"  # strict | normal
    ttl: int = 300
    parse: dict[str, Any] = field(default_factory=dict)
    fields: dict[str, dict] = field(default_factory=dict)
    derive: list[dict] = field(default_factory=list)
    # group=stock 的源带 {code} 之类的占位符，probe 时用这组参数实测
    probe_with: dict[str, str] = field(default_factory=dict)
    verified_at: str | None = None
    verified_sample: str | None = None

    @property
    def is_strict(self) -> bool:
        return self.rate == "strict"


def load_sources(path: Path | None = None) -> list[Source]:
    raw = yaml.safe_load((path or SOURCES_FILE).read_text(encoding="utf-8"))
    return [Source(**item) for item in raw]


def find_source(source_id: str, path: Path | None = None) -> Source | None:
    return next((s for s in load_sources(path) if s.id == source_id), None)


def render_url(url: str, today: date | None = None, params: dict[str, str] | None = None) -> str:
    """占位符替换：{today} 恒为 YYYYMMDD，其余由调用方按 params 提供。

    刻意不做通用模板引擎——占位符只是字符串替换，没有表达式、没有默认值
    逻辑。个股源用到的 {code} / {secid} / {secucode} 由 stock.py 算好传进来。
    """
    d = today or date.today()
    out = url.replace("{today}", d.strftime("%Y%m%d"))
    for key, value in (params or {}).items():
        out = out.replace("{" + key + "}", str(value))
    return out


# ---------------------------------------------------------------------------
# 字段抽取
# ---------------------------------------------------------------------------


def dig(data: Any, path: str) -> Any:
    """点号路径取值；数字段既可能是数组下标，也可能是 dict 的数字键。

    东财的 `data.diff` 有时是数组、有时是 {"0": {...}} 形态的 dict，
    两种都要能走通。
    """
    cur = data
    for seg in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, list):
            if not seg.lstrip("-").isdigit():
                return None
            idx = int(seg)
            cur = cur[idx] if -len(cur) <= idx < len(cur) else None
        elif isinstance(cur, dict):
            cur = cur.get(seg)
        else:
            return None
    return cur


def _shape(value: Any, spec: dict) -> Any:
    """数值整形：scale → digits。

    两个选项都没写时不做数字解析，原样保留文本——否则 "000001" 会变成 1。
    """
    if value is None:
        return None
    if "scale" not in spec and "digits" not in spec:
        return value
    try:
        num = float(value)
    except (TypeError, ValueError):
        return value
    if "scale" in spec:
        num *= float(spec["scale"])
    if "digits" in spec:
        num = round(num, int(spec["digits"]))
    return num


def extract(payload: Any, spec: dict, text: str = "") -> Any:
    """四选一的抽取器。抽不到返回 None（不是异常）——源改字段时那一格空着，
    其他格照常。"""
    if "const" in spec:
        return spec["const"]

    if "path" in spec:
        return _shape(dig(payload, spec["path"]), spec)

    if "regex" in spec:
        m = re.search(spec["regex"], text)
        if not m:
            return None
        group = int(spec.get("group", 1))
        try:
            return _shape(m.group(group), spec)
        except IndexError:
            return None

    if "index" in spec:
        parts = text.split(spec.get("sep", ","))
        idx = int(spec["index"])
        if not (-len(parts) <= idx < len(parts)):
            return None
        return _shape(parts[idx], spec)

    return None


def apply_derive(payload: Any, rules: list[dict]) -> dict[str, Any]:
    """派生字段。目前只有 count_where 一种：数一个数组里满足条件的元素个数。

    刻意不做通用表达式——需要真正的计算时，那属于 metrics.py 的活。
    """
    out: dict[str, Any] = {}
    ops = {
        ">": lambda a, b: a > b,
        ">=": lambda a, b: a >= b,
        "<": lambda a, b: a < b,
        "<=": lambda a, b: a <= b,
        "==": lambda a, b: a == b,
        "!=": lambda a, b: a != b,
    }
    for rule in rules:
        if rule.get("type") != "count_where":
            continue
        rows = dig(payload, rule["rows"])
        if isinstance(rows, dict):
            rows = list(rows.values())
        if not isinstance(rows, list):
            out[rule["name"]] = None
            continue
        op = ops.get(rule.get("op", "=="))
        target = rule.get("value")
        count = 0
        for row in rows:
            val = row.get(rule["field"]) if isinstance(row, dict) else None
            if val is None or op is None:
                continue
            try:
                if op(float(val), float(target)):
                    count += 1
            except (TypeError, ValueError):
                continue
        out[rule["name"]] = count
    return out
