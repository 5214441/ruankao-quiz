(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const FUTURES_BASES = [
    "https://fapi.binance.com",
    "https://fapi1.binance.com",
    "https://fapi2.binance.com",
    "https://fapi3.binance.com"
  ];
  const SYMBOL = "BTCUSDT";
  const MATRIX_INTERVALS = ["1m", "5m", "15m", "1h", "4h"];
  const STORAGE = {
    settings: "btcRadarSettingsV11",
    alerts: "btcRadarAlertsV11",
    snapshots: "btcRadarSnapshotsV11",
    events: "btcRadarEventsV11"
  };

  const state = {
    interval: "5m",
    candles: [],
    indicators: null,
    ticker: {},
    mark: {},
    derivatives: {},
    matrix: {},
    liquidations: [],
    trades: [],
    ws: null,
    reconnectTimer: null,
    restBase: FUTURES_BASES[0],
    lastPrice: null,
    lastVoiceAt: 0,
    replay: false,
    replayIndex: null,
    replayTimer: null,
    alerts: loadJSON(STORAGE.alerts, []),
    snapshots: loadJSON(STORAGE.snapshots, []),
    events: loadJSON(STORAGE.events, []),
    settings: Object.assign({
      voiceEnabled: false,
      voiceStep: 500,
      voiceCooldown: 60,
      voiceStyle: "amount"
    }, loadJSON(STORAGE.settings, {})),
    ready: false
  };

  function loadJSON(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add("hidden"), 2200);
  }

  function fmtPrice(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : "--";
  }

  function fmtPercent(value, digits = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%` : "--";
  }

  function fmtCompact(value, suffix = "") {
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    const abs = Math.abs(n);
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B${suffix}`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M${suffix}`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K${suffix}`;
    return `${n.toFixed(2)}${suffix}`;
  }

  function formatTime(timestamp, withDate = false) {
    if (!timestamp) return "--";
    const d = new Date(Number(timestamp));
    return d.toLocaleString("zh-CN", withDate
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function setSigned(el, value, digits = 2, suffix = "%") {
    const n = Number(value);
    el.textContent = Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(digits)}${suffix}` : "--";
    el.classList.toggle("positive", n > 0);
    el.classList.toggle("negative", n < 0);
  }

  async function fetchJSON(path) {
    let lastError;
    const ordered = [state.restBase, ...FUTURES_BASES.filter(x => x !== state.restBase)];
    for (const base of ordered) {
      try {
        const response = await fetch(`${base}${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = await response.json();
        state.restBase = base;
        return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("公开行情接口暂不可用");
  }

  function mapKlines(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
      quoteVolume: Number(row[7]),
      trades: Number(row[8]),
      takerBuyVolume: Number(row[9]),
      takerBuyQuote: Number(row[10])
    })).filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite));
  }

  function ema(values, period) {
    const output = new Array(values.length).fill(null);
    if (values.length < period) return output;
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    output[period - 1] = seed / period;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      output[i] = values[i] * k + output[i - 1] * (1 - k);
    }
    return output;
  }

  function rsi(values, period = 14) {
    const output = new Array(values.length).fill(null);
    if (values.length <= period) return output;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    output[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      const up = Math.max(diff, 0);
      const down = Math.max(-diff, 0);
      avgGain = (avgGain * (period - 1) + up) / period;
      avgLoss = (avgLoss * (period - 1) + down) / period;
      output[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return output;
  }

  function macd(values) {
    const fast = ema(values, 12);
    const slow = ema(values, 26);
    const line = values.map((_, i) => fast[i] == null || slow[i] == null ? null : fast[i] - slow[i]);
    const validStart = line.findIndex(v => v != null);
    const signal = new Array(values.length).fill(null);
    if (validStart >= 0) {
      const tail = line.slice(validStart).map(v => v == null ? 0 : v);
      const tailSignal = ema(tail, 9);
      tailSignal.forEach((v, index) => { signal[index + validStart] = v; });
    }
    const histogram = line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]);
    return { line, signal, histogram };
  }

  function atr(candles, period = 14) {
    const tr = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const prev = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    });
    return ema(tr, period);
  }

  function calculateIndicators(candles) {
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const ema20 = ema(closes, 20);
    const ema60 = ema(closes, 60);
    const rsi14 = rsi(closes, 14);
    const macdData = macd(closes);
    const atr14 = atr(candles, 14);
    const avgVolume20 = ema(volumes, 20);
    return { closes, ema20, ema60, rsi14, macd: macdData, atr14, avgVolume20 };
  }

  function latestValue(list, index = list.length - 1) {
    for (let i = Math.min(index, list.length - 1); i >= 0; i--) {
      if (list[i] != null && Number.isFinite(Number(list[i]))) return Number(list[i]);
    }
    return null;
  }

  function trendFrom(candles, indicators, index = candles.length - 1) {
    if (!candles.length || !indicators) return { label: "等待数据", className: "neutral", score: 0 };
    const c = candles[index];
    const e20 = latestValue(indicators.ema20, index);
    const e60 = latestValue(indicators.ema60, index);
    const r = latestValue(indicators.rsi14, index);
    const hist = latestValue(indicators.macd.histogram, index);
    const prev20 = latestValue(indicators.ema20, Math.max(0, index - 3));
    let score = 0;
    if (e20 != null) score += c.close > e20 ? 1 : -1;
    if (e20 != null && e60 != null) score += e20 > e60 ? 1 : -1;
    if (e20 != null && prev20 != null) score += e20 > prev20 ? 1 : -1;
    if (r != null) {
      if (r > 55) score += 1;
      else if (r < 45) score -= 1;
    }
    if (hist != null) score += hist > 0 ? 1 : -1;
    if (score >= 3) return { label: "偏强", className: "strong", score };
    if (score <= -3) return { label: "偏弱", className: "weak", score };
    return { label: "震荡", className: "neutral", score };
  }

  function analyzeBreakout(candles, indicators, index = candles.length - 1) {
    if (index < 25) return { title: "数据不足", text: "至少需要25根K线。", tone: "neutral" };
    const current = candles[index];
    const previous = candles[index - 1];
    const lookback = candles.slice(index - 21, index - 1);
    const rangeHigh = Math.max(...lookback.map(c => c.high));
    const rangeLow = Math.min(...lookback.map(c => c.low));
    const avgVol = lookback.reduce((s, c) => s + c.volume, 0) / lookback.length;
    const volRatio = avgVol ? current.volume / avgVol : 0;
    const buffer = (rangeHigh - rangeLow) * 0.0015;

    if (previous.high > rangeHigh + buffer && current.close < rangeHigh) {
      return { title: "疑似上破回落", text: `上一根越过区间上沿 ${fmtPrice(rangeHigh)}，当前重新回到区间内，需警惕假突破。`, tone: "weak" };
    }
    if (previous.low < rangeLow - buffer && current.close > rangeLow) {
      return { title: "疑似下破收回", text: `上一根跌破区间下沿 ${fmtPrice(rangeLow)}，当前重新回到区间内，需观察是否形成诱空。`, tone: "strong" };
    }
    if (current.close > rangeHigh) {
      if (volRatio >= 1.2) return { title: "上破并伴随放量", text: `收盘位于区间上沿上方，当前量比 ${volRatio.toFixed(2)}，结构暂时得到量能配合。`, tone: "strong" };
      return { title: "上破但量能不足", text: `价格越过区间上沿，但当前量比仅 ${volRatio.toFixed(2)}，需要后续K线确认。`, tone: "neutral" };
    }
    if (current.close < rangeLow) {
      if (volRatio >= 1.2) return { title: "下破并伴随放量", text: `收盘位于区间下沿下方，当前量比 ${volRatio.toFixed(2)}，弱势结构暂时得到量能配合。`, tone: "weak" };
      return { title: "下破但量能不足", text: `价格跌破区间下沿，但当前量比仅 ${volRatio.toFixed(2)}，需要后续K线确认。`, tone: "neutral" };
    }
    return { title: "仍在近期区间内", text: `近20根区间约为 ${fmtPrice(rangeLow)}—${fmtPrice(rangeHigh)}，暂未形成有效突破。`, tone: "neutral" };
  }

  function structureText(candles, indicators, index = candles.length - 1) {
    if (!candles.length || !indicators) return { title: "等待K线", text: "数据加载后自动分析。", tone: "neutral" };
    const trend = trendFrom(candles, indicators, index);
    const close = candles[index].close;
    const e20 = latestValue(indicators.ema20, index);
    const e60 = latestValue(indicators.ema60, index);
    const r = latestValue(indicators.rsi14, index);
    const hist = latestValue(indicators.macd.histogram, index);
    const parts = [];
    if (e20 != null) parts.push(`价格${close >= e20 ? "位于" : "低于"}EMA20`);
    if (e20 != null && e60 != null) parts.push(`EMA20${e20 >= e60 ? "高于" : "低于"}EMA60`);
    if (r != null) parts.push(`RSI ${r.toFixed(1)}`);
    if (hist != null) parts.push(`MACD柱${hist >= 0 ? "为正" : "为负"}`);
    return { title: `${state.interval}结构${trend.label}`, text: parts.join("，") + "。", tone: trend.className };
  }

  function applyTone(element, tone) {
    element.classList.remove("positive", "negative");
    if (tone === "strong") element.classList.add("positive");
    if (tone === "weak") element.classList.add("negative");
  }

  async function loadCandles(interval = state.interval, silent = false) {
    if (!silent) {
      $("chartEmpty").classList.remove("hidden");
      $("chartEmpty").textContent = "正在读取行情数据…";
    }
    try {
      const rows = await fetchJSON(`/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=240`);
      const candles = mapKlines(rows);
      if (interval !== state.interval) return candles;
      state.candles = candles;
      state.indicators = calculateIndicators(candles);
      state.ready = true;
      $("chartEmpty").classList.toggle("hidden", candles.length > 0);
      updateIndicatorUI();
      drawChart();
      renderAnalysis();
      renderLevels();
      renderReport();
      evaluateAlerts();
      $("chartSubtitle").textContent = `${intervalLabel(interval)} · 最近${candles.length}根 · 数据源：Binance公开合约行情`;
      return candles;
    } catch (error) {
      $("chartEmpty").textContent = `行情读取失败：${error.message}`;
      setConnection("offline", "接口暂不可用");
      throw error;
    }
  }

  async function loadMatrix() {
    try {
      const results = await Promise.all(MATRIX_INTERVALS.map(async interval => {
        const rows = await fetchJSON(`/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=140`);
        const candles = mapKlines(rows);
        const indicators = calculateIndicators(candles);
        return [interval, { candles, indicators, trend: trendFrom(candles, indicators) }];
      }));
      state.matrix = Object.fromEntries(results);
      renderMatrix();
      renderReport();
      $("matrixUpdated").textContent = `更新 ${formatTime(Date.now())}`;
    } catch (error) {
      $("trendMatrix").innerHTML = `<div class="matrix-loading">多周期数据暂不可用：${escapeHTML(error.message)}</div>`;
    }
  }

  async function loadTickerAndDerivatives() {
    try {
      const [ticker, premium, oi, oiHist, longShort, taker] = await Promise.all([
        fetchJSON(`/fapi/v1/ticker/24hr?symbol=${SYMBOL}`),
        fetchJSON(`/fapi/v1/premiumIndex?symbol=${SYMBOL}`),
        fetchJSON(`/fapi/v1/openInterest?symbol=${SYMBOL}`),
        fetchJSON(`/futures/data/openInterestHist?symbol=${SYMBOL}&period=5m&limit=2`),
        fetchJSON(`/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=5m&limit=1`),
        fetchJSON(`/futures/data/takerlongshortRatio?symbol=${SYMBOL}&period=5m&limit=1`)
      ]);
      state.ticker = ticker || {};
      state.mark = premium || {};
      const oiRows = Array.isArray(oiHist) ? oiHist : [];
      const prevOI = oiRows.length > 1 ? Number(oiRows[oiRows.length - 2].sumOpenInterest) : null;
      const currentHistOI = oiRows.length ? Number(oiRows[oiRows.length - 1].sumOpenInterest) : null;
      const oiChangePct = prevOI && currentHistOI ? (currentHistOI / prevOI - 1) * 100 : null;
      const ls = Array.isArray(longShort) && longShort.length ? longShort[longShort.length - 1] : {};
      const tk = Array.isArray(taker) && taker.length ? taker[taker.length - 1] : {};
      state.derivatives = {
        openInterest: Number(oi?.openInterest),
        oiChangePct,
        longShortRatio: Number(ls.longShortRatio),
        takerBuySellRatio: Number(tk.buySellRatio),
        takerBuyVol: Number(tk.buyVol),
        takerSellVol: Number(tk.sellVol)
      };
      renderTicker();
      renderContract();
      renderLevels();
      renderReport();
      evaluateAlerts();
      $("contractUpdated").textContent = `更新 ${formatTime(Date.now())}`;
    } catch (error) {
      addEvent(`合约快照刷新失败：${error.message}`, "system", false);
    }
  }

  function renderTicker() {
    const price = Number(state.ticker.lastPrice || state.mark.markPrice || state.lastPrice);
    if (Number.isFinite(price)) updatePrice(price, false);
    setSigned($("change24"), Number(state.ticker.priceChangePercent));
    $("high24").textContent = fmtPrice(state.ticker.highPrice);
    $("low24").textContent = fmtPrice(state.ticker.lowPrice);
    $("quoteVolume24").textContent = fmtCompact(Number(state.ticker.quoteVolume), " USDT");
  }

  function renderContract() {
    $("markPrice").textContent = fmtPrice(state.mark.markPrice);
    $("indexPrice").textContent = fmtPrice(state.mark.indexPrice);
    const fundingPct = Number(state.mark.lastFundingRate) * 100;
    setSigned($("fundingRate"), fundingPct, 4, "%");
    $("openInterest").textContent = fmtCompact(state.derivatives.openInterest, " BTC");
    setSigned($("oiChange"), state.derivatives.oiChangePct, 2, "%");
    $("longShortRatio").textContent = Number.isFinite(state.derivatives.longShortRatio)
      ? state.derivatives.longShortRatio.toFixed(3) : "--";
    const total = state.derivatives.takerBuyVol + state.derivatives.takerSellVol;
    const buyPct = total > 0 ? state.derivatives.takerBuyVol / total * 100 : null;
    $("takerBuyRatio").textContent = Number.isFinite(buyPct) ? `${buyPct.toFixed(1)}%` : "--";
    updateFundingCountdown();
  }

  function updateFundingCountdown() {
    const target = Number(state.mark.nextFundingTime);
    if (!Number.isFinite(target)) {
      $("fundingCountdown").textContent = "--";
      return;
    }
    const diff = Math.max(0, target - Date.now());
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    $("fundingCountdown").textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function updateIndicatorUI(index = null) {
    if (!state.indicators || !state.candles.length) return;
    const i = index == null ? state.candles.length - 1 : index;
    const e20 = latestValue(state.indicators.ema20, i);
    const e60 = latestValue(state.indicators.ema60, i);
    const r = latestValue(state.indicators.rsi14, i);
    const hist = latestValue(state.indicators.macd.histogram, i);
    const a = latestValue(state.indicators.atr14, i);
    const avgV = latestValue(state.indicators.avgVolume20, i);
    const vol = state.candles[i]?.volume;
    const ratio = avgV ? vol / avgV : null;
    $("ema20Value").textContent = fmtPrice(e20);
    $("ema60Value").textContent = fmtPrice(e60);
    $("rsiValue").textContent = r == null ? "--" : r.toFixed(1);
    $("macdValue").textContent = hist == null ? "--" : hist.toFixed(1);
    $("atrValue").textContent = fmtPrice(a);
    $("volumeRatio").textContent = ratio == null ? "--" : ratio.toFixed(2);
  }

  function renderMatrix() {
    const labels = { "1m": "1分钟", "5m": "5分钟", "15m": "15分钟", "1h": "1小时", "4h": "4小时" };
    $("trendMatrix").innerHTML = MATRIX_INTERVALS.map(interval => {
      const item = state.matrix[interval];
      if (!item) return "";
      const i = item.candles.length - 1;
      const r = latestValue(item.indicators.rsi14, i);
      const hist = latestValue(item.indicators.macd.histogram, i);
      const e20 = latestValue(item.indicators.ema20, i);
      const e60 = latestValue(item.indicators.ema60, i);
      return `<div class="matrix-card">
        <div class="tf">${labels[interval]}</div>
        <div class="signal ${item.trend.className}">${item.trend.label}</div>
        <div class="metrics">
          <span>EMA：${e20 != null && e60 != null ? (e20 >= e60 ? "20在60上方" : "20在60下方") : "--"}</span>
          <span>RSI：${r == null ? "--" : r.toFixed(1)}</span>
          <span>MACD柱：${hist == null ? "--" : (hist >= 0 ? "正" : "负")}</span>
        </div>
      </div>`;
    }).join("");
  }

  function renderAnalysis(index = null) {
    if (!state.candles.length || !state.indicators) return;
    const i = index == null ? state.candles.length - 1 : index;
    const breakout = analyzeBreakout(state.candles, state.indicators, i);
    $("breakoutTitle").textContent = breakout.title;
    $("breakoutText").textContent = breakout.text;
    applyTone($("breakoutTitle"), breakout.tone);

    const structure = structureText(state.candles, state.indicators, i);
    $("structureTitle").textContent = structure.title;
    $("structureText").textContent = structure.text;
    applyTone($("structureTitle"), structure.tone);

    renderFlow();
  }

  function renderFlow() {
    const cutoff = Date.now() - 60000;
    state.trades = state.trades.filter(t => t.time >= cutoff);
    const buy = state.trades.filter(t => !t.maker).reduce((s, t) => s + t.notional, 0);
    const sell = state.trades.filter(t => t.maker).reduce((s, t) => s + t.notional, 0);
    const total = buy + sell;
    if (!total) {
      $("flowTitle").textContent = "等待实时成交";
      $("flowText").textContent = "统计最近60秒主动买卖成交额。";
      applyTone($("flowTitle"), "neutral");
      return;
    }
    const buyPct = buy / total * 100;
    let title = "买卖较均衡";
    let tone = "neutral";
    if (buyPct >= 58) { title = "主动买入占优"; tone = "strong"; }
    if (buyPct <= 42) { title = "主动卖出占优"; tone = "weak"; }
    $("flowTitle").textContent = `${title} · 买入${buyPct.toFixed(1)}%`;
    $("flowText").textContent = `近60秒主动买入约 ${fmtCompact(buy, " USDT")}，主动卖出约 ${fmtCompact(sell, " USDT")}。`;
    applyTone($("flowTitle"), tone);
  }

  function buildLevels(price) {
    if (!Number.isFinite(price)) return [];
    const rows = [];
    [100, 500, 1000].forEach(step => {
      const lower = Math.floor(price / step) * step;
      const upper = lower + step;
      rows.push({ name: `下方整${step}`, value: lower, type: "整数位" });
      rows.push({ name: `上方整${step}`, value: upper, type: "整数位" });
    });
    if (Number.isFinite(Number(state.ticker.highPrice))) rows.push({ name: "24小时高点", value: Number(state.ticker.highPrice), type: "日内边界" });
    if (Number.isFinite(Number(state.ticker.lowPrice))) rows.push({ name: "24小时低点", value: Number(state.ticker.lowPrice), type: "日内边界" });
    if (state.candles.length >= 21) {
      const range = state.candles.slice(-21, -1);
      rows.push({ name: "近20根高点", value: Math.max(...range.map(c => c.high)), type: "区间边界" });
      rows.push({ name: "近20根低点", value: Math.min(...range.map(c => c.low)), type: "区间边界" });
    }
    const unique = new Map();
    rows.forEach(row => unique.set(`${row.name}-${row.value.toFixed(2)}`, row));
    return [...unique.values()].sort((a, b) => Math.abs(a.value - price) - Math.abs(b.value - price)).slice(0, 9);
  }

  function renderLevels() {
    const price = Number(state.lastPrice || state.ticker.lastPrice || state.mark.markPrice);
    const rows = buildLevels(price);
    if (!rows.length) return;
    $("levelMap").innerHTML = rows.map(row => {
      const distance = (row.value / price - 1) * 100;
      return `<div class="level-item">
        <div><strong>${fmtPrice(row.value)}</strong><span>${escapeHTML(row.name)}</span></div>
        <em>${distance >= 0 ? "+" : ""}${distance.toFixed(2)}%</em>
      </div>`;
    }).join("");
  }

  function renderReport() {
    const price = Number(state.lastPrice || state.ticker.lastPrice || state.mark.markPrice);
    if (!Number.isFinite(price)) return;
    const matrixLabels = MATRIX_INTERVALS.map(tf => {
      const item = state.matrix[tf];
      return item ? `${tf}:${item.trend.label}` : `${tf}:--`;
    }).join("｜");
    const current = state.indicators && state.candles.length
      ? structureText(state.candles, state.indicators).text
      : "当前周期指标待加载。";
    const breakout = state.indicators && state.candles.length
      ? analyzeBreakout(state.candles, state.indicators)
      : { title: "待加载", text: "" };
    const funding = Number(state.mark.lastFundingRate) * 100;
    const oiChange = Number(state.derivatives.oiChangePct);
    const nearest = buildLevels(price).slice(0, 4).map(x => `${x.name}${fmtPrice(x.value)}`).join("，");
    $("dailyReport").textContent =
`BTCUSDT 行情摘要（${new Date().toLocaleString("zh-CN")}）
当前价格：${fmtPrice(price)} USDT，24小时涨跌：${fmtPercent(state.ticker.priceChangePercent)}
多周期结构：${matrixLabels}
当前周期：${current}
突破观察：${breakout.title}。${breakout.text}
合约数据：资金费率${Number.isFinite(funding) ? fmtPercent(funding, 4) : "--"}，持仓量5分钟变化${Number.isFinite(oiChange) ? fmtPercent(oiChange) : "--"}，全市场多空比${Number.isFinite(state.derivatives.longShortRatio) ? state.derivatives.longShortRatio.toFixed(3) : "--"}。
附近价位：${nearest || "--"}。
说明：以上为公开数据的规则化整理，只用于学习、监测和复盘。`;
  }

  function resizeCanvas() {
    const canvas = $("priceChart");
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(320, Math.floor(rect.width * dpr));
    const height = Math.max(280, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { canvas, width, height, dpr };
  }

  function drawChart() {
    if (!state.candles.length || !state.indicators) return;
    const { canvas, width: W, height: H, dpr } = resizeCanvas();
    const ctx = canvas.getContext("2d");
    const styles = getComputedStyle(document.documentElement);
    const color = name => styles.getPropertyValue(name).trim();
    const index = state.replay ? Math.max(60, Number(state.replayIndex || 60)) : state.candles.length - 1;
    const end = Math.min(index + 1, state.candles.length);
    const start = Math.max(0, end - 105);
    const visible = state.candles.slice(start, end);
    if (!visible.length) return;

    ctx.clearRect(0, 0, W, H);
    const padL = 10 * dpr, padR = 74 * dpr, padT = 12 * dpr, padB = 25 * dpr;
    const priceBottom = H * 0.76;
    const volumeTop = H * 0.79;
    const chartW = W - padL - padR;
    const chartH = priceBottom - padT;
    const highs = visible.map(c => c.high);
    const lows = visible.map(c => c.low);
    const e20Visible = state.indicators.ema20.slice(start, end).filter(Number.isFinite);
    const e60Visible = state.indicators.ema60.slice(start, end).filter(Number.isFinite);
    let minPrice = Math.min(...lows, ...e20Visible, ...e60Visible);
    let maxPrice = Math.max(...highs, ...e20Visible, ...e60Visible);
    const margin = (maxPrice - minPrice || maxPrice * 0.01) * 0.08;
    minPrice -= margin; maxPrice += margin;
    const y = value => padT + (maxPrice - value) / (maxPrice - minPrice) * chartH;
    const xStep = chartW / visible.length;
    const x = i => padL + (i + .5) * xStep;

    ctx.strokeStyle = color("--line");
    ctx.fillStyle = color("--muted");
    ctx.lineWidth = 1 * dpr;
    ctx.font = `${10 * dpr}px sans-serif`;
    for (let i = 0; i <= 5; i++) {
      const value = maxPrice - (maxPrice - minPrice) * i / 5;
      const yy = y(value);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillText(fmtPrice(value), W - padR + 7 * dpr, yy + 3 * dpr);
    }

    const levelStep = 1000;
    const firstLevel = Math.ceil(minPrice / levelStep) * levelStep;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = color("--blue");
    ctx.globalAlpha = .38;
    for (let level = firstLevel; level <= maxPrice; level += levelStep) {
      const yy = y(level);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    visible.forEach((c, i) => {
      const xx = x(i);
      const up = c.close >= c.open;
      const candleColor = up ? color("--green") : color("--red");
      ctx.strokeStyle = candleColor;
      ctx.fillStyle = candleColor;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath(); ctx.moveTo(xx, y(c.high)); ctx.lineTo(xx, y(c.low)); ctx.stroke();
      const bodyTop = y(Math.max(c.open, c.close));
      const bodyBottom = y(Math.min(c.open, c.close));
      const bodyH = Math.max(1.5 * dpr, bodyBottom - bodyTop);
      const bodyW = Math.max(2 * dpr, Math.min(xStep * .68, 9 * dpr));
      ctx.fillRect(xx - bodyW / 2, bodyTop, bodyW, bodyH);
    });

    function line(values, stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      let begun = false;
      for (let i = 0; i < visible.length; i++) {
        const value = values[start + i];
        if (!Number.isFinite(value)) continue;
        if (!begun) { ctx.moveTo(x(i), y(value)); begun = true; }
        else ctx.lineTo(x(i), y(value));
      }
      ctx.stroke();
    }
    line(state.indicators.ema20, color("--amber"));
    line(state.indicators.ema60, color("--purple"));

    const maxVol = Math.max(...visible.map(c => c.volume), 1);
    visible.forEach((c, i) => {
      const h = c.volume / maxVol * (H - volumeTop - padB);
      ctx.fillStyle = c.close >= c.open ? color("--green") : color("--red");
      ctx.globalAlpha = .4;
      ctx.fillRect(x(i) - Math.max(1, xStep * .25), H - padB - h, Math.max(2, xStep * .5), h);
    });
    ctx.globalAlpha = 1;

    const labelEvery = Math.max(1, Math.floor(visible.length / 6));
    ctx.fillStyle = color("--muted");
    visible.forEach((c, i) => {
      if (i % labelEvery !== 0 && i !== visible.length - 1) return;
      const label = new Date(c.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      ctx.fillText(label, Math.min(x(i), W - padR - 60 * dpr), H - 7 * dpr);
    });

    const last = visible[visible.length - 1];
    const yy = y(last.close);
    ctx.fillStyle = last.close >= last.open ? color("--green") : color("--red");
    ctx.fillRect(W - padR + 4 * dpr, yy - 9 * dpr, 66 * dpr, 18 * dpr);
    ctx.fillStyle = "#fff";
    ctx.fillText(fmtPrice(last.close), W - padR + 8 * dpr, yy + 4 * dpr);
  }

  function connectWebSocket() {
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
    clearTimeout(state.reconnectTimer);
    const streams = [
      `${SYMBOL.toLowerCase()}@ticker`,
      `${SYMBOL.toLowerCase()}@markPrice@1s`,
      `${SYMBOL.toLowerCase()}@kline_${state.interval}`,
      `${SYMBOL.toLowerCase()}@aggTrade`,
      `${SYMBOL.toLowerCase()}@forceOrder`
    ].join("/");
    const url = `wss://fstream.binance.com/stream?streams=${streams}`;
    setConnection("connecting", "连接中");
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => {
      setConnection("online", "实时连接");
      addEvent("实时行情连接成功", "system", false);
    };
    ws.onmessage = event => {
      try {
        const wrapper = JSON.parse(event.data);
        const data = wrapper.data || wrapper;
        handleStream(data);
      } catch {}
    };
    ws.onerror = () => setConnection("offline", "连接异常");
    ws.onclose = () => {
      setConnection("offline", "正在重连");
      state.reconnectTimer = setTimeout(connectWebSocket, 4000);
    };
  }

  function handleStream(data) {
    switch (data.e) {
      case "24hrTicker":
        state.ticker = Object.assign({}, state.ticker, {
          lastPrice: data.c,
          priceChange: data.p,
          priceChangePercent: data.P,
          highPrice: data.h,
          lowPrice: data.l,
          quoteVolume: data.q,
          volume: data.v,
          closeTime: data.C
        });
        renderTicker();
        break;
      case "markPriceUpdate":
        state.mark = Object.assign({}, state.mark, {
          markPrice: data.p,
          indexPrice: data.i,
          estimatedSettlePrice: data.P,
          lastFundingRate: data.r,
          nextFundingTime: data.T
        });
        renderContract();
        break;
      case "kline":
        updateKline(data.k);
        break;
      case "aggTrade":
        state.trades.push({
          time: Number(data.T || data.E),
          notional: Number(data.p) * Number(data.q),
          maker: Boolean(data.m)
        });
        renderFlow();
        break;
      case "forceOrder":
        addLiquidation(data.o || {});
        break;
    }
  }

  function updateKline(k) {
    if (!k || k.i !== state.interval || state.replay) return;
    const candle = {
      time: Number(k.t), open: Number(k.o), high: Number(k.h), low: Number(k.l),
      close: Number(k.c), volume: Number(k.v), closeTime: Number(k.T),
      quoteVolume: Number(k.q), trades: Number(k.n), takerBuyVolume: Number(k.V),
      takerBuyQuote: Number(k.Q)
    };
    const last = state.candles[state.candles.length - 1];
    if (last && last.time === candle.time) state.candles[state.candles.length - 1] = candle;
    else if (!last || candle.time > last.time) {
      state.candles.push(candle);
      if (state.candles.length > 240) state.candles.shift();
    }
    state.indicators = calculateIndicators(state.candles);
    updatePrice(candle.close, true);
    updateIndicatorUI();
    drawChart();
    renderAnalysis();
    renderLevels();
    renderReport();
    evaluateAlerts();
  }

  function updatePrice(price, fromStream) {
    const n = Number(price);
    if (!Number.isFinite(n)) return;
    const previous = state.lastPrice;
    state.lastPrice = n;
    $("mainPrice").textContent = `$${fmtPrice(n)}`;
    $("dataTime").textContent = `更新 ${formatTime(Date.now())}`;
    if (previous != null) {
      const diff = n - previous;
      $("priceMove").textContent = `${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff).toFixed(1)} USDT`;
      $("priceMove").classList.toggle("positive", diff > 0);
      $("priceMove").classList.toggle("negative", diff < 0);
      if (fromStream) checkIntegerVoice(previous, n);
    }
  }

  function addLiquidation(order) {
    const price = Number(order.ap || order.p);
    const qty = Number(order.q || order.z);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
    const side = order.S === "SELL" ? "long" : "short";
    const item = {
      id: `${order.T || Date.now()}-${price}-${qty}`,
      time: Number(order.T || Date.now()),
      price, qty, notional: price * qty, side
    };
    state.liquidations.unshift(item);
    state.liquidations = state.liquidations.slice(0, 30);
    renderLiquidations();
    if (item.notional >= 1000000) {
      addEvent(`${side === "long" ? "多单" : "空单"}大额强平 ${fmtCompact(item.notional, " USDT")}`, "liquidation");
    }
  }

  function renderLiquidations() {
    $("liqCount").textContent = `${state.liquidations.length}条`;
    if (!state.liquidations.length) return;
    $("liquidationFeed").innerHTML = state.liquidations.map(item => `
      <div class="liq-item">
        <span class="liq-side ${item.side}">${item.side === "long" ? "多单强平" : "空单强平"}</span>
        <div class="liq-main"><strong>${fmtCompact(item.notional, " USDT")}</strong><span>${fmtPrice(item.price)} × ${item.qty.toFixed(3)} BTC</span></div>
        <span class="liq-time">${formatTime(item.time)}</span>
      </div>`).join("");
  }

  function setConnection(type, text) {
    const badge = $("connectionBadge");
    badge.className = `status ${type}`;
    badge.innerHTML = `<i></i>${escapeHTML(text)}`;
  }

  function integerSpeech(price, direction, step) {
    const formatted = state.settings.voiceStyle === "digits"
      ? String(Math.round(price)).split("").map(d => "零一二三四五六七八九"[Number(d)]).join("")
      : toChineseNumber(Math.round(price));
    return `比特币${direction === "up" ? "向上突破" : "向下跌破"}${formatted}美元，当前价格${state.settings.voiceStyle === "digits" ? String(Math.round(state.lastPrice)).split("").map(d => "零一二三四五六七八九"[Number(d)]).join("") : toChineseNumber(Math.round(state.lastPrice))}美元。`;
  }

  function checkIntegerVoice(previous, current) {
    if (!state.settings.voiceEnabled) return;
    const step = Number(state.settings.voiceStep) || 500;
    const prevBucket = Math.floor(previous / step);
    const currentBucket = Math.floor(current / step);
    if (prevBucket === currentBucket) return;
    const now = Date.now();
    if (now - state.lastVoiceAt < Number(state.settings.voiceCooldown) * 1000) return;
    state.lastVoiceAt = now;
    const direction = current > previous ? "up" : "down";
    const crossed = direction === "up" ? currentBucket * step : prevBucket * step;
    const message = integerSpeech(crossed, direction, step);
    speak(message);
    addEvent(message, "voice");
  }

  function toChineseNumber(number) {
    const n = Math.max(0, Math.floor(Number(number)));
    if (!Number.isFinite(n)) return "";
    if (n === 0) return "零";
    const digits = "零一二三四五六七八九";
    const units = ["", "十", "百", "千"];
    const bigUnits = ["", "万", "亿", "兆"];
    const groups = [];
    let temp = n;
    while (temp > 0) {
      groups.push(temp % 10000);
      temp = Math.floor(temp / 10000);
    }
    function groupText(group) {
      let text = "";
      let zeroPending = false;
      for (let i = 3; i >= 0; i--) {
        const base = 10 ** i;
        const digit = Math.floor(group / base) % 10;
        if (digit === 0) {
          if (text) zeroPending = true;
        } else {
          if (zeroPending) { text += "零"; zeroPending = false; }
          text += digits[digit] + units[i];
        }
      }
      return text;
    }
    let result = "";
    let needZero = false;
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (group === 0) {
        if (result) needZero = true;
        continue;
      }
      if (result && (needZero || group < 1000)) result += "零";
      result += groupText(group) + bigUnits[i];
      needZero = false;
    }
    result = result.replace(/^一十/, "十").replace(/零+/g, "零").replace(/零$/g, "");
    return result;
  }

  function speak(text) {
    if (!("speechSynthesis" in window)) {
      toast("当前浏览器不支持语音播报");
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1;
    speechSynthesis.speak(utterance);
  }

  function alertLabel(alert) {
    const labels = {
      price_above: "价格高于",
      price_below: "价格低于",
      rsi_above: "RSI高于",
      rsi_below: "RSI低于",
      funding_abs_above: "资金费率绝对值高于",
      oi_change_abs_above: "持仓量5分钟变化绝对值高于"
    };
    const suffix = alert.type.includes("funding") || alert.type.includes("oi_change") ? "%" : "";
    return `${labels[alert.type] || alert.type} ${alert.value}${suffix}`;
  }

  function getAlertMetric(alert) {
    if (alert.type.startsWith("price")) return Number(state.lastPrice);
    if (alert.type.startsWith("rsi")) return state.indicators ? latestValue(state.indicators.rsi14) : null;
    if (alert.type === "funding_abs_above") return Math.abs(Number(state.mark.lastFundingRate) * 100);
    if (alert.type === "oi_change_abs_above") return Math.abs(Number(state.derivatives.oiChangePct));
    return null;
  }

  function alertMatches(alert, metric) {
    if (!Number.isFinite(metric)) return false;
    if (alert.type.endsWith("_above")) return metric > Number(alert.value);
    if (alert.type.endsWith("_below")) return metric < Number(alert.value);
    return false;
  }

  function evaluateAlerts() {
    const now = Date.now();
    let changed = false;
    state.alerts.forEach(alert => {
      if (!alert.enabled) return;
      const metric = getAlertMetric(alert);
      const match = alertMatches(alert, metric);
      if (!match) {
        alert.armed = true;
        changed = true;
        return;
      }
      if (alert.armed === false) return;
      if (now - Number(alert.lastTriggered || 0) < 300000) return;
      alert.lastTriggered = now;
      alert.armed = false;
      changed = true;
      const message = `BTC提醒：${alertLabel(alert)}，当前值${Number(metric).toFixed(alert.type.startsWith("price") ? 1 : 4)}。`;
      addEvent(message, "alert");
      if (alert.speech) speak(message);
      if (alert.notify) sendNotification("BTC短线行情雷达", message);
    });
    if (changed) saveJSON(STORAGE.alerts, state.alerts);
  }

  async function sendNotification(title, body) {
    if (!("Notification" in window)) {
      toast("浏览器不支持系统通知");
      return;
    }
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body });
  }

  function renderAlerts() {
    if (!state.alerts.length) {
      $("alertList").innerHTML = `<div class="empty-line">还没有自定义提醒</div>`;
      return;
    }
    $("alertList").innerHTML = state.alerts.map(alert => `
      <div class="alert-item">
        <div><strong>${escapeHTML(alertLabel(alert))}</strong><span>${alert.enabled ? "已启用" : "已暂停"} · ${alert.speech ? "语音" : ""}${alert.notify ? " 通知" : ""}</span></div>
        <div class="alert-actions">
          <button class="icon-btn" data-action="toggle-alert" data-id="${alert.id}">${alert.enabled ? "暂停" : "启用"}</button>
          <button class="icon-btn" data-action="delete-alert" data-id="${alert.id}">删除</button>
        </div>
      </div>`).join("");
  }

  function addAlert() {
    const type = $("alertType").value;
    const value = Number($("alertValue").value);
    if (!Number.isFinite(value)) {
      toast("请输入有效数值");
      return;
    }
    state.alerts.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type, value,
      speech: $("alertSpeech").checked,
      notify: $("alertNotify").checked,
      enabled: true,
      armed: true,
      lastTriggered: 0
    });
    state.alerts = state.alerts.slice(0, 30);
    saveJSON(STORAGE.alerts, state.alerts);
    $("alertValue").value = "";
    renderAlerts();
    toast("提醒已添加");
  }

  function saveSnapshot() {
    if (!Number.isFinite(Number(state.lastPrice))) {
      toast("行情尚未加载");
      return;
    }
    const rsiValue = state.indicators ? latestValue(state.indicators.rsi14) : null;
    const macdValue = state.indicators ? latestValue(state.indicators.macd.histogram) : null;
    const snapshot = {
      id: `${Date.now()}`,
      time: Date.now(),
      price: Number(state.lastPrice),
      interval: state.interval,
      rsi: rsiValue,
      macd: macdValue,
      funding: Number(state.mark.lastFundingRate) * 100,
      oiChange: Number(state.derivatives.oiChangePct),
      note: $("snapshotNote").value.trim()
    };
    state.snapshots.unshift(snapshot);
    state.snapshots = state.snapshots.slice(0, 50);
    saveJSON(STORAGE.snapshots, state.snapshots);
    $("snapshotNote").value = "";
    renderSnapshots();
    toast("行情快照已保存");
  }

  function renderSnapshots() {
    if (!state.snapshots.length) {
      $("snapshotList").innerHTML = `<div class="empty-line">还没有保存快照</div>`;
      return;
    }
    $("snapshotList").innerHTML = state.snapshots.slice(0, 8).map(s => `
      <div class="snapshot-item">
        <strong>${fmtPrice(s.price)} · ${escapeHTML(s.interval)}</strong>
        <span>${formatTime(s.time, true)} · RSI ${s.rsi == null ? "--" : Number(s.rsi).toFixed(1)} · 资金费率 ${Number.isFinite(s.funding) ? fmtPercent(s.funding, 4) : "--"}</span>
        ${s.note ? `<span>${escapeHTML(s.note)}</span>` : ""}
        <button class="icon-btn" data-action="delete-snapshot" data-id="${s.id}">删除</button>
      </div>`).join("");
  }

  function addEvent(message, type = "system", persist = true) {
    if (persist) {
      state.events.unshift({ id: `${Date.now()}-${Math.random()}`, time: Date.now(), message, type });
      state.events = state.events.slice(0, 50);
      saveJSON(STORAGE.events, state.events);
      renderEvents();
    }
  }

  function renderEvents() {
    if (!state.events.length) {
      $("eventLog").innerHTML = `<div class="empty-line">暂无触发记录</div>`;
      return;
    }
    $("eventLog").innerHTML = state.events.map(event => `
      <div class="event-item"><strong>${escapeHTML(event.message)}</strong><span>${formatTime(event.time, true)}</span></div>`).join("");
  }

  function enterReplay() {
    if (state.candles.length < 80) {
      toast("K线数量不足，稍后再试");
      return;
    }
    state.replay = true;
    state.replayIndex = Math.min(120, state.candles.length - 1);
    $("replayControls").classList.remove("hidden");
    $("replayToggle").classList.add("hidden");
    $("replaySlider").max = String(state.candles.length - 1);
    $("replaySlider").value = String(state.replayIndex);
    updateReplay();
  }

  function updateReplay() {
    if (!state.replay) return;
    state.replayIndex = Number($("replaySlider").value);
    const candle = state.candles[state.replayIndex];
    $("replayTime").textContent = formatTime(candle.time, true);
    $("mainPrice").textContent = `$${fmtPrice(candle.close)}`;
    $("priceMove").textContent = "历史回放模式";
    $("dataTime").textContent = `第${state.replayIndex + 1}根 / ${state.candles.length}根`;
    updateIndicatorUI(state.replayIndex);
    renderAnalysis(state.replayIndex);
    drawChart();
  }

  function exitReplay() {
    clearInterval(state.replayTimer);
    state.replayTimer = null;
    state.replay = false;
    state.replayIndex = null;
    $("replayControls").classList.add("hidden");
    $("replayToggle").classList.remove("hidden");
    $("replayPlay").textContent = "播放";
    updatePrice(Number(state.ticker.lastPrice || state.mark.markPrice || state.candles.at(-1)?.close), false);
    updateIndicatorUI();
    renderAnalysis();
    drawChart();
  }

  function toggleReplayPlay() {
    if (state.replayTimer) {
      clearInterval(state.replayTimer);
      state.replayTimer = null;
      $("replayPlay").textContent = "播放";
      return;
    }
    $("replayPlay").textContent = "暂停";
    state.replayTimer = setInterval(() => {
      let next = Number($("replaySlider").value) + 1;
      if (next >= state.candles.length) {
        clearInterval(state.replayTimer);
        state.replayTimer = null;
        $("replayPlay").textContent = "播放";
        return;
      }
      $("replaySlider").value = String(next);
      updateReplay();
    }, 700);
  }

  function intervalLabel(interval) {
    return ({ "1m": "1分钟", "5m": "5分钟", "15m": "15分钟", "1h": "1小时", "4h": "4小时" })[interval] || interval;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function bindEvents() {
    $("refreshBtn").addEventListener("click", async () => {
      $("refreshBtn").disabled = true;
      try {
        await Promise.all([loadCandles(), loadMatrix(), loadTickerAndDerivatives()]);
        toast("数据已刷新");
      } finally {
        $("refreshBtn").disabled = false;
      }
    });

    $("themeBtn").addEventListener("click", () => {
      const light = document.documentElement.dataset.theme === "light";
      if (light) {
        delete document.documentElement.dataset.theme;
        localStorage.setItem("btcRadarTheme", "dark");
        $("themeBtn").textContent = "切换浅色";
      } else {
        document.documentElement.dataset.theme = "light";
        localStorage.setItem("btcRadarTheme", "light");
        $("themeBtn").textContent = "切换深色";
      }
      drawChart();
    });

    $("intervalTabs").addEventListener("click", async event => {
      const button = event.target.closest("button[data-interval]");
      if (!button || button.dataset.interval === state.interval) return;
      exitReplay();
      state.interval = button.dataset.interval;
      document.querySelectorAll("#intervalTabs button").forEach(b => b.classList.toggle("active", b === button));
      await loadCandles(state.interval);
      connectWebSocket();
    });

    $("voiceEnabled").addEventListener("change", event => {
      state.settings.voiceEnabled = event.target.checked;
      saveJSON(STORAGE.settings, state.settings);
      toast(event.target.checked ? "整数价位语音已开启" : "整数价位语音已关闭");
    });
    $("voiceStep").addEventListener("change", event => {
      state.settings.voiceStep = Number(event.target.value);
      saveJSON(STORAGE.settings, state.settings);
    });
    $("voiceCooldown").addEventListener("change", event => {
      state.settings.voiceCooldown = Number(event.target.value);
      saveJSON(STORAGE.settings, state.settings);
    });
    $("voiceStyle").addEventListener("change", event => {
      state.settings.voiceStyle = event.target.value;
      saveJSON(STORAGE.settings, state.settings);
    });
    $("voiceTestBtn").addEventListener("click", () => {
      const price = Number(state.lastPrice || 100000);
      speak(`比特币行情雷达语音测试成功，当前示例价格${state.settings.voiceStyle === "digits" ? String(Math.round(price)).split("").map(d => "零一二三四五六七八九"[Number(d)]).join("") : toChineseNumber(Math.round(price))}美元。`);
    });

    $("addAlertBtn").addEventListener("click", addAlert);
    $("alertList").addEventListener("click", event => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const index = state.alerts.findIndex(a => a.id === button.dataset.id);
      if (index < 0) return;
      if (button.dataset.action === "delete-alert") state.alerts.splice(index, 1);
      if (button.dataset.action === "toggle-alert") state.alerts[index].enabled = !state.alerts[index].enabled;
      saveJSON(STORAGE.alerts, state.alerts);
      renderAlerts();
    });

    $("saveSnapshotBtn").addEventListener("click", saveSnapshot);
    $("snapshotList").addEventListener("click", event => {
      const button = event.target.closest('button[data-action="delete-snapshot"]');
      if (!button) return;
      state.snapshots = state.snapshots.filter(s => s.id !== button.dataset.id);
      saveJSON(STORAGE.snapshots, state.snapshots);
      renderSnapshots();
    });

    $("clearEventsBtn").addEventListener("click", () => {
      state.events = [];
      saveJSON(STORAGE.events, state.events);
      renderEvents();
      toast("触发记录已清空");
    });

    $("replayToggle").addEventListener("click", enterReplay);
    $("replayExit").addEventListener("click", exitReplay);
    $("replaySlider").addEventListener("input", updateReplay);
    $("replayPlay").addEventListener("click", toggleReplayPlay);

    $("copyReportBtn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("dailyReport").textContent);
        toast("行情摘要已复制");
      } catch {
        toast("复制失败，请长按文字复制");
      }
    });

    window.addEventListener("resize", () => drawChart());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && (!state.ws || state.ws.readyState > 1)) connectWebSocket();
    });
  }

  async function init() {
    const theme = localStorage.getItem("btcRadarTheme");
    if (theme === "light") {
      document.documentElement.dataset.theme = "light";
      $("themeBtn").textContent = "切换深色";
    }
    $("voiceEnabled").checked = Boolean(state.settings.voiceEnabled);
    $("voiceStep").value = String(state.settings.voiceStep);
    $("voiceCooldown").value = String(state.settings.voiceCooldown);
    $("voiceStyle").value = state.settings.voiceStyle;
    renderAlerts();
    renderSnapshots();
    renderEvents();
    bindEvents();
    connectWebSocket();

    await Promise.allSettled([
      loadCandles(state.interval),
      loadMatrix(),
      loadTickerAndDerivatives()
    ]);
    setInterval(updateFundingCountdown, 1000);
    setInterval(loadTickerAndDerivatives, 30000);
    setInterval(loadMatrix, 60000);
    setInterval(renderFlow, 3000);
  }

  init();
})();
