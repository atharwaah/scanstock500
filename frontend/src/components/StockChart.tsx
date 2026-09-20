import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  sma44: number | null;
  sma200: number | null;
};

type Pattern = { name: string; type?: string; date: string };
type Timeframe = "DAILY" | "WEEKLY" | "MONTHLY";
type DisplayCandle = Candle;

function periodKey(dateString: string, timeframe: Timeframe): string {
  const d = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateString;

  if (timeframe === "MONTHLY") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }

  if (timeframe === "WEEKLY") {
    const day = d.getUTCDay() || 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day + 1);
    return monday.toISOString().slice(0, 10);
  }

  return dateString;
}

function aggregateCandles(candles: Candle[], timeframe: Timeframe): DisplayCandle[] {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const clean = candles.filter(
    c => c && Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) && typeof c.time === "string"
  );
  if (timeframe === "DAILY") return clean;

  const groups = new Map<string, Candle[]>();
  for (const candle of clean) {
    const key = periodKey(candle.time, timeframe);
    const group = groups.get(key);
    if (group) group.push(candle);
    else groups.set(key, [candle]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const first = group[0];
    const last = group[group.length - 1];
    const volumes = group.map(x => x.volume).filter((v): v is number => Number.isFinite(v as number));
    return {
      time: key,
      open: first.open,
      high: Math.max(...group.map(x => x.high)),
      low: Math.min(...group.map(x => x.low)),
      close: last.close,
      volume: volumes.length ? volumes.reduce((a, b) => a + b, 0) : null,
      sma44: null,
      sma200: null,
    };
  });
}

function withMovingAverages(candles: DisplayCandle[]): DisplayCandle[] {
  return candles.map((candle, i) => {
    const sma = (period: number) => {
      if (i + 1 < period) return null;
      let sum = 0;
      for (let j = i + 1 - period; j <= i; j++) sum += candles[j].close;
      return sum / period;
    };
    return { ...candle, sma44: sma(44), sma200: sma(200) };
  });
}

function toTimestamp(dateString: string): UTCTimestamp {
  return (Date.parse(`${dateString}T00:00:00Z`) / 1000) as UTCTimestamp;
}

function niceNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function niceVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

type HoverInfo = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  sma44: number | null;
  sma200: number | null;
};

// ---------- Drawing tools ----------

type DrawTool = "cursor" | "trendline" | "ray" | "fib" | "rect";
type DrawPoint = { time: UTCTimestamp; price: number };
type Drawing = { id: string; type: Exclude<DrawTool, "cursor">; points: DrawPoint[] };

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#6f7d91", "#7cc7ff", "#4fdba3", "#e9a84a", "#e66f6a", "#c98be8", "#6f7d91"];

let drawingIdCounter = 0;
function newDrawingId() {
  drawingIdCounter += 1;
  return `d${Date.now()}-${drawingIdCounter}`;
}

const TOOLS: { id: DrawTool; label: string; hint: string }[] = [
  { id: "cursor", label: "Select", hint: "Pan & zoom" },
  { id: "trendline", label: "Trendline", hint: "Click and drag" },
  { id: "ray", label: "Ray", hint: "Click once" },
  { id: "fib", label: "Fibonacci", hint: "Click and drag" },
  { id: "rect", label: "Rectangle", hint: "Click and drag" },
];

export default function StockChart({
  candles,
  sr,
  patterns = [],
  timeframe = "DAILY",
}: {
  candles: Candle[];
  sr: any;
  patterns?: Pattern[];
  timeframe?: Timeframe;
}) {
  const safeCandles = Array.isArray(candles) ? candles : [];
  const safePatterns = Array.isArray(patterns) ? patterns : [];

  const displayCandles = useMemo(
    () => withMovingAverages(aggregateCandles(safeCandles, timeframe)),
    [candles, timeframe]
  );

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const sma44SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const sma200SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const srPriceLineRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null>(null);

  const [hover, setHover] = useState<HoverInfo | null>(null);

  const [tool, setTool] = useState<DrawTool>("cursor");
  const toolRef = useRef<DrawTool>("cursor");
  toolRef.current = tool;

  const drawingsRef = useRef<Drawing[]>([]);
  const draftRef = useRef<Drawing | null>(null);
  const draggingRef = useRef(false);
  const [drawingCount, setDrawingCount] = useState(0);

  const redrawRef = useRef<() => void>(() => {});

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "#0a111c" },
        textColor: "#8b98aa",
        fontSize: 11,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "#141f2e" },
        horzLines: { color: "#141f2e" },
      },
      rightPriceScale: { borderColor: "#1d2b3d" },
      timeScale: { borderColor: "#1d2b3d", timeVisible: false, rightOffset: 4 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3a4c66", labelBackgroundColor: "#243247" },
        horzLine: { color: "#3a4c66", labelBackgroundColor: "#243247" },
      },
      autoSize: true,
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#2fc98c",
      downColor: "#e66f6a",
      borderUpColor: "#2fc98c",
      borderDownColor: "#e66f6a",
      wickUpColor: "#2fc98c",
      wickDownColor: "#e66f6a",
    });

    const sma44Series = chart.addLineSeries({
      color: "#e9a84a",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const sma200Series = chart.addLineSeries({
      color: "#6e9fe3",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      borderVisible: false,
    });

    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      if (!param.time || !param.seriesData.size) {
        setHover(null);
        return;
      }
      const candleData: any = param.seriesData.get(candleSeries);
      if (!candleData) {
        setHover(null);
        return;
      }
      const smaData: any = param.seriesData.get(sma44Series);
      const sma200Data: any = param.seriesData.get(sma200Series);
      const volData: any = param.seriesData.get(volumeSeries);
      setHover({
        time: String(param.time),
        open: candleData.open,
        high: candleData.high,
        low: candleData.low,
        close: candleData.close,
        volume: volData?.value ?? null,
        sma44: smaData?.value ?? null,
        sma200: sma200Data?.value ?? null,
      });
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    sma44SeriesRef.current = sma44Series;
    sma200SeriesRef.current = sma200Series;
    volumeSeriesRef.current = volumeSeries;

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => redrawRef.current());

    const resizeObserver = new ResizeObserver(() => redrawRef.current());
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      sma44SeriesRef.current = null;
      sma200SeriesRef.current = null;
      volumeSeriesRef.current = null;
      srPriceLineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push data / markers / price line whenever candles, timeframe or S/R change.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const sma44Series = sma44SeriesRef.current;
    const sma200Series = sma200SeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !sma44Series || !sma200Series || !volumeSeries) return;

    // New data invalidates any drawings made on the previous coordinate space.
    drawingsRef.current = [];
    draftRef.current = null;
    setDrawingCount(0);
    setTool("cursor");

    if (displayCandles.length === 0) {
      candleSeries.setData([]);
      sma44Series.setData([]);
      sma200Series.setData([]);
      volumeSeries.setData([]);
      setHover(null);
      return;
    }

    const ohlc = displayCandles.map(c => ({
      time: toTimestamp(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const sma44Line = displayCandles
      .filter(c => c.sma44 != null)
      .map(c => ({ time: toTimestamp(c.time), value: c.sma44 as number }));

    const sma200Line = displayCandles
      .filter(c => c.sma200 != null)
      .map(c => ({ time: toTimestamp(c.time), value: c.sma200 as number }));

    const volumeData = displayCandles.map(c => ({
      time: toTimestamp(c.time),
      value: Number.isFinite(c.volume as number) ? (c.volume as number) : 0,
      color: c.close >= c.open ? "rgba(47,201,140,0.5)" : "rgba(230,111,106,0.5)",
    }));

    candleSeries.setData(ohlc);
    sma44Series.setData(sma44Line);
    sma200Series.setData(sma200Line);
    volumeSeries.setData(volumeData);

    if (timeframe === "DAILY" && safePatterns.length > 0) {
      const byDate = new Map(safePatterns.map(p => [p.date, p]));
      const markers = displayCandles
        .filter(c => byDate.has(c.time))
        .map(c => {
          const p = byDate.get(c.time)!;
          return {
            time: toTimestamp(c.time),
            position: "belowBar" as const,
            color: "#7cc7ff",
            shape: "circle" as const,
            text: p.name,
          };
        });
      candleSeries.setMarkers(markers);
    } else {
      candleSeries.setMarkers([]);
    }

    // S/R is rendered as a zone by the canvas overlay below, so no single price line is created.
    if (srPriceLineRef.current) {
      candleSeries.removePriceLine(srPriceLineRef.current);
      srPriceLineRef.current = null;
    }

    chart.timeScale().fitContent();
    setHover(null);
    redrawRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayCandles, sr, safePatterns, timeframe]);

  // ---------- Canvas drawing overlay ----------

  useEffect(() => {
    redrawRef.current = () => {
      const canvas = canvasRef.current;
      const chart = chartRef.current;
      const candleSeries = candleSeriesRef.current;
      if (!canvas || !chart || !candleSeries) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const timeScale = chart.timeScale();
      const xOf = (t: UTCTimestamp) => timeScale.timeToCoordinate(t as unknown as Time);
      const yOf = (p: number) => candleSeries.priceToCoordinate(p);

      // Draw the detected support/resistance as a zone instead of a single line.
      if (sr && Number.isFinite(Number(sr.zone_low ?? sr.level)) && Number.isFinite(Number(sr.zone_high ?? sr.level))) {
        const low = Number(sr.zone_low ?? sr.level);
        const high = Number(sr.zone_high ?? sr.level);
        const yLow = yOf(low);
        const yHigh = yOf(high);
        if (yLow != null && yHigh != null) {
          const top = Math.min(yLow, yHigh);
          const bottom = Math.max(yLow, yHigh);
          ctx.save();
          ctx.fillStyle = sr.type === "SUPPORT" ? "rgba(110,159,227,0.12)" : "rgba(233,168,74,0.12)";
          ctx.strokeStyle = sr.type === "SUPPORT" ? "rgba(110,159,227,0.55)" : "rgba(233,168,74,0.55)";
          ctx.lineWidth = 1;
          ctx.fillRect(0, top, cssW, Math.max(2, bottom - top));
          ctx.strokeRect(0, top, cssW, Math.max(2, bottom - top));
          ctx.fillStyle = sr.type === "SUPPORT" ? "#8fb8ed" : "#e4b76f";
          ctx.font = "10px Inter, sans-serif";
          ctx.fillText(`${String(sr.type || "LEVEL")} ZONE  ₹${low.toFixed(2)}–₹${high.toFixed(2)}`, 8, Math.max(12, top - 5));
          ctx.restore();
        }
      }

      const items = draftRef.current ? [...drawingsRef.current, draftRef.current] : drawingsRef.current;

      for (const d of items) {
        drawShape(ctx, d, xOf, yOf, cssW);
      }
    };
  });

  useEffect(() => {
    redrawRef.current();
  }, [drawingCount]);

  function getCanvasPoint(e: React.PointerEvent<HTMLCanvasElement>): DrawPoint | null {
    const canvas = canvasRef.current;
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!canvas || !chart || !candleSeries) return null;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = chart.timeScale().coordinateToTime(x);
    const price = candleSeries.coordinateToPrice(y);
    if (time == null || price == null) return null;
    return { time: time as unknown as UTCTimestamp, price };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const activeTool = toolRef.current;
    if (activeTool === "cursor") return;

    e.preventDefault();
    const point = getCanvasPoint(e);
    if (!point) return;

    if (activeTool === "ray") {
      drawingsRef.current.push({ id: newDrawingId(), type: "ray", points: [point] });
      setDrawingCount(drawingsRef.current.length);
      redrawRef.current();
      setTool("cursor");
      return;
    }

    draftRef.current = { id: "draft", type: activeTool, points: [point, point] };
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    redrawRef.current();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!draggingRef.current || !draftRef.current) return;
    e.preventDefault();
    const point = getCanvasPoint(e);
    if (!point) return;
    draftRef.current.points[1] = point;
    redrawRef.current();
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!draggingRef.current || !draftRef.current) return;
    e.preventDefault();
    draggingRef.current = false;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}

    const draft = draftRef.current;
    draftRef.current = null;
    const [a, b] = draft.points;
    const moved = a.time !== b.time || Math.abs(a.price - b.price) > 1e-9;
    if (moved) {
      drawingsRef.current.push({ ...draft, id: newDrawingId() });
    }
    setDrawingCount(drawingsRef.current.length);
    redrawRef.current();
    setTool("cursor");
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    draggingRef.current = false;
    draftRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}
    redrawRef.current();
  }

  function undoLast() {
    drawingsRef.current = drawingsRef.current.slice(0, -1);
    setDrawingCount(drawingsRef.current.length);
    redrawRef.current();
  }

  function clearAll() {
    drawingsRef.current = [];
    setDrawingCount(0);
    redrawRef.current();
  }

  if (displayCandles.length === 0) {
    return (
      <div className="chart-shell">
        {sr && <div className="sr-banner"><strong>{String(sr.type || "level")} zone</strong><span>₹{Number(sr.zone_low ?? sr.level).toFixed(2)}–₹{Number(sr.zone_high ?? sr.level).toFixed(2)}</span></div>}
        <div className="chart-timeframe-note"><strong>{timeframe === "DAILY" ? "Daily" : timeframe === "WEEKLY" ? "Weekly" : "Monthly"} candles</strong><span>No chart data returned by the backend.</span></div>
        <div className="loading-card">No OHLC candles available for this stock.</div>
      </div>
    );
  }

  const latest = displayCandles[displayCandles.length - 1];
  const shown = hover ?? {
    time: latest.time,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: latest.close,
    volume: latest.volume,
    sma44: latest.sma44,
    sma200: latest.sma200,
  };
  const shownRising = shown.close >= shown.open;

  return (
    <div className="chart-shell">
      {sr && Number.isFinite(Number(sr.level)) && (
        <div className="sr-banner">
          <strong>{sr.nearing_breakout ? "🔥 Near breakout" : `Nearest ${String(sr.type || "level").toLowerCase()}`}</strong>
          <span>₹{Number(sr.zone_low ?? sr.level).toFixed(2)}–₹{Number(sr.zone_high ?? sr.level).toFixed(2)} · {Number(sr.distance_pct ?? 0).toFixed(2)}% from zone · {Number(sr.touches ?? 0)} touches</span>
        </div>
      )}

      <div className="chart-timeframe-note">
        <strong>{timeframe === "DAILY" ? "Daily" : timeframe === "WEEKLY" ? "Weekly" : "Monthly"} candles</strong>
        <span>Scroll to zoom · drag to pan · hover for OHLC</span>
      </div>

      <div className="chart-toolbar">
        <div className="tool-buttons">
          {TOOLS.map(t => (
            <button
              key={t.id}
              className={`tool-btn ${tool === t.id ? "active" : ""}`}
              title={t.hint}
              onClick={() => setTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="tool-actions">
          <span className="tool-count">{drawingCount} drawing{drawingCount === 1 ? "" : "s"}</span>
          <button className="tool-btn ghost" onClick={undoLast} disabled={drawingCount === 0}>Undo</button>
          <button className="tool-btn ghost" onClick={clearAll} disabled={drawingCount === 0}>Clear</button>
        </div>
      </div>

      <div className="chart-hud">
        <span className="chart-hud-date">{shown.time}</span>
        <span className={`chart-hud-ohlc ${shownRising ? "up" : "down"}`}>
          O <strong>{niceNumber(shown.open)}</strong>
          H <strong>{niceNumber(shown.high)}</strong>
          L <strong>{niceNumber(shown.low)}</strong>
          C <strong>{niceNumber(shown.close)}</strong>
          Vol <strong>{niceVolume(shown.volume)}</strong>
        </span>
        <span className="chart-hud-sma">
          <span className="dot sma44" /> SMA44 <strong>{niceNumber(shown.sma44)}</strong>
          <span className="dot sma200" /> SMA200 <strong>{niceNumber(shown.sma200)}</strong>
        </span>
      </div>

      <div className="chart" ref={wrapperRef} style={{ width: "100%", height: 520, position: "relative" }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            zIndex: 20,
            background: "transparent",
            pointerEvents: tool === "cursor" ? "none" : "auto",
            cursor: tool === "cursor" ? "default" : "crosshair",
            touchAction: "none",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
      </div>

      <div className="chart-legend">
        <span>▰ Price</span>&nbsp;&nbsp; <span style={{ color: "#e9a84a" }}>— SMA44</span>&nbsp;&nbsp; <span style={{ color: "#6e9fe3" }}>— SMA200</span>&nbsp;&nbsp; <span>▮ Volume</span>
        {timeframe === "DAILY" && safePatterns.length > 0 && <span> · ● {safePatterns.map(p => p.name).join(", ")}</span>}
      </div>
    </div>
  );
}

// ---------- Canvas rendering for each drawing type ----------

function drawShape(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  xOf: (t: UTCTimestamp) => number | null,
  yOf: (p: number) => number | null,
  cssW: number
) {
  const [p0, p1] = d.points;
  if (!p0) return;
  const x0 = xOf(p0.time);
  const y0 = yOf(p0.price);
  if (x0 == null || y0 == null) return;

  if (d.type === "ray") {
    ctx.save();
    ctx.strokeStyle = "#b88a42";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(cssW, y0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#d6a85d";
    ctx.font = "10px Inter, sans-serif";
    ctx.fillText(`₹${p0.price.toFixed(2)}`, x0 + 6, y0 - 6);
    ctx.restore();
    return;
  }

  if (!p1) return;
  const x1 = xOf(p1.time);
  const y1 = yOf(p1.price);
  if (x1 == null || y1 == null) return;

  if (d.type === "trendline") {
    ctx.save();
    ctx.strokeStyle = "#7cc7ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.fillStyle = "#7cc7ff";
    [[x0, y0], [x1, y1]].forEach(([cx, cy]) => {
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
    return;
  }

  if (d.type === "rect") {
    ctx.save();
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    ctx.fillStyle = "rgba(124,199,255,0.12)";
    ctx.strokeStyle = "#7cc7ff";
    ctx.lineWidth = 1.5;
    ctx.fillRect(left, top, w, h);
    ctx.strokeRect(left, top, w, h);
    ctx.restore();
    return;
  }

  if (d.type === "fib") {
    ctx.save();
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    ctx.font = "10px Inter, sans-serif";
    FIB_LEVELS.forEach((level, i) => {
      const price = p0.price + (p1.price - p0.price) * level;
      const y = yOf(price);
      if (y == null) return;
      ctx.strokeStyle = FIB_COLORS[i];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = FIB_COLORS[i];
      ctx.fillText(`${(level * 100).toFixed(1)}%  ₹${price.toFixed(2)}`, right + 6, y + 3);
    });
    ctx.restore();
  }
}
