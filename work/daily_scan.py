#!/usr/bin/env python3
"""Scan the full Shanghai/Shenzhen/Beijing A-share universe and rank top 100.

Uses one paginated Eastmoney market snapshot request rather than thousands of
per-symbol calls. The model is intentionally cross-sectional and auditable.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "work" / "daily_snapshot.json"
API = "https://82.push2.eastmoney.com/api/qt/clist/get"
FIELDS = "f2,f3,f6,f7,f8,f9,f10,f12,f14,f20,f21,f23,f24,f25,f124"
UNIVERSE = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
UA = "Mozilla/5.0 Full-A-Share-Daily-Scanner/2.0"


def fetch_page(page: int, size: int = 100) -> dict:
    query = urllib.parse.urlencode({
        "pn": page, "pz": size, "po": 1, "np": 2, "fltt": 2, "invt": 2,
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fid": "f3", "fs": UNIVERSE, "fields": FIELDS,
    })
    req = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"})
    last_error = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"market page {page} unavailable after retries: {last_error}")


def fetch_universe() -> list[dict]:
    first = fetch_page(1)
    data = first.get("data") or {}
    rows = list(data.get("diff") or [])
    total = int(data.get("total") or len(rows))
    pages = math.ceil(total / 100)
    for page in range(2, pages + 1):
        time.sleep(0.35)
        rows.extend((fetch_page(page).get("data") or {}).get("diff") or [])
    return rows


def number(value):
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def winsor(values: list[float], low: float = 0.02, high: float = 0.98) -> tuple[float, float]:
    ordered = sorted(values)
    if not ordered:
        return 0.0, 1.0
    return ordered[int((len(ordered) - 1) * low)], ordered[int((len(ordered) - 1) * high)]


def percentile_map(rows: list[dict], key: str, higher: bool = True) -> dict[str, float]:
    pairs = [(r["code"], r[key]) for r in rows if r.get(key) is not None]
    pairs.sort(key=lambda x: x[1], reverse=not higher)
    count = max(1, len(pairs) - 1)
    return {code: 100 * idx / count for idx, (code, _) in enumerate(pairs)}


def normalize_rows(raw: list[dict]) -> list[dict]:
    rows = []
    for r in raw:
        code, name = str(r.get("f12") or "").zfill(6), str(r.get("f14") or "").strip()
        if len(code) != 6 or not code.isdigit() or not name:
            continue
        rows.append({
            "code": code, "name": name, "price": number(r.get("f2")),
            "pct_change": number(r.get("f3")), "amount": number(r.get("f6")),
            "amplitude": number(r.get("f7")), "turnover": number(r.get("f8")),
            "pe_ttm": number(r.get("f9")), "volume_ratio": number(r.get("f10")),
            "market_cap": number(r.get("f20")), "float_cap": number(r.get("f21")),
            "pb": number(r.get("f23")), "return_60d": number(r.get("f24")),
            "return_ytd": number(r.get("f25")), "quote_ts": number(r.get("f124")),
        })
    return rows


def eligibility(row: dict) -> tuple[bool, list[str]]:
    reasons = []
    name = row["name"].upper()
    if "ST" in name or "退" in name: reasons.append("风险警示或退市")
    if not row["price"] or row["price"] <= 1: reasons.append("价格无效或过低")
    if not row["amount"] or row["amount"] < 30_000_000: reasons.append("成交额不足3000万")
    if not row["market_cap"] or row["market_cap"] < 2_000_000_000: reasons.append("市值不足20亿")
    if row["pe_ttm"] is None or row["pe_ttm"] <= 0 or row["pe_ttm"] > 300: reasons.append("PE无效或极端")
    if row["pb"] is None or row["pb"] <= 0 or row["pb"] > 30: reasons.append("PB无效或极端")
    return not reasons, reasons


def score_rows(rows: list[dict], weights: dict[str, float] | None = None) -> list[dict]:
    weights = weights or {"trend": .30, "confirm": .12, "value": .22, "liquidity": .14, "risk": .17, "crowding": .05}
    eligible = []
    for row in rows:
        ok, reasons = eligibility(row)
        row["eligible"], row["filter_reasons"] = ok, reasons
        if ok: eligible.append(row)
    for key in ("return_60d", "return_ytd", "pct_change", "amount", "pe_ttm", "pb", "amplitude", "turnover", "volume_ratio"):
        values = [r[key] for r in eligible if r[key] is not None]
        lo, hi = winsor(values)
        for row in eligible:
            if row[key] is not None: row[f"_{key}"] = min(hi, max(lo, row[key]))
    ranks = {
        "r60": percentile_map(eligible, "_return_60d"),
        "rytd": percentile_map(eligible, "_return_ytd"),
        "rday": percentile_map(eligible, "_pct_change"),
        "ramount": percentile_map(eligible, "_amount"),
        "rpe": percentile_map(eligible, "_pe_ttm", higher=False),
        "rpb": percentile_map(eligible, "_pb", higher=False),
        "ramp": percentile_map(eligible, "_amplitude", higher=False),
        "rturn": percentile_map(eligible, "_turnover", higher=False),
        "rvolratio": percentile_map(eligible, "_volume_ratio", higher=False),
    }
    for row in eligible:
        code = row["code"]
        trend = .65 * ranks["r60"].get(code, 0) + .35 * ranks["rytd"].get(code, 0)
        confirm = ranks["rday"].get(code, 0)
        value = .65 * ranks["rpe"].get(code, 0) + .35 * ranks["rpb"].get(code, 0)
        liquidity = ranks["ramount"].get(code, 0)
        risk = .60 * ranks["ramp"].get(code, 0) + .40 * ranks["rturn"].get(code, 0)
        crowding = ranks["rvolratio"].get(code, 0)
        # Agreement bonus rewards multi-factor consensus and reduces dependence
        # on one extreme signal.
        components = [trend, confirm, value, liquidity, risk, crowding]
        agreement = 100 - min(100, statistics.pstdev(components) * 2.5)
        score = sum(weights[k] * v for k, v in zip(weights, components)) + .05 * agreement
        row.update({
            "score": round(min(100, max(0, score)), 2), "trend_score": round(trend, 2),
            "confirm_score": round(confirm, 2), "value_score": round(value, 2),
            "liquidity_score": round(liquidity, 2), "risk_score": round(risk, 2),
            "crowding_score": round(crowding, 2), "agreement_score": round(agreement, 2),
        })
    return sorted(eligible, key=lambda r: (-r["score"], r["code"]))


def stability_test(rows: list[dict], baseline: list[dict]) -> dict:
    variants = [
        {"trend": .32, "confirm": .10, "value": .20, "liquidity": .14, "risk": .19, "crowding": .05},
        {"trend": .28, "confirm": .14, "value": .24, "liquidity": .14, "risk": .15, "crowding": .05},
    ]
    base = {r["code"] for r in baseline[:100]}
    overlaps = []
    for weights in variants:
        clone = json.loads(json.dumps(rows, ensure_ascii=False))
        top = {r["code"] for r in score_rows(clone, weights)[:100]}
        overlaps.append(len(base & top) / 100)
    return {"weight_perturbation_top100_overlap": round(sum(overlaps) / len(overlaps), 4), "variant_overlaps": overlaps}


def build_snapshot() -> dict:
    raw = fetch_universe()
    rows = normalize_rows(raw)
    ranked = score_rows(rows)
    timestamps = [r["quote_ts"] for r in rows if r.get("quote_ts")]
    quote_date = dt.datetime.fromtimestamp(max(timestamps)).date().isoformat() if timestamps else dt.date.today().isoformat()
    duplicate_codes = len(rows) - len({r["code"] for r in rows})
    test = stability_test(rows, ranked)
    result = {
        "date": quote_date, "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "universe_count": len(rows), "eligible_count": len(ranked), "excluded_count": len(rows) - len(ranked),
        "top100": ranked[:100],
        "tests": {
            "duplicate_codes": duplicate_codes,
            "scores_sorted": all(ranked[i]["score"] >= ranked[i + 1]["score"] for i in range(len(ranked) - 1)),
            "score_bounds_ok": all(0 <= r["score"] <= 100 for r in ranked),
            "top100_count": min(100, len(ranked)),
            **test,
        },
        "model_version": "full-a-v1",
        "weights": {"trend": .30, "confirm": .12, "value": .22, "liquidity": .14, "risk": .17, "crowding": .05, "agreement_bonus": .05},
        "limitations": [
            "横截面快照用于全市场筛选，不是未来收益保证。",
            "当前数据源不含可靠的历史时点财务报表，因此未把最新财务数据倒灌进历史回测。",
            "历史榜单从自动任务启用日起逐交易日积累。",
        ],
    }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args()
    snapshot = build_snapshot()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: snapshot[k] for k in ("date", "universe_count", "eligible_count", "tests")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
