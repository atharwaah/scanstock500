import { useEffect, useMemo, useState } from "react";
import StockChart from "./components/StockChart";
import "./styles.css";

const API = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

type View = "all" | "breakout" | "fresh" | "confirmed" | "support" | "resistance" | "candlestick";
type CandleSignal = { name: string; type: string; date: string; explanation?: string };
type TradePlan = { buy_at: number; stop_loss: number; sell_at_target_1: number; sell_at_target_2: number; risk_per_share: number; risk_reward_target_1: number; risk_reward_target_2: number };
type PaperPosition = { symbol: string; quantity: number; avgBuyPrice: number; currentPrice: number; openedAt: string };
type PaperTrade = { id: string; symbol: string; side: "BUY" | "SELL"; quantity: number; price: number; value: number; timestamp: string };
type PaperPortfolio = { startingCapital: number; cash: number; positions: PaperPosition[]; trades: PaperTrade[] };

type Result = {
  symbol: string;
  date: string;
  price: number;
  sma44: number;
  sma200: number;
  sma44_rising: boolean;
  sma200_rising: boolean;
  above_sma44: boolean;
  above_sma200: boolean;
  near_sr: boolean;
  nearing_breakout: boolean;
  qualified: boolean;
  trade_plan?: TradePlan | null;
  sr?: {
    type: "SUPPORT" | "RESISTANCE";
    level: number;
    zone_low?: number;
    zone_high?: number;
    distance_pct: number;
    touches: number;
    nearing_breakout: boolean;
  } | null;
  candlesticks?: CandleSignal[];
  weekly?: {
    weekly_close: number | null;
    weekly_sma44: number | null;
    weekly_sma44_rising: boolean | null;
    weekly_bullish: boolean | null;
  };
  fresh_breakout?: {
    status: string;
    breakout_date: string;
    today_date: string;
    resistance: number;
    resistance_touches: number;
    breakout_close: number;
    today_price: number;
    breakout_volume: number;
    avg_volume_20d: number;
    volume_ratio: number | null;
    volume_threshold: number;
    volume_confirmed: boolean;
  } | null;
  candles?: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
    sma44: number | null;
    sma200: number | null;
  }>;
};

export default function App() {
  const [results, setResults] = useState<Result[]>([]);
  const [freshBreakouts, setFreshBreakouts] = useState<Result[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [nearPct, setNearPct] = useState(2);
  const [breakoutPct, setBreakoutPct] = useState(2);
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"distance" | "symbol" | "price">("distance");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scannedAt, setScannedAt] = useState("");
  const [scanMeta, setScanMeta] = useState({ universe: 0, scanned: 0, skipped: 0 });
  const [chartTimeframe, setChartTimeframe] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("DAILY");
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [paper, setPaper] = useState<PaperPortfolio>(() => {
    try {
      const saved = localStorage.getItem("n5-paper-portfolio");
      if (saved) return JSON.parse(saved);
    } catch {}
    return { startingCapital: 100000, cash: 100000, positions: [], trades: [] };
  });
  const [paperAmount, setPaperAmount] = useState(10000);
  const [paperPricesUpdatedAt, setPaperPricesUpdatedAt] = useState("");
  const [paperPricesLoading, setPaperPricesLoading] = useState(false);

  async function scan() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `${API}/api/stocks?near_pct=${nearPct / 100}&breakout_pct=${breakoutPct / 100}`
      );
      if (!response.ok) throw new Error(`Scanner returned ${response.status}`);
      const data = await response.json();
      setResults(data.results ?? []);
      setFreshBreakouts(data.fresh_breakouts ?? []);
      const priceMap: Record<string, number> = {};
      for (const r of [...(data.results ?? []), ...(data.fresh_breakouts ?? [])]) priceMap[r.symbol] = r.price ?? r.fresh_breakout?.today_price;
      updatePortfolioPrices(priceMap);
      setScanMeta({
        universe: data.universe_count ?? 0,
        scanned: data.scanned_count ?? 0,
        skipped: data.skipped_count ?? 0,
      });
      setScannedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch {
      setError("Could not connect to the scanner. Make sure the FastAPI backend is running.");
    } finally {
      setLoading(false);
    }
  }

  async function openStock(symbol: string) {
    setSelected(symbol);
    setDetail(null);
    setError("");
    try {
      const response = await fetch(`${API}/api/stocks/${symbol}`);
      if (!response.ok) throw new Error();
      setDetail(await response.json());
    } catch {
      setError(`Could not load ${symbol}.`);
    }
  }

  useEffect(() => { scan(); }, []);

  useEffect(() => {
    try { localStorage.setItem("n5-paper-portfolio", JSON.stringify(paper)); } catch {}
  }, [paper]);

  async function refreshPaperPrices() {
    const symbols = paper.positions.map(p => p.symbol);
    if (!symbols.length) return;
    setPaperPricesLoading(true);
    try {
      const response = await fetch(`${API}/api/prices?symbols=${encodeURIComponent(symbols.join(","))}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Price service returned ${response.status}`);
      const data = await response.json();
      const priceMap: Record<string, number> = {};
      for (const [symbol, quote] of Object.entries(data.prices ?? {}) as Array<[string, { price: number }]>) {
        if (quote?.price != null) priceMap[symbol] = quote.price;
      }
      updatePortfolioPrices(priceMap);
      setPaperPricesUpdatedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch {
      // Keep the last known price rather than replacing it with zero/stale scanner data.
    } finally {
      setPaperPricesLoading(false);
    }
  }

  useEffect(() => {
    if (!paper.positions.length) return;
    refreshPaperPrices();
    const timer = window.setInterval(refreshPaperPrices, 30000);
    return () => window.clearInterval(timer);
  }, [paper.positions.map(p => p.symbol).join(",")]);

  function updatePortfolioPrices(priceMap: Record<string, number>) {
    setPaper(prev => ({ ...prev, positions: prev.positions.map(pos => priceMap[pos.symbol] != null ? { ...pos, currentPrice: priceMap[pos.symbol] } : pos) }));
  }

  function paperBuy(symbol: string, price: number, amount: number) {
    const qty = Math.floor(amount / price);
    if (qty < 1) return;
    setPaper(prev => {
      const cost = qty * price;
      if (cost > prev.cash) return prev;
      const existing = prev.positions.find(p => p.symbol === symbol);
      const positions = existing
        ? prev.positions.map(p => p.symbol === symbol ? { ...p, quantity: p.quantity + qty, avgBuyPrice: ((p.quantity * p.avgBuyPrice) + cost) / (p.quantity + qty), currentPrice: price } : p)
        : [...prev.positions, { symbol, quantity: qty, avgBuyPrice: price, currentPrice: price, openedAt: new Date().toISOString() }];
      return { ...prev, cash: prev.cash - cost, positions, trades: [{ id: crypto.randomUUID(), symbol, side: "BUY", quantity: qty, price, value: cost, timestamp: new Date().toISOString() }, ...prev.trades] };
    });
  }

  function paperSell(symbol: string, quantity: number, price: number) {
    setPaper(prev => {
      const pos = prev.positions.find(p => p.symbol === symbol);
      if (!pos || quantity < 1 || quantity > pos.quantity) return prev;
      const value = quantity * price;
      const positions = pos.quantity === quantity ? prev.positions.filter(p => p.symbol !== symbol) : prev.positions.map(p => p.symbol === symbol ? { ...p, quantity: p.quantity - quantity, currentPrice: price } : p);
      return { ...prev, cash: prev.cash + value, positions, trades: [{ id: crypto.randomUUID(), symbol, side: "SELL", quantity, price, value, timestamp: new Date().toISOString() }, ...prev.trades] };
    });
  }

  function resetPaper() {
    if (window.confirm("Reset the paper portfolio and all virtual trades?")) setPaper({ startingCapital: paper.startingCapital, cash: paper.startingCapital, positions: [], trades: [] });
  }

  const paperInvested = paper.positions.reduce((sum, p) => sum + p.quantity * p.avgBuyPrice, 0);
  const paperMarketValue = paper.positions.reduce((sum, p) => sum + p.quantity * p.currentPrice, 0);
  const paperUnrealized = paper.positions.reduce((sum, p) => sum + p.quantity * (p.currentPrice - p.avgBuyPrice), 0);
  const paperRealized = paper.trades.reduce((sum, t) => {
    if (t.side !== "SELL") return sum;
    const buys = paper.trades.filter(b => b.symbol === t.symbol && b.side === "BUY");
    const avg = buys.length ? buys.reduce((a,b) => a + b.price*b.quantity, 0) / buys.reduce((a,b) => a + b.quantity, 0) : t.price;
    return sum + (t.price - avg) * t.quantity;
  }, 0);
  const paperTotalValue = paper.cash + paperMarketValue;
  const paperTotalPnl = paperTotalValue - paper.startingCapital;

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const rows = results.filter((x) => {
      if (q && !x.symbol.includes(q)) return false;
      if (view === "support") return x.sr?.type === "SUPPORT";
      if (view === "resistance") return x.sr?.type === "RESISTANCE";
      if (view === "breakout") return x.nearing_breakout;
      if (view === "fresh") return freshBreakouts.some(f => f.symbol === x.symbol);
      if (view === "candlestick") return (x.candlesticks ?? []).length > 0;
      return true;
    });
    return [...rows].sort((a, b) => {
      if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
      if (sort === "price") return b.price - a.price;
      return (a.sr?.distance_pct ?? 999) - (b.sr?.distance_pct ?? 999);
    });
  }, [results, freshBreakouts, view, query, sort]);

  const breakoutCount = results.filter(x => x.nearing_breakout).length;
  const resistanceCount = results.filter(x => x.sr?.type === "RESISTANCE").length;
  const supportCount = results.filter(x => x.sr?.type === "SUPPORT").length;
  const candleCount = results.filter(x => (x.candlesticks ?? []).length > 0).length;
  const freshCount = freshBreakouts.length;

  if (showPortfolio) {
    return (
      <main className="app-shell">
        <button className="back-button" onClick={() => setShowPortfolio(false)}>← <span>Back to Scanner</span></button>
        <header className="detail-topbar">
          <div><div className="eyebrow">PAPER TRADING</div><h1>Virtual Portfolio</h1><p>Simulated money only. No real orders are placed.</p></div>
          <div className="header-actions"><button className="reset-button" onClick={resetPaper}>Reset portfolio</button><button className="primary-button" onClick={refreshPaperPrices} disabled={paperPricesLoading}>{paperPricesLoading ? "Updating…" : "↻ Update prices"}</button></div>
        </header>
        <section className="metric-grid">
          <Metric label="Portfolio value" value={`₹${paperTotalValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} sub={`Starting ₹${paper.startingCapital.toLocaleString("en-IN")}`} accent={paperTotalPnl >= 0} />
          <Metric label="Total P&L" value={`${paperTotalPnl >= 0 ? "+" : "-"}₹${Math.abs(paperTotalPnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} sub={`${((paperTotalPnl / paper.startingCapital) * 100).toFixed(2)}%`} accent={paperTotalPnl >= 0} />
          <Metric label="Invested" value={`₹${paperInvested.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} sub={`${paper.positions.length} open position${paper.positions.length === 1 ? "" : "s"}`} />
          <Metric label="Available cash" value={`₹${paper.cash.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} sub={`Unrealized P&L ${paperUnrealized >= 0 ? "+" : "-"}₹${Math.abs(paperUnrealized).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} />
        </section>
        <section className="control-panel">
          <div className="panel-heading"><div><strong>Starting virtual capital</strong><span>Change this only when starting a new portfolio.</span></div></div>
          <div className="controls"><input type="number" min="1000" step="1000" value={paper.startingCapital} onChange={e => { const v = Number(e.target.value); if (!paper.trades.length && v >= 1000) setPaper({ ...paper, startingCapital: v, cash: v }); }} /><span className="muted">Reset the portfolio after changing the amount.</span></div>
        </section>
        {paper.positions.length === 0 ? <div className="empty-card"><strong>No open paper positions</strong><span>Open a stock and use the Paper Buy button to simulate an entry.</span></div> : <section className="paper-table-card"><div className="paper-table-head"><strong>Open positions</strong><span>Prices update independently from the slow Nifty 500 scan · every 30 seconds{paperPricesUpdatedAt ? ` · Last update ${paperPricesUpdatedAt}` : ""}</span></div>{paper.positions.map(pos => { const pnl = (pos.currentPrice - pos.avgBuyPrice) * pos.quantity; return <div className="paper-row" key={pos.symbol}><div><strong>{pos.symbol}</strong><small>{pos.quantity} shares · Avg ₹{pos.avgBuyPrice.toFixed(2)}</small></div><div>₹{pos.currentPrice.toFixed(2)}</div><div className={pnl >= 0 ? "pnl-positive" : "pnl-negative"}>{pnl >= 0 ? "+" : "-"}₹{Math.abs(pnl).toFixed(2)}</div><button className="tool-btn" onClick={() => paperSell(pos.symbol, pos.quantity, pos.currentPrice)}>Sell all</button></div>})}</section>}
        <section className="paper-table-card"><div className="paper-table-head"><strong>Trade history</strong><span>Realized P&L is tracked when virtual shares are sold.</span></div>{paper.trades.length === 0 ? <div className="muted">No trades yet.</div> : paper.trades.slice(0, 30).map(t => <div className="paper-row history" key={t.id}><div><strong>{t.side} · {t.symbol}</strong><small>{new Date(t.timestamp).toLocaleString()}</small></div><div>{t.quantity} × ₹{t.price.toFixed(2)}</div><div>₹{t.value.toFixed(2)}</div><span className={t.side === "BUY" ? "muted" : "pnl-positive"}>{t.side}</span></div>)}</section>
        <footer className="app-footer">Paper trading is for testing the scanner, not a record of actual investment performance.</footer>
      </main>
    );
  }

  if (selected) {
    const chartCandles = Array.isArray(detail?.candles) ? detail.candles : [];
    const last = chartCandles.at(-1);
    const candleSignals: CandleSignal[] = Array.isArray(detail?.candlesticks) ? detail.candlesticks : [];
    const sr = detail?.sr ?? null;
    const fresh = detail?.fresh_breakout ?? null;

    return (
      <main className="app-shell">
        <button className="back-button" onClick={() => { setSelected(null); setDetail(null); }}>
          ← <span>Back to Scanner</span>
        </button>

        <header className="detail-topbar">
          <div>
            <div className="eyebrow">NIFTY 500 · DAILY</div>
            <div className="stock-title-row">
              <h1>{selected}</h1>
              {detail?.sr?.nearing_breakout && <span className="badge badge-breakout">NEAR BREAKOUT</span>}
            </div>
            <p>Trend, price level and candlestick context</p>
          </div>
          <div className="header-actions"><button className="reset-button" onClick={() => setShowPortfolio(true)}>Paper Portfolio</button><button className="primary-button" onClick={() => openStock(selected)}>↻ Refresh</button></div>
        </header>

        {error && <div className="error-banner">⚠ {error}</div>}

        {detail ? (
          <>
            <section className="metric-grid detail-metrics">
              <Metric label="Last close" value={`₹${last?.close?.toFixed(2) ?? "—"}`} />
              <Metric label="SMA44" value={`₹${last?.sma44?.toFixed(2) ?? "—"}`} />
              <Metric label="SMA200" value={`₹${last?.sma200?.toFixed(2) ?? "—"}`} />
              <Metric
                label={sr?.type === "RESISTANCE" ? "Resistance" : "Support"}
                value={sr ? `₹${(sr.zone_low ?? sr.level).toFixed(2)}–₹${(sr.zone_high ?? sr.level).toFixed(2)}` : "—"}
                sub={sr ? `${sr.distance_pct.toFixed(2)}% from zone · ${sr.touches} touches` : "No nearby zone"}
              />
            </section>

            {detail?.trade_plan && (
              <section className="trade-plan-card">
                <div>
                  <div className="card-label">BREAKOUT TRADE PLAN</div>
                  <p className="trade-plan-note">
                    Scanner-generated levels based on the current resistance zone. These are test levels, not predictions.
                  </p>
                </div>
            
                <div className="trade-plan-grid">
                  <div>
                    <span>Buy at</span>
                    <strong>₹{detail.trade_plan.buy_at.toFixed(2)}</strong>
                  </div>
            
                  <div>
                    <span>Stop loss</span>
                    <strong>₹{detail.trade_plan.stop_loss.toFixed(2)}</strong>
                  </div>
            
                  <div>
                    <span>Sell / Target 1</span>
                    <strong>₹{detail.trade_plan.sell_at_target_1.toFixed(2)}</strong>
                  </div>
            
                  <div>
                    <span>Sell / Target 2</span>
                    <strong>₹{detail.trade_plan.sell_at_target_2.toFixed(2)}</strong>
                  </div>
                </div>
              </section>
            )}
            
            <section className="trade-plan-card">
              <div>
                <div className="card-label">PAPER TRADING</div>
                <p className="trade-plan-note">
                  Simulate a purchase using your virtual portfolio. No real order is placed.
                </p>
              </div>
            
              <div className="trade-plan-actions">
                <input
                  type="number"
                  min="1"
                  value={paperAmount}
                  onChange={e =>
                    setPaperAmount(Math.max(1, Number(e.target.value) || 1))
                  }
                />
            
                <button
                  className="primary-button"
                  onClick={() => paperBuy(selected, detail.price, paperAmount)}
                >
                  Paper Buy at current ₹{detail.price.toFixed(2)}
                </button>
            
                <button
                  className="reset-button"
                  onClick={() => setShowPortfolio(true)}
                >
                  View Portfolio
                </button>
              </div>
            </section>

            <section className="signal-grid">
              <div className="info-card">
                <div className="card-label">FRESH BREAKOUT</div>
                {fresh ? (
                  <>
                    <div className="status-large">{fresh.status.replaceAll("_", " ")}</div>
                    <div className="checks compact">
                      <span>{fresh.volume_confirmed ? "✓" : "○"} Volume ≥ {fresh.volume_threshold.toFixed(2)}× prior 20D average</span>
                      <span>✓ Broke resistance on {fresh.breakout_date}</span>
                      <span>{fresh.today_price > fresh.resistance ? "✓" : "✕"} Above resistance today</span>
                    </div>
                  </>
                ) : (
                  <div className="muted">This stock does not have a one-day-old breakout in the latest scan.</div>
                )}
              </div>
              <div className="info-card">
                <div className="card-label">VOLUME TEST</div>
                {fresh ? (
                  <div className="trade-plan">
                    <span>Breakout volume <strong>{fresh.breakout_volume.toLocaleString("en-IN")}</strong></span>
                    <span>20D avg volume <strong>{fresh.avg_volume_20d.toLocaleString("en-IN")}</strong></span>
                    <span>Volume ratio <strong>{fresh.volume_ratio != null ? `${fresh.volume_ratio.toFixed(2)}×` : "—"}</strong></span>
                    <span>Threshold <strong>{fresh.volume_threshold.toFixed(2)}×</strong></span>
                  </div>
                ) : <div className="muted">No fresh-breakout volume test available.</div>}
              </div>
            </section>

            <section className="why-card">
              <div>
                <div className="card-label">TREND CHECK</div>
                <p>Current scanner rules require price above SMA44 and SMA200, with both moving averages rising over the 22-trading-day lookback.</p>
              </div>
              {sr?.nearing_breakout && <span className="badge badge-breakout">NEAR BREAKOUT</span>}
            </section>

            <section className="signal-grid">
              <div className="info-card">
                <div className="card-label">TREND</div>
                <div className="checks">
                  <span>✓ Above SMA44</span>
                  <span>✓ Above SMA200</span>
                  <span>✓ SMA44 rising 22D</span>
                  <span>✓ SMA200 rising 22D</span>
                </div>
              </div>
              <div className="info-card">
                <div className="card-label">CANDLESTICK</div>
                {candleSignals.length ? candleSignals.map(p => (
                  <div className="candle-signal" key={`${p.name}-${p.date}`}>
                    <span className="signal-dot">●</span>
                    <div><strong>{p.name}</strong><small>{p.explanation}</small></div>
                  </div>
                )) : <div className="muted">No selected bullish candlestick pattern on the latest candle.</div>}
              </div>
            </section>

            <div className="chart-controls">
              <div>
                <div className="chart-range-label">CANDLE INTERVAL</div>
                <div className="chart-range-help">Scanner signals remain daily-based. Use these views for timeframe context.</div>
              </div>
              <div className="chart-ranges">
                {(["DAILY", "WEEKLY", "MONTHLY"] as const).map(timeframe => (
                  <button
                    key={timeframe}
                    className={`range-button ${chartTimeframe === timeframe ? "active" : ""}`}
                    onClick={() => setChartTimeframe(timeframe)}
                  >
                    {timeframe[0] + timeframe.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
            <StockChart candles={chartCandles} sr={sr} patterns={candleSignals} timeframe={chartTimeframe} />
          </>
        ) : <div className="loading-card"><span className="spinner" /> Loading chart…</div>}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="brand-row"><div className="brand-mark">N5</div><span className="eyebrow">MARKET SCANNER</span></div>
          <h1>Nifty 500 Swing Scanner</h1>
          <p>Trend → major price level → breakout proximity → candlestick confirmation.</p>
        </div>
        <div className="header-actions">
          {scannedAt && <span className="scan-time">Last scan {scannedAt}</span>}
          <button className="reset-button" onClick={() => setShowPortfolio(true)}>Paper Portfolio</button>
          <button className="primary-button" onClick={scan} disabled={loading}>
            {loading ? <><span className="spinner" /> Scanning…</> : "↻ Run scan"}
          </button>
        </div>
      </header>

      {error && <div className="error-banner">⚠ {error}</div>}

      <section className="metric-grid">
        <Metric label="Qualified" value={results.length.toString()} sub={`${scanMeta.scanned || "—"} stocks scanned`} />
        <Metric label="Resistance setups" value={resistanceCount.toString()} sub="Near a major resistance level" />
        <Metric label="Near breakout" value={breakoutCount.toString()} sub={`Within ${breakoutPct}% of resistance`} accent />
        <Metric label="Fresh breakout" value={freshCount.toString()} sub="Breakout on previous session" accent />
        <Metric label="Candlestick" value={candleCount.toString()} sub="Bullish signal detected" />
      </section>

      <section className="control-panel">
        <div className="panel-heading">
          <div><strong>Scanner</strong><span>Adjust thresholds and run the scan.</span></div>
          <button className="reset-button" onClick={() => { setNearPct(2); setBreakoutPct(2); setView("all"); setQuery(""); setSort("distance"); }}>Reset</button>
        </div>
        <div className="controls">
          <label className="control"><span>Near S/R</span>
            <select value={nearPct} onChange={e => setNearPct(Number(e.target.value))}>
              <option value={1}>1%</option><option value={2}>2%</option><option value={3}>3%</option><option value={5}>5%</option>
            </select>
          </label>
          <label className="control"><span>Breakout proximity</span>
            <select value={breakoutPct} onChange={e => setBreakoutPct(Number(e.target.value))}>
              <option value={1}>1%</option><option value={2}>2%</option><option value={3}>3%</option><option value={5}>5%</option>
            </select>
          </label>
          <div className="rules"><span>✓ Above SMA44</span><span>✓ Above SMA200</span><span>✓ SMA44 rising 22D</span><span>✓ SMA200 rising 22D</span></div>
        </div>
      </section>

      <section className="toolbar">
        <div className="tabs">
          <Tab active={view === "all"} onClick={() => setView("all")} label={`All ${results.length}`} />
          <Tab active={view === "breakout"} onClick={() => setView("breakout")} label={`Near Breakout ${breakoutCount}`} hot />
          <Tab active={view === "fresh"} onClick={() => setView("fresh")} label={`Fresh Breakout ${freshCount}`} hot />
          <Tab active={view === "resistance"} onClick={() => setView("resistance")} label={`Resistance ${resistanceCount}`} />
          <Tab active={view === "support"} onClick={() => setView("support")} label={`Support ${supportCount}`} />
          <Tab active={view === "candlestick"} onClick={() => setView("candlestick")} label={`Candlestick ${candleCount}`} />
        </div>
        <div className="search-sort">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stock…" />
          <select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
            <option value="distance">Nearest level</option><option value="symbol">A–Z</option><option value="price">Price high–low</option>
          </select>
        </div>
      </section>

      <div className="scan-meta">
        <span>{filtered.length} setup{filtered.length === 1 ? "" : "s"} shown</span>
        <span>{scanMeta.universe ? `${scanMeta.universe} universe · ${scanMeta.skipped} skipped` : "Nifty 500 universe"}</span>
      </div>

      {loading ? (
        <div className="loading-card"><span className="spinner" /> Scanning Nifty 500…</div>
      ) : view === "fresh" ? (
        freshBreakouts.length === 0 ? (
          <div className="empty-card"><strong>No fresh breakouts found</strong><span>No stock closed above a detected major resistance on the previous completed session.</span></div>
        ) : (
          <section className="stock-grid">
            {[...freshBreakouts].filter(stock => !query.trim() || stock.symbol.includes(query.trim().toUpperCase())).map(stock => <FreshBreakoutCard key={stock.symbol} stock={stock} onClick={() => openStock(stock.symbol)} />)}
          </section>
        )
      ) : filtered.length === 0 ? (
        <div className="empty-card"><strong>No setups found</strong><span>Try increasing the S/R proximity or changing the filter.</span></div>
      ) : (
        <section className="stock-grid">
          {filtered.map(stock => <StockCard key={stock.symbol} stock={stock} onClick={() => openStock(stock.symbol)} />)}
        </section>
      )}

      <footer className="app-footer">Nifty 500 · Daily data · Scanner signals are rule-based, not predictions.</footer>
    </main>
  );
}

function Metric({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return <div className={`metric-card ${accent ? "metric-accent" : ""}`}><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}

function Tab({ active, onClick, label, hot = false }: { active: boolean; onClick: () => void; label: string; hot?: boolean }) {
  return <button className={`tab ${active ? "active" : ""} ${hot ? "hot" : ""}`} onClick={onClick}>{label}</button>;
}

function FreshBreakoutCard({ stock, onClick }: { stock: Result; onClick: () => void }) {
  const f = stock.fresh_breakout as any;
  if (!f) return null;
  const ratio = f.volume_ratio;
  const confirmed = !!f.volume_confirmed;
  const holding = f.status === "FRESH_BREAKOUT_HOLDING";

  return (
    <article className={`stock-card fresh-card ${holding ? "is-breakout" : "is-failed"}`} onClick={onClick}>
      <div className="stock-card-top">
        <div><h2>{stock.symbol}</h2><span>Breakout {f.breakout_date} · Today {f.today_date}</span></div>
        <strong className="stock-price">₹{f.today_price?.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
      </div>

      <div className="fresh-banner">
        <span>{holding ? "✓ BREAKOUT HOLDING" : "⚠ FAILED BREAKOUT"}</span>
        <strong>{confirmed ? "VOLUME CONFIRMED" : "VOLUME NOT CONFIRMED"}</strong>
      </div>

      <div className="fresh-grid">
        <div><span>Resistance zone</span><strong>₹{f.resistance_zone_low?.toFixed(2) ?? f.resistance?.toFixed(2) ?? "—"}–₹{f.resistance_zone_high?.toFixed(2) ?? f.resistance?.toFixed(2) ?? "—"}</strong></div>
        <div><span>Breakout close</span><strong>₹{f.breakout_close?.toFixed(2) ?? "—"}</strong></div>
        <div><span>Volume ratio</span><strong className={confirmed ? "volume-good" : ""}>{ratio != null ? `${ratio.toFixed(2)}×` : "—"}</strong></div>
        <div><span>Threshold</span><strong>{f.volume_threshold?.toFixed(2) ?? "1.50"}×</strong></div>
      </div>

      <div className="card-checks">
        <span>{confirmed ? "✓" : "○"} Volume ≥ {f.volume_threshold ?? 1.5}×</span>
        <span>{holding ? "✓" : "✕"} Above resistance today</span>
        <span>✓ {f.resistance_touches ?? 0} resistance touches</span>
      </div>

      {f.trade_plan && <div className="fresh-trade-plan"><span>Buy ₹{f.trade_plan.buy_at.toFixed(2)}</span><span>SL ₹{f.trade_plan.stop_loss.toFixed(2)}</span><span>T1 ₹{f.trade_plan.sell_at_target_1.toFixed(2)}</span><span>T2 ₹{f.trade_plan.sell_at_target_2.toFixed(2)}</span></div>}

      <div className="card-bottom">
        <span className="candle-badge">Test bucket · 1-day-old breakout</span>
        <span className="view-link">View chart →</span>
      </div>
    </article>
  );
}

function StockCard({ stock, onClick }: { stock: Result; onClick: () => void }) {
  const candle = stock.candlesticks?.[0];
  const distance = stock.sr?.distance_pct ?? 0;

  return (
    <article className={`stock-card ${stock.nearing_breakout ? "is-breakout" : ""}`} onClick={onClick}>
      <div className="stock-card-top">
        <div><h2>{stock.symbol}</h2><span>{stock.date}</span></div>
        <strong className="stock-price">₹{stock.price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
      </div>

      <div className="level-row">
        <span className={`level-pill ${(stock.sr?.type ?? "LEVEL").toLowerCase()}`}>{stock.sr?.type ?? "LEVEL"}</span>
        <span>{stock.sr ? `₹${(stock.sr.zone_low ?? stock.sr.level).toFixed(2)}–₹${(stock.sr.zone_high ?? stock.sr.level).toFixed(2)}` : "No nearby zone"}</span>
        <span className="distance">{distance.toFixed(2)}% away</span>
      </div>

      {stock.nearing_breakout && <div className="breakout-strip">🔥 NEAR BREAKOUT · {distance.toFixed(2)}% from resistance</div>}

      <div className="card-checks">
        <span>✓ SMA44</span><span>✓ SMA200</span><span>✓ 22D trend</span>
      </div>

      <div className="card-bottom">
        {candle ? <span className="candle-badge">● {candle.name}</span> : <span className="muted">No candlestick signal</span>}
        <span className="view-link">View chart →</span>
      </div>
    </article>
  );
}
