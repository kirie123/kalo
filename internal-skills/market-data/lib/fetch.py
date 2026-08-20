"""取数层：把一条 Source 变成一组字段值。

两条铁律，都是实测倒逼出来的：

1. 失败是常态，不是异常。东财会限流、源会改字段、非交易时段会返回空。
   单源失败只让那几个字段变 null 并进 errors[]，绝不中断整体。
2. 缓存优先。strict 源（push2*）实测会整体拒服务，能不打就不打。

输出永远是「事实」——数值、时间、错误。这一层不下任何结论。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

import requests

from . import cache
from .registry import Source, apply_derive, dig, extract, render_url

TIMEOUT = 8
MAX_BYTES = 2 * 1024 * 1024
# strict 源退避重试；normal 源少试一次就够（实测它们很少失败）
BACKOFF_STRICT = (1, 3, 9)
BACKOFF_NORMAL = (1, 3)

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}


@dataclass
class FetchResult:
    source_id: str
    ok: bool
    values: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    ms: int = 0
    from_cache: bool = False


def _http_payload(src: Source, use_proxy: bool, params: dict[str, str] | None = None) -> tuple[Any, str]:
    """发一次请求，返回 (解析后的 payload, 原始文本)。

    payload 供 path 抽取器用，文本供 regex / index 抽取器用。

    代理策略：默认**直连**（trust_env=False）。本机实测系统代理
    (127.0.0.1:7897) 会拒掉 push2.eastmoney.com，而直连正常——国内财经源
    走代理往往更糟。但直连全部失败后会退回系统代理重试一次，兼顾那些确实
    需要代理才能出去的源（binance / cboe 在某些网络下）。
    """
    url = render_url(src.url or "", params=params)
    headers = {**DEFAULT_HEADERS, **src.headers}

    with requests.Session() as sess:
        sess.trust_env = use_proxy  # False = 忽略 HTTP_PROXY 与系统代理
        if src.method.upper() == "POST":
            body = {k: render_url(v, params=params) for k, v in src.body.items()}
            resp = sess.post(url, data=body, headers=headers, timeout=TIMEOUT)
        else:
            resp = sess.get(url, headers=headers, timeout=TIMEOUT)
        resp.raise_for_status()
        raw = resp.content[:MAX_BYTES]

    if not raw:
        # push2 被限流时正是这个形态：200 但空 body
        raise ValueError("空响应（可能被限流）")
    text = raw.decode(src.encoding, errors="replace")

    ptype = src.parse.get("type", "json")
    if ptype == "json":
        payload = json.loads(text)
    else:
        payload = None
    return payload, text


def _akshare_payload(src: Source) -> tuple[Any, str]:
    """akshare 调用；DataFrame 转成 records，之后与 JSON 源同一套抽取逻辑。"""
    import akshare as ak

    fn = getattr(ak, src.call or "", None)
    if fn is None:
        raise ValueError(f"akshare 没有函数 {src.call}")
    df = fn()
    if hasattr(df, "to_dict"):
        return df.to_dict(orient="records"), ""
    return df, ""


def _select_rows(payload: Any, src: Source, params: dict[str, str] | None = None) -> Any:
    """按 parse.rows / parse.row 定位到要抽字段的那一段。

    rows 路径本身也过一遍占位符替换：腾讯 K 线把代码嵌进了 JSON 的键
    （`data.sh600519.qfqday`），路径必须随代码变。
    """
    rows_path = src.parse.get("rows")
    if rows_path:
        payload = dig(payload, render_url(rows_path, params=params))
        if isinstance(payload, dict):
            # 东财有时给 {"0": {...}, "1": {...}} 而不是数组
            payload = [payload[k] for k in sorted(payload, key=lambda x: int(x) if x.isdigit() else 0)]
    row_idx = src.parse.get("row")
    if row_idx is not None and isinstance(payload, list):
        payload = payload[row_idx] if len(payload) > row_idx else None
    return payload


def _cache_key(src: Source, params: dict[str, str] | None) -> str:
    """个股源必须按代码分开缓存，否则查完茅台再查平安会读到茅台的 K 线。"""
    code = (params or {}).get("code")
    return f"{src.id}-{code}" if code else src.id


def fetch(src: Source, fresh: bool = False, params: dict[str, str] | None = None) -> FetchResult:
    """取一条源。永不抛异常——失败以 FetchResult(ok=False) 表达。"""
    started = time.time()
    key = _cache_key(src, params)

    if not fresh:
        cached = cache.read(key, src.ttl)
        if cached is not None:
            return FetchResult(
                source_id=src.id,
                ok=True,
                values=cached,
                ms=int((time.time() - started) * 1000),
                from_cache=True,
            )

    backoff = BACKOFF_STRICT if src.is_strict else BACKOFF_NORMAL
    last_err: str | None = None

    for attempt, delay in enumerate([0, *backoff]):
        if delay:
            time.sleep(delay)
        try:
            if src.kind == "akshare":
                payload, text = _akshare_payload(src)
            else:
                # 直连优先；最后一次尝试改走系统代理（见 _http_payload）
                use_proxy = attempt == len(backoff)
                payload, text = _http_payload(src, use_proxy=use_proxy, params=params)

            scoped = _select_rows(payload, src, params)
            values = {
                name: extract(scoped, spec, text) for name, spec in src.fields.items()
            }
            if src.derive:
                values.update(apply_derive(payload, src.derive))

            cache.write(key, values)
            return FetchResult(
                source_id=src.id,
                ok=True,
                values=values,
                ms=int((time.time() - started) * 1000),
            )
        except Exception as exc:  # noqa: BLE001 — 任何失败都只是「这条源没拿到」
            last_err = f"{type(exc).__name__}: {exc}"
            continue

    # 全部重试用尽：退回上一次成功值（标 stale），比什么都没有有用
    stale = cache.read(key, ttl=10**9)
    return FetchResult(
        source_id=src.id,
        ok=False,
        values=stale or {name: None for name in src.fields},
        error=f"{last_err}（重试 {len(backoff)} 次后放弃）",
        ms=int((time.time() - started) * 1000),
        from_cache=stale is not None,
    )


def fetch_rows(
    src: Source,
    params: dict[str, str] | None = None,
    fresh: bool = False,
) -> tuple[list[Any] | None, str | None]:
    """取一条**返回表格**的源，返回 (行列表, 错误)。

    个股源与宏观源的形状根本不同：宏观源一次返回一个标量快照（美元指数
    98.63），个股源返回的是一张表（120 根 K 线、若干条解禁记录）。
    fetch() 那套「每个字段抽一个值」的模型套不上，所以这里走另一条路：
    只定位到 parse.rows 那一段，整段交给 stock.py 去算。

    重试、代理、缓存策略与 fetch() 完全共用——这些是实测换来的知识，
    不该有第二份实现。
    """
    key = _cache_key(src, params)
    if not fresh:
        cached = cache.read(key, src.ttl)
        if cached is not None:
            return cached, None

    backoff = BACKOFF_STRICT if src.is_strict else BACKOFF_NORMAL
    last_err: str | None = None

    for attempt, delay in enumerate([0, *backoff]):
        if delay:
            time.sleep(delay)
        try:
            use_proxy = attempt == len(backoff)
            payload, text = _http_payload(src, use_proxy=use_proxy, params=params)
            rows = _select_rows(payload, src, params) if src.parse.get("rows") else payload
            if rows is None:
                rows = []
            if not isinstance(rows, list):
                rows = [rows]
            cache.write(key, rows)
            return rows, None
        except Exception as exc:  # noqa: BLE001
            last_err = f"{type(exc).__name__}: {exc}"
            continue

    stale = cache.read(key, ttl=10**9)
    if stale is not None:
        return stale, None
    return None, f"{last_err}（重试 {len(backoff)} 次后放弃）"
