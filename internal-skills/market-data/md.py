"""market-data 统一 CLI。

    md.py probe [--all|<id>]     逐源实测：字段抽出来了没有（框架自检）
    md.py get <source-id>        取单源事实 JSON
    md.py macro now              全部宏观源当前快照
    md.py macro append           快照追加进 daily.jsonl（cron 用，正常静默）
    md.py macro analyze          读历史 → 分位数/变化率/派生量（小 JSON）
    md.py filing list <code>     巨潮：定期报告清单
    md.py filing get <code>      下载 PDF + 抽文本
    md.py filing metrics <code>  东财 F10 结构化财务指标
    md.py stock checkup <code>   个股体检事实 JSON（三大类）

设计约束见 SKILL.md：这里只产出事实，判断留给 skill 里的模型。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Windows 控制台默认 GBK，中文源名与 ⚠ 之类的字符会直接抛 UnicodeEncodeError
# 让脚本崩掉。这一层是 watch 任务的入口，绝不能因为打印而失败。
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import fetch as fetch_mod  # noqa: E402
from lib import filing  # noqa: E402
from lib import macro as macro_mod  # noqa: E402
from lib import stock as stock_mod  # noqa: E402
from lib import store  # noqa: E402
from lib.registry import load_sources  # noqa: E402


def cmd_probe(args) -> int:
    """逐源实测并打印结果。这是框架的自检命令——源失效时立刻可见。"""
    sources = load_sources()
    if args.source:
        sources = [s for s in sources if s.id == args.source]
        if not sources:
            print(f"没有这条源：{args.source}", file=sys.stderr)
            return 1

    failed = 0
    for src in sources:
        # 个股源的 URL 带 {code} 之类的占位符，必须拿 probe_with 里的样本
        # 代码实测；否则打出去的是一条含大括号的废 URL，看起来像源坏了。
        params = stock_mod.code_params(src.probe_with["code"]) if src.probe_with.get("code") else None
        if params:
            params.update({k: v for k, v in src.probe_with.items() if k != "code"})

        if src.group == "stock" and not src.fields:
            # 返回表的源没有 fields 可抽，自检的标准是「拿到几行」
            rows, err = fetch_mod.fetch_rows(src, params=params, fresh=args.fresh)
            ok = err is None
            mark = "ok " if ok else "ERR"
            n = len(rows or [])
            print(f"[{mark}] {src.id:<20} {src.name:<14} {n} 行")
            if ok and rows:
                print(f"        首行 {str(rows[0])[:150]}")
            elif not ok:
                failed += 1
                print(f"        {err}")
        else:
            res = fetch_mod.fetch(src, fresh=args.fresh, params=params)
            got = sum(1 for v in res.values.values() if v is not None)
            total = len(src.fields) + len(src.derive)
            mark = "ok " if res.ok else "ERR"
            cache_tag = " (cache)" if res.from_cache else ""
            print(f"[{mark}] {src.id:<20} {src.name:<14} {got}/{total} 字段  {res.ms}ms{cache_tag}")
            if res.ok:
                for k, v in res.values.items():
                    flag = "" if v is not None else "   ← 抽不到"
                    print(f"        {k:<20} = {v}{flag}")
            else:
                failed += 1
                print(f"        {res.error}")
        if src.verified_at is None:
            print("        ⚠ 未标注 verified_at（尚未实测过）")
    print(f"\n{len(sources) - failed}/{len(sources)} 条源可用")
    return 0


def cmd_get(args) -> int:
    src = next((s for s in load_sources() if s.id == args.source), None)
    if src is None:
        print(f"没有这条源：{args.source}", file=sys.stderr)
        return 1
    res = fetch_mod.fetch(src, fresh=args.fresh)
    print(json.dumps(
        {"source": src.id, "ok": res.ok, "values": res.values, "error": res.error},
        ensure_ascii=False, indent=2,
    ))
    return 0 if res.ok else 1


def cmd_macro_now(args) -> int:
    snap = macro_mod.snapshot(fresh=args.fresh)
    print(json.dumps(snap, ensure_ascii=False, indent=2))
    return 0


def cmd_macro_append(args) -> int:
    """落一行进 daily.jsonl。**正常路径必须完全静默**。

    这是 scheduler watch 任务的契约：stdout 非空 = 异常 = 推飞书。
    所以只有「多数源都挂了」这种真正需要人看一眼的情况才输出。
    单条源失败是常态（feeds 的老结论），已经记进那一行的 errors[] 里，
    不值得每天打扰人。
    """
    # 一天只跑一次，没有限流压力，直接取新的；避免把昨天的缓存记成今天
    snap = macro_mod.snapshot(fresh=not args.cached)
    store.append(snap)

    total = sum(1 for s in load_sources() if s.group == "macro")
    failed = len(snap.get("errors", []))
    if total and failed * 2 > total:
        ids = ", ".join(e["source"] for e in snap["errors"])
        print(f"宏观快照多数源失败（{failed}/{total}）：{ids}")
        return 1
    return 0


def cmd_macro_analyze(args) -> int:
    out = macro_mod.analyze(window=args.window)
    # 紧凑输出：进上下文的体积是硬约束（目标 < 2KB），缩进不值这个钱
    print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return 0


def cmd_filing_list(args) -> int:
    items = filing.list_filings(args.code, kind=args.type)
    print(json.dumps(items, ensure_ascii=False, indent=1))
    return 0


def cmd_filing_get(args) -> int:
    info = filing.download(args.code, year=args.year, kind=args.type)
    print(json.dumps(info, ensure_ascii=False, indent=1))
    return 0


def cmd_filing_metrics(args) -> int:
    out = filing.metrics(args.code, periods=args.periods)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


def cmd_stock_checkup(args) -> int:
    out = stock_mod.checkup(args.code, fresh=args.fresh, recent_days=args.days)
    # 与 macro analyze 同一个约束：这份 JSON 是要进上下文的，紧凑输出
    print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="md.py", description="market-data 取数层")
    sub = p.add_subparsers(dest="cmd", required=True)

    # --fresh 挂在每个子命令上，这样 `md.py probe --fresh` 与
    # `md.py --fresh probe` 都能用（argparse 的父级参数必须前置，太别扭）
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--fresh", action="store_true", help="绕过缓存强制重取")

    sp = sub.add_parser("probe", parents=[common], help="逐源实测（框架自检）")
    sp.add_argument("source", nargs="?", default=None, help="源 id，不给就是全部")
    # --all 是不给 source 的同义词：写出来更像一句话，也照顾手指记忆
    sp.add_argument("--all", action="store_true", help="全部源（默认行为）")
    sp.set_defaults(func=cmd_probe)

    sg = sub.add_parser("get", parents=[common], help="取单源事实 JSON")
    sg.add_argument("source")
    sg.set_defaults(func=cmd_get)

    sm = sub.add_parser("macro", help="宏观快照与分析")
    msub = sm.add_subparsers(dest="action", required=True)

    mn = msub.add_parser("now", parents=[common], help="当前快照（人看的）")
    mn.set_defaults(func=cmd_macro_now)

    ma = msub.add_parser("append", help="追加进 daily.jsonl（cron 用，正常静默）")
    ma.add_argument("--cached", action="store_true", help="允许用缓存（默认强制取新）")
    ma.set_defaults(func=cmd_macro_append)

    mz = msub.add_parser("analyze", help="读历史算分位数与变化（模型看的）")
    mz.add_argument("--window", type=int, default=250, help="回看交易日数，0 = 全部")
    mz.set_defaults(func=cmd_macro_analyze)

    sf = sub.add_parser("filing", help="财报下载与财务指标")
    fsub = sf.add_subparsers(dest="action", required=True)

    fl = fsub.add_parser("list", help="列出定期报告")
    fl.add_argument("code", help="6 位股票代码")
    fl.add_argument("--type", default=None, help="年报/半年报/一季报/三季报，默认全查")
    fl.set_defaults(func=cmd_filing_list)

    fg = fsub.add_parser("get", help="下载 PDF 并抽文本")
    fg.add_argument("code")
    fg.add_argument("--year", default=None, help="报告年份，默认最新一期")
    fg.add_argument("--type", default="年报")
    fg.set_defaults(func=cmd_filing_get)

    fm = fsub.add_parser("metrics", help="东财 F10 结构化财务指标")
    fm.add_argument("code")
    fm.add_argument("--periods", type=int, default=12, help="取近 N 期")
    fm.set_defaults(func=cmd_filing_metrics)

    st = sub.add_parser("stock", help="个股体检")
    tsub = st.add_subparsers(dest="action", required=True)

    tc = tsub.add_parser("checkup", parents=[common], help="三大类体检事实 JSON")
    tc.add_argument("code", help="6 位股票代码")
    tc.add_argument("--days", type=int, default=20, help="「最近」窗口的天数，默认 20")
    tc.set_defaults(func=cmd_stock_checkup)

    return p


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
