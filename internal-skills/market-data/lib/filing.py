"""巨潮资讯 + 东财 F10：定期报告下载与结构化财务指标。

与宏观那条线不同，财报是**按需拉取**而不是每日定时——所以这里不进
daily.jsonl，直接落到 ~/.kalo/filings/<code>/ 下按股票分目录。

三个能力：
    list    列出该股的定期报告（哪年哪期，多大）
    get     下 PDF + 抽文本（年报动辄 200 页，直接进上下文不现实）
    metrics 东财 F10 结构化主要财务指标（分析先看这张表，PDF 只用来查细节）
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import requests

FILINGS_DIR = Path.home() / ".kalo" / "filings"
ORG_CACHE = FILINGS_DIR / ".orgid.json"

TIMEOUT = 30
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

# 巨潮的报告类别代号。实测这四个覆盖了「定期报告」的全部四期。
CATEGORIES = {
    "年报": "category_ndbg_szsh",
    "半年报": "category_bndbg_szsh",
    "一季报": "category_yjdbg_szsh",
    "三季报": "category_sjdbg_szsh",
}


def _market(code: str) -> str:
    """6 开头是沪市，其余（0/3）是深市。北交所暂不处理。"""
    return "sse" if code.startswith("6") else "szse"


def org_id(code: str) -> str | None:
    """巨潮查询必需的 orgId（600519 → gssh0600519）。

    全量映射表一次几 MB，缓存到本地，一天拉一次都算勤快的。
    """
    if ORG_CACHE.exists():
        try:
            table = json.loads(ORG_CACHE.read_text(encoding="utf-8"))
            if code in table:
                return table[code]
        except json.JSONDecodeError:
            pass

    resp = requests.get(
        "https://www.cninfo.com.cn/new/data/szse_stock.json",
        headers={"User-Agent": UA},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    table = {
        item["code"]: item["orgId"]
        for item in resp.json().get("stockList", [])
        if item.get("code") and item.get("orgId")
    }
    ORG_CACHE.parent.mkdir(parents=True, exist_ok=True)
    ORG_CACHE.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
    return table.get(code)


def list_filings(code: str, kind: str | None = None, pages: int = 1) -> list[dict[str, Any]]:
    """列出定期报告。kind 为空则四期全查。"""
    oid = org_id(code)
    if not oid:
        raise ValueError(f"查不到 {code} 的 orgId（代码有误或不在深沪两市）")

    kinds = [kind] if kind else list(CATEGORIES)
    out: list[dict[str, Any]] = []
    for k in kinds:
        cat = CATEGORIES.get(k)
        if not cat:
            raise ValueError(f"未知报告类型：{k}（可选 {'/'.join(CATEGORIES)}）")
        for page in range(1, pages + 1):
            resp = requests.post(
                "https://www.cninfo.com.cn/new/hisAnnouncement/query",
                data={
                    "stock": f"{code},{oid}",
                    "tabName": "fulltext",
                    "pageSize": 30,
                    "pageNum": page,
                    "column": _market(code),
                    "category": cat,
                    "isHLtitle": "true",
                },
                headers={"User-Agent": UA, "Referer": "https://www.cninfo.com.cn/"},
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
            for a in resp.json().get("announcements") or []:
                title = a.get("announcementTitle", "")
                out.append({
                    "title": re.sub(r"<[^>]+>", "", title),  # 高亮标签清掉
                    "kind": k,
                    "year": _year_of(title),
                    "url": "https://static.cninfo.com.cn/" + a.get("adjunctUrl", ""),
                    "size_kb": a.get("adjunctSize"),
                })
    return out


def _year_of(title: str) -> str | None:
    m = re.search(r"(20\d{2})", title)
    return m.group(1) if m else None


def _pick(items: list[dict], year: str | None, kind: str) -> dict | None:
    """选目标报告：优先正文（排除「摘要」「更正」「已取消」这类衍生件）。"""
    noise = ("摘要", "更正", "补充", "取消", "英文", "已取消")
    cands = [
        it for it in items
        if it["kind"] == kind
        and (year is None or it["year"] == year)
        and not any(w in it["title"] for w in noise)
    ]
    if not cands:
        # 实在只有摘要之类的，也比什么都不给强
        cands = [it for it in items if it["kind"] == kind and (year is None or it["year"] == year)]
    return cands[0] if cands else None


def download(code: str, year: str | None = None, kind: str = "年报") -> dict[str, Any]:
    """下 PDF 并抽文本。返回落盘路径与体积。

    抽文本是刚需而不是锦上添花：一份年报 200+ 页，模型不可能整本读，
    落成 .txt 之后可以用 rg 按科目名检索到具体段落再看。
    """
    items = list_filings(code, kind=kind)
    target = _pick(items, year, kind)
    if target is None:
        have = sorted({f"{it['year']}{it['kind']}" for it in items if it["year"]}, reverse=True)
        raise ValueError(f"没找到 {code} 的 {year or ''}{kind}；现有：{', '.join(have[:8])}")

    outdir = FILINGS_DIR / code
    outdir.mkdir(parents=True, exist_ok=True)
    stem = f"{code}-{target['year'] or 'NA'}-{kind}"
    pdf_path = outdir / f"{stem}.pdf"
    txt_path = outdir / f"{stem}.txt"

    if not pdf_path.exists():
        resp = requests.get(target["url"], headers={"User-Agent": UA}, timeout=TIMEOUT * 4)
        resp.raise_for_status()
        pdf_path.write_bytes(resp.content)

    chars = 0
    if not txt_path.exists():
        chars = _extract_text(pdf_path, txt_path)
    else:
        chars = len(txt_path.read_text(encoding="utf-8", errors="ignore"))

    return {
        "code": code,
        "title": target["title"],
        "pdf": str(pdf_path),
        "txt": str(txt_path),
        "pdf_kb": round(pdf_path.stat().st_size / 1024, 1),
        "txt_chars": chars,
    }


def _extract_text(pdf_path: Path, txt_path: Path) -> int:
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    parts = []
    for i, page in enumerate(reader.pages, 1):
        try:
            text = page.extract_text() or ""
        except Exception:  # 单页解析失败不该毁掉整本
            text = ""
        # 页码标记让模型能说清"在第几页看到的"
        parts.append(f"\n--- p.{i} ---\n{text}")
    body = "".join(parts)
    txt_path.write_text(body, encoding="utf-8")
    return len(body)


def metrics(code: str, periods: int = 12) -> dict[str, Any]:
    """东财 F10 主要财务指标（近 N 期）。

    ⚠ 必须 columns=ALL：逐个列名会返回「返回字段不存在」。
    """
    market = "SH" if code.startswith("6") else "SZ"
    url = (
        "https://datacenter.eastmoney.com/securities/api/data/v1/get"
        "?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL"
        f"&filter=(SECUCODE=\"{code}.{market}\")&pageNumber=1&pageSize={periods}"
        "&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC"
    )
    resp = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    resp.raise_for_status()
    rows = (resp.json().get("result") or {}).get("data") or []

    # 只留分析真正要看的科目——F10 原始返回 140+ 列（含大量银行/券商/保险
    # 专用字段，对一般公司全是 null），全塞进上下文是纯粹的浪费。
    # 金额列统一转亿元：原始是「元」且带两位小数，92278072083.21 这种数字
    # 人和模型都读不出量级。
    YI = 1e8
    keep = [
        ("REPORT_DATE", "报告期", None),
        ("EPSJB", "每股收益", 2),
        ("BPS", "每股净资产", 2),
        ("MGJYXJJE", "每股经营现金流", 2),
        ("TOTALOPERATEREVE", "营业总收入(亿)", YI),
        ("PARENTNETPROFIT", "归母净利润(亿)", YI),
        ("KCFJCXSYJLR", "扣非净利润(亿)", YI),
        ("TOTALOPERATEREVETZ", "营收同比%", 2),
        ("PARENTNETPROFITTZ", "净利同比%", 2),
        ("KCFJCXSYJLRTZ", "扣非同比%", 2),
        ("XSMLL", "毛利率%", 2),
        ("XSJLL", "净利率%", 2),
        ("ROEJQ", "净资产收益率%", 2),
        ("ZCFZL", "资产负债率%", 2),
        # 现金流与净利的背离是财报分析最重要的一条线索
        ("JYXJLYYSR", "经营现金流/营收", 3),
        ("XSJXLYYSR", "销售现金流/营收", 3),
        # 应收与存货异动：周转天数比余额更能看出变化
        ("YSZKZZTS", "应收账款周转天数", 1),
        ("CHZZTS", "存货周转天数", 1),
    ]
    out = []
    for r in rows:
        item = {}
        for k, name, shape in keep:
            v = r.get(k)
            if k == "REPORT_DATE" and isinstance(v, str):
                v = v.split(" ")[0]
            elif isinstance(v, (int, float)) and shape:
                v = round(v / YI, 2) if shape == YI else round(v, shape)
            item[name] = v
        out.append(item)

    outdir = FILINGS_DIR / code
    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / f"{code}-metrics.json"
    payload = {"code": code, "periods": len(out), "data": out}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    payload["saved"] = str(path)
    return payload
