# Nifty 500 Swing Scanner V1

Local research app for:
- Close > SMA44
- Close > SMA200
- Price near major historical support/resistance

Stack: FastAPI + pandas + yfinance; React + TypeScript + Vite; TradingView Lightweight Charts.

## Backend
```powershell
cd backend
python -m venv .venv
.\\.venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## Frontend
```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal.


## V1.1 Scanner Rules

A stock qualifies only when ALL of these conditions are true:

1. Close > SMA44
2. Close > SMA200
3. SMA44(today) > SMA44(22 trading days ago)
4. SMA200(today) > SMA200(22 trading days ago)
5. Current price is within the selected percentage of a major historical support or resistance level.

No RSI, MACD, Fibonacci, volume, BOS/CHOCH, candle-pattern, or trendline filters are included in this version.


## V1.2 — Nearing Breakout Filter

A stock is classified as `NEAR BREAKOUT` only when its nearest detected major S/R level is:

- RESISTANCE
- Current price is below that resistance
- Price is within the configured breakout proximity (default 2%)

This is an approach-to-resistance classification, not a confirmed breakout.

UI filters:
- All
- Near Support
- Near Resistance
- Nearing Breakout

Breakout proximity can be set to 1%, 2%, 3%, or 5%.

## V1.3 — UI Refresh

The frontend now includes summary metrics, clearer filter controls, tabs for support/resistance/breakout views, stock search, sorting, loading/empty/error states, responsive layout, and a cleaner stock detail/chart view.
