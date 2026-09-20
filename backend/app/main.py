"""
Nifty 500 Swing Scanner - Fresh Breakout / Volume Test

Adds:
- Fresh Breakout: yesterday closed above a detected resistance that the
  previous day had not closed above.
- Breakout volume ratio = breakout-day volume / prior 20 completed sessions'
  average volume.
- Configurable volume confirmation threshold (default 1.5x).
- Fresh breakout holding/failing status based on today's price.

The existing trend + S/R logic is preserved.

Performance: scanner workers avoid building full chart candle payloads for
all 500 symbols; candles are generated only for the detail endpoint.
"""

from __future__ import annotations

from typing import Any
from concurrent.futures import ThreadPoolExecutor, as_completed
import io
import os
import numpy as np
import pandas as pd
import requests
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Nifty 500 Swing Scanner", version="1.8.0")

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "").strip().rstrip("/")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN] if FRONTEND_ORIGIN else [],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NIFTY500_URL = "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv"
SLOPE_LOOKBACK = 22
VOLUME_LOOKBACK = 20
DEFAULT_VOLUME_THRESHOLD = 1.5
# 1 year is enough for the scanner's 200-day SMA + 22-day slope lookback.
# Keeping the history smaller and scanning several symbols concurrently makes
# the full Nifty 500 scan much faster while preserving the existing logic.
SCAN_PERIOD = os.getenv("SCAN_PERIOD", "1y")
SCAN_WORKERS = max(4, min(int(os.getenv("SCAN_WORKERS", "12")), 24))


def nifty500_symbols() -> list[str]:
    r = requests.get(NIFTY500_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    col = next((c for c in df.columns if c.strip().upper() == "SYMBOL"), None)
    if not col:
        raise RuntimeError("Nifty 500 SYMBOL column not found")
    return [f"{s.strip().upper()}.NS" for s in df[col].dropna().astype(str)]


def download(symbol: str, period: str = SCAN_PERIOD) -> pd.DataFrame:
    df = yf.download(
        symbol,
        period=period,
        interval="1d",
        auto_adjust=True,
        progress=False,
        threads=False,
    )
    if df is None or df.empty:
        return pd.DataFrame()

    if isinstance(df.columns, pd.MultiIndex):
        price_names = {"Open", "High", "Low", "Close", "Adj Close", "Volume"}
        if any(str(x) in price_names for x in df.columns.get_level_values(0)):
            df.columns = df.columns.get_level_values(0)
        else:
            df.columns = df.columns.get_level_values(-1)

    df.columns = [str(c).title() for c in df.columns]
    required = ["Open", "High", "Low", "Close"]
    if not all(c in df.columns for c in required):
        return pd.DataFrame()

    if "Volume" not in df.columns:
        df["Volume"] = np.nan

    return df[["Open", "High", "Low", "Close", "Volume"]].dropna(
        subset=["Open", "High", "Low", "Close"]
    ).copy()


def swing_points(df: pd.DataFrame, window: int = 5):
    w = 2 * window + 1
    rolling_high = df.High.rolling(w, center=True).max()
    rolling_low = df.Low.rolling(w, center=True).min()

    high_mask = df.High.eq(rolling_high).fillna(False)
    low_mask = df.Low.eq(rolling_low).fillna(False)

    highs = [(i, float(df.High.iloc[i])) for i in np.flatnonzero(high_mask.to_numpy())]
    lows = [(i, float(df.Low.iloc[i])) for i in np.flatnonzero(low_mask.to_numpy())]
    return highs, lows


def cluster(levels: list[float], tolerance: float = 0.02, min_touches: int = 3):
    if not levels:
        return []

    levels = sorted(map(float, levels))
    clusters = [[levels[0]]]

    for x in levels[1:]:
        mean = float(np.mean(clusters[-1]))
        if abs(x - mean) / mean <= tolerance:
            clusters[-1].append(x)
        else:
            clusters.append([x])

    return [
        {
            "level": float(np.mean(c)),
            "touches": len(c),
            "low": float(min(c)),
            "high": float(max(c)),
        }
        for c in clusters
        if len(c) >= min_touches
    ]


def all_sr_levels(df: pd.DataFrame):
    highs, lows = swing_points(df, window=5)

    out = []

    for x in cluster([v for _, v in lows]):
        out.append({**x, "type": "SUPPORT"})

    for x in cluster([v for _, v in highs]):
        out.append({**x, "type": "RESISTANCE"})

    return out


def nearest_sr(df: pd.DataFrame, near_pct: float = 0.02, breakout_pct: float = 0.02):
    price = float(df.Close.iloc[-1])
    candidates = []

    for x in all_sr_levels(df):
        zone_low = float(x["low"])
        zone_high = float(x["high"])
        level = float(x["level"])

        if x["type"] == "SUPPORT":
            distance = max(0.0, price - zone_high) / price if price > zone_high else 0.0
            relevant = price >= zone_low * (1 - near_pct)
        else:
            distance = max(0.0, zone_low - price) / price if price < zone_low else 0.0
            relevant = price <= zone_high * (1 + near_pct)

        if relevant and (abs(price - level) / price <= near_pct or (zone_low <= price <= zone_high)):
            candidates.append({
                **x,
                "level": level,
                "zone_low": zone_low,
                "zone_high": zone_high,
                "distance_pct": distance * 100,
            })

    if not candidates:
        return None

    nearest = min(candidates, key=lambda x: x["distance_pct"] if x["distance_pct"] > 0 else abs(price - x["level"]) / price)

    nearest["nearing_breakout"] = (
        nearest["type"] == "RESISTANCE"
        and price < nearest["zone_high"]
        and (nearest["zone_low"] - price) / price <= breakout_pct
    )
    return nearest


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    df["SMA44"] = df.Close.rolling(44).mean()
    df["SMA200"] = df.Close.rolling(200).mean()

    df["SMA44_22D_AGO"] = df.SMA44.shift(SLOPE_LOOKBACK)
    df["SMA200_22D_AGO"] = df.SMA200.shift(SLOPE_LOOKBACK)

    # IMPORTANT:
    # Shift by one day so the breakout day's volume is compared only with
    # the 20 sessions BEFORE the breakout. This avoids look-ahead leakage.
    df["AVG_VOLUME_20D_PRIOR"] = df.Volume.shift(1).rolling(VOLUME_LOOKBACK).mean()
    df["VOLUME_RATIO"] = df.Volume / df.AVG_VOLUME_20D_PRIOR

    return df


def resistance_for_historical_day(
    history: pd.DataFrame,
    price: float,
    near_pct: float = 0.02,
):
    """Find a clustered resistance zone using only data before the breakout day."""
    if len(history) < 20:
        return None

    candidates = []
    highs, _ = swing_points(history, window=5)
    for x in cluster([v for _, v in highs]):
        zone_low = float(x["low"])
        zone_high = float(x["high"])
        distance = (zone_low - price) / price

        if zone_low >= price and abs(distance) <= near_pct:
            candidates.append({
                **x,
                "type": "RESISTANCE",
                "zone_low": zone_low,
                "zone_high": zone_high,
                "distance_pct": abs(distance) * 100,
            })

    if not candidates:
        return None

    return min(candidates, key=lambda x: x["distance_pct"])


def build_trade_plan(resistance: dict | None):
    if not resistance or resistance.get("type") != "RESISTANCE":
        return None

    zone_low = float(resistance.get("zone_low", resistance["level"]))
    zone_high = float(resistance.get("zone_high", resistance["level"]))
    entry = zone_high * 1.005
    stop = zone_low * 0.995
    risk = max(entry - stop, entry * 0.005)

    return {
        "buy_at": round(entry, 2),
        "stop_loss": round(stop, 2),
        "sell_at_target_1": round(entry + (2 * risk), 2),
        "sell_at_target_2": round(entry + (3 * risk), 2),
        "risk_per_share": round(risk, 2),
        "risk_reward_target_1": 2.0,
        "risk_reward_target_2": 3.0,
    }


def detect_fresh_breakout(
    df: pd.DataFrame,
    near_pct: float = 0.02,
    volume_threshold: float = DEFAULT_VOLUME_THRESHOLD,
):
    """Detect a breakout on the immediately previous completed session."""
    if len(df) < 250:
        return None

    breakout_idx = len(df) - 2
    today_idx = len(df) - 1
    before_breakout = df.iloc[:breakout_idx].copy()

    prev_close = float(df.Close.iloc[breakout_idx - 1])
    breakout_close = float(df.Close.iloc[breakout_idx])
    breakout_high = float(df.High.iloc[breakout_idx])
    breakout_volume = float(df.Volume.iloc[breakout_idx]) if pd.notna(df.Volume.iloc[breakout_idx]) else np.nan

    resistance = resistance_for_historical_day(before_breakout, prev_close, near_pct=near_pct)
    if resistance is None:
        return None

    zone_low = float(resistance["zone_low"])
    zone_high = float(resistance["zone_high"])

    if prev_close > zone_high:
        return None
    if breakout_close <= zone_high:
        return None

    avg_volume = df["AVG_VOLUME_20D_PRIOR"].iloc[breakout_idx]
    volume_ratio = (
        breakout_volume / float(avg_volume)
        if pd.notna(avg_volume) and float(avg_volume) > 0
        else np.nan
    )
    volume_confirmed = bool(pd.notna(volume_ratio) and volume_ratio >= volume_threshold)

    today_price = float(df.Close.iloc[today_idx])
    today_above_resistance = today_price > zone_high
    status = "FRESH_BREAKOUT_HOLDING" if today_above_resistance else "FRESH_BREAKOUT_FAILED"

    return {
        "breakout_date": df.index[breakout_idx].strftime("%Y-%m-%d"),
        "today_date": df.index[today_idx].strftime("%Y-%m-%d"),
        "resistance": round(float(resistance["level"]), 2),
        "resistance_zone_low": round(zone_low, 2),
        "resistance_zone_high": round(zone_high, 2),
        "resistance_touches": int(resistance["touches"]),
        "breakout_close": round(breakout_close, 2),
        "breakout_high": round(breakout_high, 2),
        "previous_close": round(prev_close, 2),
        "today_price": round(today_price, 2),
        "today_above_resistance": today_above_resistance,
        "breakout_volume": int(breakout_volume) if pd.notna(breakout_volume) else None,
        "avg_volume_20d": round(float(avg_volume), 2) if pd.notna(avg_volume) else None,
        "volume_ratio": round(float(volume_ratio), 2) if pd.notna(volume_ratio) else None,
        "volume_threshold": volume_threshold,
        "volume_confirmed": volume_confirmed,
        "status": status,
        "trade_plan": build_trade_plan(resistance),
    }


def detect_candlesticks(df: pd.DataFrame) -> list[dict[str, Any]]:
    if len(df) < 3:
        return []

    i = len(df) - 1
    cur = df.iloc[i]
    prev = df.iloc[i - 1]

    cur_body = abs(float(cur.Close - cur.Open))
    prev_body = abs(float(prev.Close - prev.Open))
    cur_range = max(float(cur.High - cur.Low), 1e-9)

    upper_wick = float(cur.High - max(cur.Open, cur.Close))
    lower_wick = float(min(cur.Open, cur.Close) - cur.Low)

    patterns = []

    if (
        prev.Close < prev.Open
        and cur.Close > cur.Open
        and cur.Open <= prev.Close
        and cur.Close >= prev.Open
        and cur_body >= prev_body * 0.9
    ):
        patterns.append({
            "name": "Bullish Engulfing",
            "type": "BULLISH",
            "date": df.index[i].strftime("%Y-%m-%d"),
        })

    if (
        cur_body / cur_range <= 0.40
        and lower_wick >= cur_body * 2.0
        and upper_wick <= max(cur_body * 1.2, cur_range * 0.20)
    ):
        patterns.append({
            "name": "Hammer",
            "type": "BULLISH",
            "date": df.index[i].strftime("%Y-%m-%d"),
        })

    a, b, c = df.iloc[i - 2], df.iloc[i - 1], df.iloc[i]
    a_body = abs(float(a.Close - a.Open))
    b_body = abs(float(b.Close - b.Open))
    c_body = abs(float(c.Close - c.Open))

    if (
        a.Close < a.Open
        and a_body > 0
        and b_body <= a_body * 0.45
        and c.Close > c.Open
        and c_body >= a_body * 0.55
        and c.Close >= (a.Open + a.Close) / 2
    ):
        patterns.append({
            "name": "Morning Star",
            "type": "BULLISH",
            "date": df.index[i].strftime("%Y-%m-%d"),
        })

    return patterns


def weekly_confirmation(df: pd.DataFrame) -> dict[str, Any]:
    weekly = df.resample("W-FRI").agg({
        "Open": "first",
        "High": "max",
        "Low": "min",
        "Close": "last",
        "Volume": "sum",
    }).dropna(subset=["Close"])

    if len(weekly) < 44:
        return {
            "weekly_close": None,
            "weekly_sma44": None,
            "weekly_sma44_rising": None,
            "weekly_bullish": None,
        }

    weekly["SMA44"] = weekly.Close.rolling(44).mean()

    current = weekly.iloc[-1]
    prior = weekly.iloc[-5] if len(weekly) >= 5 else weekly.iloc[-2]

    close = float(current.Close)
    sma44 = float(current.SMA44)
    old_sma44 = float(prior.SMA44) if pd.notna(prior.SMA44) else np.nan

    return {
        "weekly_close": round(close, 2),
        "weekly_sma44": round(sma44, 2),
        "weekly_sma44_rising": bool(pd.notna(old_sma44) and sma44 > old_sma44),
        "weekly_bullish": bool(close > sma44 and sma44 > old_sma44),
    }


def analyze(
    symbol: str,
    near_pct: float = 0.02,
    breakout_pct: float = 0.02,
    volume_threshold: float = DEFAULT_VOLUME_THRESHOLD,
    include_candles: bool = True,
):
    df = download(symbol)

    if len(df) < 200 + SLOPE_LOOKBACK:
        return None

    df = add_indicators(df)
    last = df.iloc[-1]

    price = float(last.Close)
    sma44 = float(last.SMA44)
    sma200 = float(last.SMA200)
    sma44_22d = float(last.SMA44_22D_AGO)
    sma200_22d = float(last.SMA200_22D_AGO)

    above_sma44 = price > sma44
    above_sma200 = price > sma200
    sma44_rising = sma44 > sma44_22d
    sma200_rising = sma200 > sma200_22d

    sr = nearest_sr(df, near_pct, breakout_pct)
    fresh = detect_fresh_breakout(df, near_pct, volume_threshold)
    trade_plan = build_trade_plan(sr)
    weekly = weekly_confirmation(df)

    qualified = (
        above_sma44
        and above_sma200
        and sma44_rising
        and sma200_rising
        and sr is not None
    )

    chart_candles = []
    if include_candles:
        # The full 1-year candle payload is only needed for the detail view.
        # Building ~250 dictionaries for every one of 500 stocks wastes CPU
        # and memory during the scanner run, especially when most stocks are
        # filtered out.
        chart_candles = [
            {
                "time": idx.strftime("%Y-%m-%d"),
                "open": round(float(row.Open), 2),
                "high": round(float(row.High), 2),
                "low": round(float(row.Low), 2),
                "close": round(float(row.Close), 2),
                "volume": int(row.Volume) if pd.notna(row.Volume) else None,
                "sma44": round(float(row.SMA44), 2) if pd.notna(row.SMA44) else None,
                "sma200": round(float(row.SMA200), 2) if pd.notna(row.SMA200) else None,
            }
            for idx, row in df.iterrows()
        ]

    return {
        "symbol": symbol.removesuffix(".NS"),
        "date": df.index[-1].strftime("%Y-%m-%d"),
        "price": round(price, 2),
        "sma44": round(sma44, 2),
        "sma200": round(sma200, 2),
        "sma44_rising": sma44_rising,
        "sma200_rising": sma200_rising,
        "above_sma44": above_sma44,
        "above_sma200": above_sma200,
        "near_sr": sr is not None,
        "nearing_breakout": bool(sr and sr.get("nearing_breakout", False)),
        "qualified": qualified,
        "sr": sr,
        "trade_plan": trade_plan,
        "candlesticks": detect_candlesticks(df),
        "weekly": weekly,
        "candles": chart_candles,
        "fresh_breakout": fresh,
    }


def latest_yahoo_price(symbol: str):
    """Fetch only the latest quote for a single symbol.

    This endpoint is intentionally separate from the full scanner so paper
    positions do not wait for the Nifty 500 historical scan to finish.
    """
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    params = {"range": "1d", "interval": "1m", "includePrePost": "false"}
    r = requests.get(
        url,
        params=params,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=10,
    )
    r.raise_for_status()
    payload = r.json()
    result = (payload.get("chart", {}).get("result") or [None])[0]
    if not result:
        return None

    meta = result.get("meta", {})
    timestamps = result.get("timestamp") or []
    closes = ((result.get("indicators", {}).get("quote") or [{}])[0]).get("close") or []

    # Prefer Yahoo's current market quote when available.
    price = meta.get("regularMarketPrice")
    price_time = meta.get("regularMarketTime")

    # Fall back to the latest available 1-minute candle close.
    if price is None:
        for ts, close in reversed(list(zip(timestamps, closes))):
            if close is not None:
                price = close
                price_time = ts
                break

    if price is None:
        return None

    return {
        "symbol": symbol.removesuffix(".NS"),
        "price": round(float(price), 2),
        "timestamp": int(price_time) if price_time else None,
    }


@app.get("/api/prices")
def latest_prices(symbols: str = Query(..., min_length=1, max_length=2000)):
    """Lightweight latest-price endpoint for paper-trading positions.

    Accepts comma-separated NSE symbols, e.g. RELIANCE,TCS,INFY.
    It does NOT run the Nifty 500 scanner.
    """
    requested = []
    for raw in symbols.split(","):
        clean = raw.strip().upper().replace(".NS", "")
        if clean and clean not in requested:
            requested.append(clean)

    if not requested:
        return {"prices": {}, "errors": {}, "updated_at": pd.Timestamp.utcnow().isoformat()}

    if len(requested) > 50:
        raise HTTPException(status_code=400, detail="Maximum 50 symbols per price request")

    prices = {}
    errors = {}

    with ThreadPoolExecutor(max_workers=min(8, len(requested))) as pool:
        futures = {pool.submit(latest_yahoo_price, f"{symbol}.NS"): symbol for symbol in requested}
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                result = future.result()
                if result:
                    prices[symbol] = result
                else:
                    errors[symbol] = "No price returned"
            except Exception as exc:
                errors[symbol] = str(exc)

    return {"prices": prices, "errors": errors, "updated_at": pd.Timestamp.utcnow().isoformat()}


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "1.8.0", "scan_period": SCAN_PERIOD, "scan_workers": SCAN_WORKERS}


@app.get("/api/stocks")
def stocks(
    near_pct: float = Query(0.02, ge=0.001, le=0.10),
    breakout_pct: float = Query(0.02, ge=0.005, le=0.10),
    volume_threshold: float = Query(
        DEFAULT_VOLUME_THRESHOLD, ge=0.5, le=5.0
    ),
):
    results = []
    fresh_breakouts = []
    skipped = []

    symbols = nifty500_symbols()

    # The old implementation scanned all symbols sequentially. Each call to
    # analyze() performs a network request to Yahoo Finance, so one slow
    # request could hold up the entire 500-stock scan. Run independent symbols
    # concurrently instead. The worker count is capped to avoid hammering
    # Yahoo and triggering rate limits.
    def scan_one(symbol: str):
        return analyze(
            symbol,
            near_pct,
            breakout_pct,
            volume_threshold,
            include_candles=False,
        )

    with ThreadPoolExecutor(max_workers=min(SCAN_WORKERS, len(symbols))) as pool:
        futures = {pool.submit(scan_one, symbol): symbol for symbol in symbols}

        for future in as_completed(futures):
            symbol = futures[future]
            clean_symbol = symbol.removesuffix(".NS")
            try:
                result = future.result()

                if result is None:
                    skipped.append(clean_symbol)
                    continue

                if result["qualified"]:
                    results.append(result)

                if result["fresh_breakout"] is not None:
                    fresh_breakouts.append(result)

            except Exception:
                skipped.append(clean_symbol)

    return {
        "count": len(results),
        "universe_count": len(symbols),
        "scanned_count": len(symbols) - len(skipped),
        "skipped_count": len(skipped),
        "skipped_symbols": skipped,
        "slope_lookback_days": SLOPE_LOOKBACK,
        "breakout_proximity_pct": breakout_pct * 100,
        "volume_confirmation_threshold": volume_threshold,
        "results": results,
        "fresh_breakouts": fresh_breakouts,
        "fresh_breakout_count": len(fresh_breakouts),
    }


@app.get("/api/stocks/{symbol}")
def stock_detail(
    symbol: str,
    volume_threshold: float = Query(
        DEFAULT_VOLUME_THRESHOLD, ge=0.5, le=5.0
    ),
):
    clean = symbol.upper().replace(".NS", "")
    result = analyze(
        clean + ".NS",
        volume_threshold=volume_threshold,
        include_candles=True,
    )

    if result is None:
        raise HTTPException(status_code=404, detail="Insufficient data")

    return result
