"""磁盘缓存：~/.kalo/market/cache/<id>-<date>.json

存在的理由是实测出来的，不是预防性设计：push2*.eastmoney.com 在连续几十次
请求后会整体拒绝服务数分钟（换 UA 无效），而同一时刻 datacenter / sina /
cboe / cninfo 全部正常。所以 strict 源必须靠缓存把请求次数压到最低。

akshare 调用同样走这一层——它内部打的正是同一批接口。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

CACHE_DIR = Path.home() / ".kalo" / "market" / "cache"


def _cache_file(source_id: str) -> Path:
    return CACHE_DIR / f"{source_id}.json"


def read(source_id: str, ttl: int) -> Any | None:
    """返回未过期的缓存内容，否则 None。缓存文件损坏按未命中处理。"""
    f = _cache_file(source_id)
    if not f.exists():
        return None
    try:
        blob = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if time.time() - blob.get("at", 0) > ttl:
        return None
    return blob.get("payload")


def write(source_id: str, payload: Any) -> None:
    """原子写（tmp + replace），避免读到写一半的文件。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    f = _cache_file(source_id)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({"at": time.time(), "payload": payload}, ensure_ascii=False),
        encoding="utf-8",
    )
    tmp.replace(f)


def age(source_id: str) -> float | None:
    """缓存写入至今的秒数，用于 probe 显示。"""
    f = _cache_file(source_id)
    if not f.exists():
        return None
    try:
        blob = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return time.time() - blob.get("at", 0)
