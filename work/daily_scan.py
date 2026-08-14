#!/usr/bin/env python3
"""Build an auditable daily top-100 ranking for the full A-share market."""
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
API = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def fetch_page(page: int, size: int = 100) -> list[dict]:
    query = urllib.parse.urlencode({
        "page": page, "num": size, "sort": "changepercent", "asc": 0,
        "node": "hs_a", "symbol": "", "_s_r_a": "page",
    })
    req = urllib.request.Request(f"{API}?{query}", headers={
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://vip.stock.finance.sina.com.cn/mkt/",
    })
    last_error = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return list(payload or [])
        except Exception as exc:
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Sina market page={page} unavailable after retries: {last_error}")


def fetch_universe() -> list[dict]:
    rows: list[dict] = []
    for page in range(1, 80):
        batch = fetch_page(page)
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 100:
            break
        time.sleep(0.35)
    return rows


def number(value):
    try:
        parsed = float(str(value).replace("+", "").replace("%", "").replace(",", ""))
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def cn_number(value):
    text = str(value or "").strip().replace("+", "").replace(",", "")
    multiplier = 1.0
    if text.endswith("万"):
        multiplier, text = 10_000.0, text[:-1]
    elif text.endswith("亿"):
        multiplier, text = 100_000_000.0, text[:-1]
    parsed = number(text)
    return None if parsed is None else parsed * multiplier


def normalize_rows(raw: list[dict]) -> list[dict]:
    rows = []
    for item in raw:
        code, name = str(item.get("code") or "").zfill(6), str(item.get("name") or "").strip()
        if len(code) != 6 or not code.isdigit() or not name:
            continue
        settlement = number(item.get("settlement"))
        high, low = number(item.get("high")), number(item.get("low"))
        amplitude = None if not settlement or high is None or low is None else (high - low) / settlement * 100
        rows.append({
            "code": code, "name": name, "exchange": str(item.get("symbol") or "")[:2].upper(),
            "price": number(item.get("trade")), "pct_change": number(item.get("changepercent")),
            "turnover": number(item.get("turnoverratio")), "amount": number(item.get("amount")),
            "volume": number(item.get("volume")), "amplitude": amplitude,
            "market_cap": (number(item.get("mktcap")) or 0) * 10_000,
            "float_cap": (number(item.get("nmc")) or 0) * 10_000,
            "pe_ttm": number(item.get("per")), "pb": number(item.get("pb")),
        })
    unique = {r["code"]: r for r in rows}
    return list(unique.values())


def eligibility(row: dict) -> tuple[bool, list[str]]:
    reasons = []
    upper_name = row["name"].upper()
    if "ST" in upper_name or "退" in row["name"]:
        reasons.append("风险警示或退市")
    if not row["price"] or row["price"] <= 1:
        reasons.append("价格无效或过低")
    if not row["amount"] or row["amount"] < 30_000_000:
        reasons.append("成交额不足3000万元")
    if not row["market_cap"] or row["market_cap"] < 2_000_000_000:
        reasons.append("市值不足20亿元")
    if row["pct_change"] is None or abs(row["pct_change"]) > 31:
        reasons.append("涨跌幅无效")
    return not reasons, reasons


def winsor(values: list[float], low=.02, high=.98) -> tuple[float, float]:
    ordered = sorted(values)
    if not ordered:
        return 0.0, 1.0
    return ordered[int((len(ordered) - 1) * low)], ordered[int((len(ordered) - 1) * high)]


def percentile_map(rows: list[dict], key: str, higher=True) -> dict[str, float]:
    pairs = [(r["code"], r[key]) for r in rows if r.get(key) is not None]
    pairs.sort(key=lambda x: x[1], reverse=not higher)
    denominator = max(1, len(pairs) - 1)
    return {code: 100 * index / denominator for index, (code, _) in enumerate(pairs)}


DEFAULT_WEIGHTS = {"momentum": .20, "liquidity": .18, "quality": .15, "value": .18, "risk": .17, "crowding": .12}


def score_rows(rows: list[dict], weights=None) -> list[dict]:
    weights = weights or DEFAULT_WEIGHTS
    eligible = []
    for row in rows:
        ok, reasons = eligibility(row)
        row["eligible"], row["filter_reasons"] = ok, reasons
        if ok:
            eligible.append(row)
    for key in ("pct_change", "amount", "market_cap", "pe_ttm", "pb", "amplitude", "turnover"):
        values = [r[key] for r in eligible if r[key] is not None]
        low, high = winsor(values)
        for row in eligible:
            if row[key] is not None:
                row[f"_{key}"] = min(high, max(low, row[key]))
    ranks = {
        "day": percentile_map(eligible, "_pct_change"),
        "amount": percentile_map(eligible, "_amount"),
        "cap": percentile_map(eligible, "_market_cap"),
        "pe": percentile_map(eligible, "_pe_ttm", higher=False),
        "pb": percentile_map(eligible, "_pb", higher=False),
        "amp_low": percentile_map(eligible, "_amplitude", higher=False),
        "turn_low": percentile_map(eligible, "_turnover", higher=False),
    }
    for row in eligible:
        code = row["code"]
        raw_change = row["pct_change"] or 0
        # Reward positive confirmation, but penalize limit-up chasing.
        momentum = ranks["day"].get(code, 0) * max(0.35, 1 - max(0, raw_change - 6) / 25)
        liquidity = ranks["amount"].get(code, 0)
        quality = ranks["cap"].get(code, 0)
        pe = row.get("pe_ttm")
        pb = row.get("pb")
        value = (.6 * ranks["pe"].get(code, 0) + .4 * ranks["pb"].get(code, 0)) if pe and pe > 0 and pb and pb > 0 else 25
        risk = .65 * ranks["amp_low"].get(code, 0) + .35 * ranks["turn_low"].get(code, 0)
        # The best crowding zone is a liquid but non-speculative 2%-8% turnover.
        turnover = row["turnover"] or 0
        crowding = max(0, 100 - abs(turnover - 5) * 9)
        components = [momentum, liquidity, quality, value, risk, crowding]
        agreement = 100 - min(100, statistics.pstdev(components) * 2.3)
        score = sum(weights[k] * value for k, value in zip(weights, components)) + .05 * agreement
        row.update({
            "score": round(min(100, max(0, score)), 2),
            "trend_score": round(momentum, 2), "confirm_score": round(momentum, 2),
            "value_score": round(value, 2), "quality_score": round(quality, 2), "liquidity_score": round(liquidity, 2),
            "risk_score": round(risk, 2), "crowding_score": round(crowding, 2),
            "agreement_score": round(agreement, 2),
        })
    return sorted(eligible, key=lambda r: (-r["score"], r["code"]))


def stability_test(rows: list[dict], baseline: list[dict]) -> dict:
    variants = [
        {"momentum": .22, "liquidity": .16, "quality": .15, "value": .18, "risk": .17, "crowding": .12},
        {"momentum": .18, "liquidity": .20, "quality": .15, "value": .18, "risk": .17, "crowding": .12},
    ]
    base = {r["code"] for r in baseline[:100]}
    overlaps = []
    for weights in variants:
        top = {r["code"] for r in score_rows(json.loads(json.dumps(rows, ensure_ascii=False)), weights)[:100]}
        overlaps.append(len(base & top) / 100)
    return {"weight_perturbation_top100_overlap": round(sum(overlaps) / len(overlaps), 4), "variant_overlaps": overlaps}


def build_snapshot() -> dict:
    raw = fetch_universe()
    rows = normalize_rows(raw)
    ranked = score_rows(rows)
    tests = stability_test(rows, ranked)
    result = {
        "date": dt.date.today().isoformat(),
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "universe_count": len(rows), "eligible_count": len(ranked),
        "excluded_count": len(rows) - len(ranked), "top100": ranked[:100],
        "tests": {
            "duplicate_codes": len(rows) - len({r["code"] for r in rows}),
            "scores_sorted": all(ranked[i]["score"] >= ranked[i + 1]["score"] for i in range(len(ranked) - 1)),
            "score_bounds_ok": all(0 <= r["score"] <= 100 for r in ranked),
            "top100_count": min(100, len(ranked)), **tests,
        },
        "model_version": "full-a-v2-sina",
        "data_source": "新浪财经公开全A股行情榜单",
        "weights": {**DEFAULT_WEIGHTS, "agreement_bonus": .05},
        "limitations": [
            "横截面快照用于候选池排序，不是未来收益保证。",
            "公开快照不含一致口径的历史财务因子，规模质量只作为流动性与经营稳定性的弱代理。",
            "历史榜单从自动任务启用日起逐交易日积累，需持续观察未来收益、换手和回撤后再校准。",
        ],
    }
    if result["universe_count"] < 4500:
        raise RuntimeError(f"universe coverage too small: {result['universe_count']}")
    if result["tests"]["top100_count"] != 100:
        raise RuntimeError("top100 output incomplete")
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
