// coin_prescanner_v3.cjs — 100% Coinbase-Native Prescanner (No CryptoCompare)
// ═══════════════════════════════════════════════════════════════════════
// V3 UPGRADE: Drops CryptoCompare entirely. Scans ALL Coinbase coins directly.
//
// WHY V3:
//   - V2 used CryptoCompare's "top 200 by volume" → only 10 coins returned
//   - Missed 25.3% of 10%+ winners (1,235 missed out of 4,885)
//   - Oct 10: 22 winners, caught ZERO. Nov 7: 315 winners, caught 86.
//   - 12 symbols NEVER caught at all (ALGO, BONK, SHIB, etc.)
//   - CryptoCompare ≠ Coinbase. Coins like BNKR, DOGINME, USELESS aren't
//     in CryptoCompare's top 200 but pump hard on Coinbase.
//
// V3 APPROACH:
//   1. fetchAllProducts() → ALL ~350 Coinbase USD pairs (1 API call)
//   2. Batch fetchProductStats() for all with concurrency control (35s)
//   3. Quick-filter by 24h volume ($50K+) and movement (>1% abs change)
//   4. Fetch 4H hourly candles for candidates via Coinbase candles API
//   5. Score with same V2 scoring (4H change, range, volume, momentum)
//   6. Return top 30 (3x more than V2's 10)
//
// PERFORMANCE: ~40-60s total (vs V2's 30-45s). Worth it for 3x coverage.
// ═══════════════════════════════════════════════════════════════════════

const path = require('path');
const coinbaseApi = require(path.resolve(__dirname, 'trade_suggestion_algorithm/Api/coinbaseApi.cjs'));

// ═══════════════════════════════════════════════════════
// STABLECOIN / WRAPPED TOKEN / LARGE CAP EXCLUSION LIST
// ═══════════════════════════════════════════════════════
const EXCLUDED_SYMBOLS = new Set([
    // Stablecoins
    'USDT', 'USDC', 'DAI', 'TUSD', 'BUSD', 'FRAX', 'GUSD', 'HUSD',
    'PAX', 'USDP', 'FDUSD', 'PYUSD', 'EURC', 'GBPT', 'UST',
    // Wrapped versions
    'WETH', 'WBTC', 'WBNB', 'WMATIC', 'WSOL', 'WAXL',
    'CBETH', 'CBBTC', 'STETH', 'RETH', 'MSOL',
    // Fiat-pegged / forex
    'EUR', 'GBP', 'JPY',
    // ─── LARGE CAPS NO LONGER HARDCODED ───
    // The Historical Volatility Gate (Step 3.5) dynamically filters coins
    // that can't move 10%+ based on their ACTUAL 14-day daily ATR%.
    // BTC (~2%), ETH (~2.5%), SOL (~3%), XRP (~2.5%) auto-killed.
    // Future-proof: new low-vol coins don't need manual boycotting.
]);

// Minimum 4H range to be considered — coins under this are too stable
const MIN_4H_RANGE = 2.5; // percent (lowered from V2's 3.0% to catch more)

// ── QUALITY GATES — Kill garbage coins before wasting API calls ──
const MIN_PRICE = 0.0001;            // Min $0.001 — kills sub-penny blocky dust (MOG = $0.0000017 → REJECTED)
const MAX_TICK_PCT = 1.5;           // If 1 tick > 1.5% of price → blocky chart, untradeable
const ENTRY_SIZE_USD = 2000;       // Position size for order book market impact check
const MAX_SLIPPAGE_PCT = 4.0;       // Skip if $10K buy would slip > 3% on the ask side

// ── REAL-TIME CANDLE QUALITY GATES ──
// Checks actual 1-min candles + ticker spread to kill illiquid garbage
const MAX_SPREAD_PCT = 0.5;         // Spread > 0.5% = too expensive to trade (OMNI was 1.65%)
const MIN_ACTIVE_CANDLES = 7;       // Need >= 7/15 candles active (was 10 — too strict for BNKR-type meme coins)
const MIN_MEDIAN_CANDLE_VOL = 200;  // Median per-minute USD volume (OMNI median was $354 but with $4 mins)
const QUALITY_CHECK_MINUTES = 15;   // Check last 15 minutes of 1-min candles
const QUALITY_CONCURRENCY = 5;
const QUALITY_DELAY_MS = 200;

// Concurrency for stats fetching (stay under Coinbase 10 req/sec)
const STATS_CONCURRENCY = 8;
const STATS_DELAY_MS = 120; // ms between batches
const CANDLE_CONCURRENCY = 5;
const CANDLE_DELAY_MS = 200;

// ── HISTORICAL VOLATILITY GATE — "Can This Coin Actually Move 10%?" ──
// Fetches 14 days of daily candles → calculates real volatility metrics.
// Dynamically filters BTC, ETH, SOL, XRP, IP, TAO etc. WITHOUT hardcoding.
//
// V4 UPGRADE: Volume-Scaled ATR Threshold
// Instead of a flat 6% ATR floor, the required ATR SCALES with volume.
// Higher volume = more liquidity = harder to pump 10% = need higher ATR.
//   requiredATR = BASE_ATR_REQ + max(0, log2(vol24h / VOL_SCALE_BASE)) * VOL_SCALE_FACTOR
// Examples:
//   $300K vol → 7% required (small meme coins — BNKR, BREV)
//   $1.7M vol → 9.3% required (IP fails at 8% ATR ❌, SPX passes at 11% ✅)
//   $9M vol  → 13.2% required (EDGE passes at 18.7% ✅)
//   $50M vol → 17% required (DOGE auto-killed at 7.3% ATR)
//   $250M vol → 22% required (SOL auto-killed at 7.1% ATR)
// Plus: "Explosive Day Override" — if best day in 14d was >= 15% range, always pass.
const VOLATILITY_LOOKBACK_DAYS = 14;
const BASE_ATR_REQ = 7.0;                     // Min ATR even for tiny coins — 7% floor
const VOL_SCALE_BASE = 500_000;               // Volume where scaling kicks in
const VOL_SCALE_FACTOR = 1.5;                 // +1.5% ATR required per 2x volume
const EXPLOSIVE_DAY_PCT = 15.0;               // Best day >= 15% → 30% ATR discount (proven pumper)
const EXPLOSIVE_ATR_DISCOUNT = 0.70;          // With explosive day, only need 70% of required ATR
const MIN_BEST_DAY_RANGE_PCT = 10.0;          // Hard floor: must have had at least ONE 10%+ day
const MIN_VOLATILE_DAYS = 2;
const VOLATILE_DAY_THRESHOLD = 5.0;
const MIN_DAILY_CANDLES = 3;
const VOLATILITY_CONCURRENCY = 8;
const VOLATILITY_DELAY_MS = 120;
const MIN_VOLUME_SURGE_RATIO = 0.3;

// ═══════════════════════════════════════════════════════
// HISTORICAL VOLATILITY ANALYZER
// Calculates daily ATR%, max range, volatile days from daily candles
// ═══════════════════════════════════════════════════════
function analyzeVolatility(dailyCandles, vol24hUsd = 0) {
    if (!dailyCandles || dailyCandles.length < MIN_DAILY_CANDLES) {
        return { pass: false, reason: 'insufficient_data', daysAvail: dailyCandles?.length || 0 };
    }
    const sorted = [...dailyCandles].sort((a, b) => new Date(a.time) - new Date(b.time));
    let totalATRPct = 0, maxRangePct = 0, volatileDays = 0;
    let weekHigh = -Infinity, weekLow = Infinity, prevClose = null;

    for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        let tr = c.high - c.low;
        if (prevClose !== null) {
            tr = Math.max(tr, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
        }
        const atrPct = c.close > 0 ? (tr / c.close) * 100 : 0;
        const rangePct = c.close > 0 ? ((c.high - c.low) / c.close) * 100 : 0;
        totalATRPct += atrPct;
        if (rangePct > maxRangePct) maxRangePct = rangePct;
        if (rangePct >= VOLATILE_DAY_THRESHOLD) volatileDays++;
        if (c.high > weekHigh) weekHigh = c.high;
        if (c.low < weekLow) weekLow = c.low;
        prevClose = c.close;
    }

    const avgDailyATRPct = totalATRPct / sorted.length;
    const latestClose = sorted[sorted.length - 1].close;
    const pricePositionPct = (weekHigh > weekLow)
        ? ((latestClose - weekLow) / (weekHigh - weekLow)) * 100 : 50;

    // ── Volume-Scaled ATR Threshold ──
    // Higher volume = deeper market = needs MORE volatility to pump 10%
    const volScaling = vol24hUsd > VOL_SCALE_BASE
        ? Math.log2(vol24hUsd / VOL_SCALE_BASE) * VOL_SCALE_FACTOR
        : 0;
    const rawATRReq = BASE_ATR_REQ + volScaling;

    // Slight leniency for newer coins (< 7 days of data)
    const fullATRReq = sorted.length >= 7 ? rawATRReq : rawATRReq - 1.0;
    const rangeThresh = sorted.length >= 7 ? MIN_BEST_DAY_RANGE_PCT : MIN_BEST_DAY_RANGE_PCT - 2.0;
    const minVolDays = sorted.length >= 7 ? MIN_VOLATILE_DAYS : 1;

    // ── Explosive Day Override ──
    // If the coin had a 15%+ day recently, it's a proven pumper.
    // Instead of fully overriding ATR gate, we give a 30% discount on required ATR.
    // This prevents DOGE (7.4% ATR, needs 17%) from passing while still helping
    // mid-ATR coins like PUMP (9.3%, needs 12.1% → discounted to 8.5%).
    const explosiveDayPass = maxRangePct >= EXPLOSIVE_DAY_PCT;
    const effectiveATRReq = explosiveDayPass ? fullATRReq * EXPLOSIVE_ATR_DISCOUNT : fullATRReq;

    // Pass if: ATR meets (discounted) threshold AND has 10%+ best day AND enough volatile days
    const meetsATR = avgDailyATRPct >= effectiveATRReq;
    const meetsRange = maxRangePct >= rangeThresh;
    const meetsVolDays = volatileDays >= minVolDays;
    const pass = meetsATR && meetsRange && meetsVolDays;

    return {
        pass,
        avgDailyATRPct: Math.round(avgDailyATRPct * 100) / 100,
        maxDailyRangePct: Math.round(maxRangePct * 100) / 100,
        volatileDays,
        weekHigh,
        weekLow,
        pricePositionPct: Math.round(pricePositionPct * 10) / 10,
        daysAnalyzed: sorted.length,
        dynamicATRReq: Math.round(effectiveATRReq * 10) / 10,
        explosiveDayPass,
        reason: !pass ? (
            !meetsATR ? `lowATR(${avgDailyATRPct.toFixed(1)}%<${effectiveATRReq.toFixed(1)}%@$${(vol24hUsd/1e6).toFixed(1)}Mvol${explosiveDayPass?',disc':''})`:
            !meetsRange ? `lowRange(${maxRangePct.toFixed(1)}%<${rangeThresh}%)` :
            `fewVolDays(${volatileDays}<${minVolDays})`
        ) : (explosiveDayPass && avgDailyATRPct < fullATRReq ? 'explosive_discount' : 'ok'),
    };
}

// ═══════════════════════════════════════════════════════
// SCORING SYSTEM V4.0 — Momentum & Volume Surge Priority
// ═══════════════════════════════════════════════════════
// V4.0 UPGRADE: Fixes the "AGLD problem" — coins with decent 4H history
// but ZERO current momentum/volume were scoring nearly the same as real
// movers like FAI/SYND. The fix: redistribute 10pts from historical
// metrics (4H change, 4H range) INTO volume surge (5→15pts), and add
// "stale move" + "momentum fading" penalties for sideways setups.
//
// Old max: 30+20+15+15+10+5+5 = 100
// New max: 25+15+15+15+10+5+15 = 100 (same scale, better differentiation)
//
// Impact example: AGLD (sideways, 0.8x surge) ~65→~48, FAI (pumping, 2x+ surge) ~83→~82
// Gap doubles from 18pts to 34pts — prescanner now properly separates dead from alive.
function calculateMoverScore(stats) {
    const { chg4h, range4h, vol24hUsd, momentumPct, last1hChg, avgDailyATRPct, pricePositionPct, volumeSurgeRatio } = stats;
    let score = 0;

    // ── COMPONENT 1: 4H price change (max 25 pts) — reduced from 30, past change matters less ──
    if (chg4h >= 15) score += 25;
    else if (chg4h >= 10) score += 23;
    else if (chg4h >= 7) score += 21;
    else if (chg4h >= 5) score += 18;
    else if (chg4h >= 3) score += 15;
    else if (chg4h >= 2) score += 12;
    else if (chg4h >= 1) score += 8;
    else if (chg4h >= 0.5) score += 5;
    else if (chg4h >= 0) score += 2;

    // ── COMPONENT 2: 4H range (max 15 pts) — reduced from 20, big range alone ≠ active NOW ──
    if (range4h >= 20) score += 15;
    else if (range4h >= 15) score += 13;
    else if (range4h >= 10) score += 11;
    else if (range4h >= 7) score += 9;
    else if (range4h >= 5) score += 8;
    else if (range4h >= 3) score += 5;
    else if (range4h >= 2.5) score += 3;

    // ── COMPONENT 3: Volume Sweet Spot (max 15 pts) — unchanged ──
    // We want ENOUGH volume to trade safely, but NOT so much that 10% pumps are impossible.
    // Sweet spot: $500K-$5M. Penalize very high volume (deep market = hard to pump).
    if (vol24hUsd >= 500000 && vol24hUsd <= 5000000) score += 15;      // Sweet spot
    else if (vol24hUsd > 5000000 && vol24hUsd <= 10000000) score += 12; // Still ok
    else if (vol24hUsd > 10000000 && vol24hUsd <= 20000000) score += 8; // Getting heavy
    else if (vol24hUsd > 20000000) score += 4;                         // Very deep market
    else if (vol24hUsd >= 300000) score += 11;                         // Barely enough
    else if (vol24hUsd >= 100000) score += 6;
    else if (vol24hUsd >= 50000) score += 1;

    // ── COMPONENT 4: 1H Momentum (max 15 pts) — unchanged ──
    if (last1hChg >= 3) score += 15;
    else if (last1hChg >= 2) score += 13;
    else if (last1hChg >= 1) score += 11;
    else if (last1hChg >= 0.5) score += 8;
    else if (last1hChg >= 0) score += 5;
    else if (last1hChg >= -1) score += 2;

    // ── COMPONENT 5: Volatility profile (max 10 pts) — unchanged ──
    // Higher daily ATR = more explosive upside potential
    const atr = avgDailyATRPct || 0;
    if (atr >= 12) score += 10;
    else if (atr >= 10) score += 9;
    else if (atr >= 8) score += 8;
    else if (atr >= 6) score += 6;
    else if (atr >= 5) score += 4;
    else if (atr >= 4) score += 2;

    // ── COMPONENT 6: Breakout proximity (max 5 pts) — unchanged ──
    // Price near the 14-day high = approaching breakout zone
    const pos = pricePositionPct || 50;
    if (pos >= 90) score += 5;
    else if (pos >= 80) score += 4;
    else if (pos >= 70) score += 3;
    else if (pos >= 50) score += 1;

    // ── COMPONENT 7: Volume surge (max 15 pts) — TRIPLED from V3.5's 5pts ──
    // This is the KEY differentiator: is money flowing into this coin RIGHT NOW?
    // A 3x surge vs a 0.8x trickle should create a MASSIVE scoring gap.
    // AGLD (0.8x, nobody trading) vs FAI (2x+, volume pouring in) = night and day.
    const surge = volumeSurgeRatio || 1;
    if (surge >= 3.0) score += 15;
    else if (surge >= 2.5) score += 13;
    else if (surge >= 2.0) score += 11;
    else if (surge >= 1.5) score += 8;
    else if (surge >= 1.2) score += 5;
    else if (surge >= 1.0) score += 3;
    else if (surge >= 0.8) score += 1;

    // ── PENALTY DEDUCTIONS ──
    if (last1hChg > 2.5 && chg4h > 0 && last1hChg > chg4h * 0.6) score -= 18; // Spike: too late
    if (chg4h < -3 && last1hChg > 1) score -= 15; // Dead cat bounce
    if (chg4h > 15) score -= 10; // Overextended
    if (chg4h > 8 && last1hChg < -1) score -= 12; // Peaked
    if (surge < 0.3) score -= 12; // Volume dead — ghost town (was -10, bumped to -12)
    else if (surge < 0.5) score -= 6; // Volume stagnant — very low interest (NEW)
    if (pos < 20) score -= 8; // Bottom 20% of range — downtrend

    // ── NEW V4.0 PENALTIES — Target "looks good on paper, dead in reality" ──
    // Stale Move: Big 4H range but FLAT last hour = the move already happened.
    // This is the AGLD scenario: range was 56% historically but 1H change ≈ 0%.
    // The coin had a nice setup earlier but now it's just consolidating sideways.
    if (range4h >= 5 && Math.abs(last1hChg) < 0.5) score -= 10;

    // Momentum Fading: 4H was positive but last hour reversed — move is dying.
    // Only fires in mid-range (chg4h 3-8%). The "Peaked" penalty covers > 8%.
    if (chg4h >= 3 && chg4h <= 8 && last1hChg < -0.5) score -= 6;

    return Math.max(0, score);
}

// ═══════════════════════════════════════════════════════
// ORDER BOOK SLIPPAGE CALCULATOR
// Simulates a market buy of $X and calculates slippage vs best ask
// ═══════════════════════════════════════════════════════
const ORDERBOOK_CONCURRENCY = 5;
const ORDERBOOK_DELAY_MS = 200;

function calculateSlippage(asks, entryUsd) {
    if (!asks || asks.length === 0) return Infinity;
    let remaining = entryUsd;
    let totalCoinsBought = 0;
    const bestAsk = parseFloat(asks[0]?.[0]) || 0;
    if (bestAsk <= 0) return Infinity;

    for (const [priceStr, sizeStr] of asks) {
        const price = parseFloat(priceStr);
        const size = parseFloat(sizeStr);
        if (price <= 0 || size <= 0) continue;
        const levelUsd = price * size;
        if (levelUsd >= remaining) {
            totalCoinsBought += remaining / price;
            remaining = 0;
            break;
        } else {
            totalCoinsBought += size;
            remaining -= levelUsd;
        }
    }

    if (remaining > 0) return Infinity; // Order book too thin for this entry size
    const avgPrice = entryUsd / totalCoinsBought;
    return ((avgPrice - bestAsk) / bestAsk) * 100;
}

// ═══════════════════════════════════════════════════════
// HELPER: Batch-run async tasks with concurrency control
// ═══════════════════════════════════════════════════════
async function batchAsync(tasks, concurrency, delayMs = 0) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
        const batch = tasks.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(batch.map(fn => fn()));
        results.push(...batchResults);
        if (delayMs > 0 && i + concurrency < tasks.length) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return results;
}

// ═══════════════════════════════════════════════════════
// MAIN SCANNER V3 — 100% Coinbase-Native
// ═══════════════════════════════════════════════════════
async function scanAllCoins({ maxCoins = 30, minVolume = 300000, minScore = 15, verbose = false } = {}) {
    const startTime = Date.now();
    const now = new Date();

    // ── Step 1: Fetch ALL Coinbase products ──
    if (verbose) console.log('  📡 Fetching all Coinbase products...');
    const products = await coinbaseApi.fetchAllProducts();

    // Filter to active USD pairs only
    const usdPairs = products.filter(p =>
        p.quote_currency === 'USD' &&
        p.status === 'online' &&
        !p.trading_disabled &&
        !p.cancel_only &&
        !p.limit_only &&
        !p.post_only &&
        !p.auction_mode
    );

    // Remove excluded symbols
    const candidates = usdPairs.filter(p => !EXCLUDED_SYMBOLS.has(p.base_currency.toUpperCase()));

    if (verbose) {
        console.log(`  ✅ ${usdPairs.length} active USD pairs, ${candidates.length} after exclusions`);
    }

    // ── Step 2: Batch fetch 24h stats for all candidates ──
    if (verbose) console.log(`  📊 Fetching 24h stats for ${candidates.length} coins...`);
    const statsStartTime = Date.now();

    const statsTasks = candidates.map(p => async () => {
        try {
            const stats = await coinbaseApi.fetchProductStats(p.id);
            const last = parseFloat(stats.last) || 0;
            const open = parseFloat(stats.open) || 0;
            const high = parseFloat(stats.high) || 0;
            const low = parseFloat(stats.low) || 0;
            const vol = parseFloat(stats.volume) || 0;
            const vol30d = parseFloat(stats.volume_30day) || 0;

            // Calculate USD volume (vol is in base currency, multiply by price)
            const vol24hUsd = vol * last;
            const chg24h = open > 0 ? ((last - open) / open) * 100 : 0;
            const range24h = open > 0 ? ((high - low) / open) * 100 : 0;

            const quoteIncrement = parseFloat(p.quote_increment) || 0;
            return {
                symbol: p.base_currency.toUpperCase(),
                pair: p.id,
                last,
                open,
                high24h: high,
                low24h: low,
                vol24hUsd,
                vol30d,
                chg24h,
                range24h,
                quoteIncrement,
            };
        } catch (err) {
            return null;
        }
    });

    const statsResults = await batchAsync(statsTasks, STATS_CONCURRENCY, STATS_DELAY_MS);
    const allStats = statsResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    if (verbose) {
        const statsElapsed = ((Date.now() - statsStartTime) / 1000).toFixed(1);
        console.log(`  ✅ Got stats for ${allStats.length}/${candidates.length} coins in ${statsElapsed}s`);
    }

    // ── Step 3: Quick filter — volume + movement + quality gates ──
    let priceKills = 0, tickKills = 0, volKills = 0;
    const movers = allStats.filter(s => {
        if (s.last <= 0) return false;
        // QUALITY GATE 1: Minimum price — kill sub-penny blocky dust
        if (s.last < MIN_PRICE) { priceKills++; return false; }
        // QUALITY GATE 2: Tick size — if 1 tick > 1.5% of price, chart is blocky garbage
        if (s.quoteIncrement > 0 && ((s.quoteIncrement / s.last) * 100) > MAX_TICK_PCT) { tickKills++; return false; }
        // QUALITY GATE 3: Volume — need enough for $10K entry without wrecking the market
        if (s.vol24hUsd < minVolume) { volKills++; return false; }
        // Need SOME movement — either 24h change or range
        if (Math.abs(s.chg24h) < 0.5 && s.range24h < 1.5) return false;
        return true;
    });

    if (verbose) {
        console.log(`  🔥 ${movers.length} coins pass quick filter`);
        console.log(`     💀 Price < $${MIN_PRICE}: ${priceKills} killed | Tick > ${MAX_TICK_PCT}%: ${tickKills} killed | Vol < $${(minVolume/1000).toFixed(0)}K: ${volKills} killed`);
    }

    // ── Step 3.5: Historical Volatility Gate ──
    // Fetch 14 days of daily candles → verify each coin CAN actually move 10%+
    // This dynamically kills BTC/ETH/SOL/XRP/SKY-type coins without hardcoding
    if (verbose) console.log(`  🌡️  Checking ${movers.length} coins for pump potential (${VOLATILITY_LOOKBACK_DAYS}d vol-scaled ATR, base=${BASE_ATR_REQ}%, scale=${VOL_SCALE_FACTOR}/2x vol)...`);
    const volGateStart = Date.now();
    const daysAgo = new Date(now.getTime() - VOLATILITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const volTasks = movers.map(coin => async () => {
        try {
            const dailyCandles = await coinbaseApi.fetchCandles(
                coin.pair, 86400, daysAgo.toISOString(), now.toISOString()
            );
            // Pass vol24hUsd so the dynamic threshold can scale with liquidity
            const analysis = analyzeVolatility(dailyCandles, coin.vol24hUsd);
            return { ...coin, ...analysis };
        } catch (err) {
            return { ...coin, pass: false, reason: 'api_error' };
        }
    });

    const volGateResults = await batchAsync(volTasks, VOLATILITY_CONCURRENCY, VOLATILITY_DELAY_MS);
    const rejVol = [];
    const volCoins = volGateResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
        .filter(c => {
            if (!c.pass) {
                rejVol.push(`${c.symbol}(${c.reason})`);
                return false;
            }
            return true;
        });

    if (verbose) {
        const volElapsed = ((Date.now() - volGateStart) / 1000).toFixed(1);
        if (rejVol.length) console.log(`  ❄️  Rejected ${rejVol.length} low-volatility coins: ${rejVol.join(', ')}`);
        console.log(`  ✅ ${volCoins.length}/${movers.length} coins pass volatility gate in ${volElapsed}s`);
    }

    // ── Step 4: Fetch 4H hourly candles for volatile coins ──
    if (verbose) console.log(`  📈 Fetching 4H candles for ${volCoins.length} coins...`);
    const candleStartTime = Date.now();

    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    const candleTasks = volCoins.map(coin => async () => {
        try {
            // Fetch hourly candles for the last 4 hours
            const candles = await coinbaseApi.fetchCandles(
                coin.pair,
                3600, // 1-hour granularity
                fourHoursAgo.toISOString(),
                now.toISOString()
            );

            if (!candles || candles.length < 2) return null;

            // Sort chronologically (Coinbase returns newest first)
            candles.sort((a, b) => new Date(a.time) - new Date(b.time));

            const oldest = candles[0];
            const newest = candles[candles.length - 1];

            // 4H metrics
            const open4h = oldest.open;
            const close4h = newest.close;
            const chg4h = open4h > 0 ? ((close4h - open4h) / open4h) * 100 : 0;

            let high4h = -Infinity, low4h = Infinity;
            candles.forEach(c => {
                high4h = Math.max(high4h, c.high);
                low4h = Math.min(low4h, c.low);
            });
            const range4h = open4h > 0 ? ((high4h - low4h) / open4h) * 100 : 0;

            // Last 1H change (most recent candle)
            const last1hChg = newest.open > 0
                ? ((newest.close - newest.open) / newest.open) * 100
                : 0;

            // Momentum: is the latest close near the 4H high? (0-1 scale)
            const momentumPct = (high4h > low4h)
                ? (newest.close - low4h) / (high4h - low4h)
                : 0.5;

            // Volume surge: compare current 4H volume to average 4H block
            const vol4hBase = candles.reduce((sum, c) => sum + (c.volume || 0), 0);
            const vol4hUsd = vol4hBase * ((close4h + open4h) / 2 || 1);
            const avg4hVol = coin.vol24hUsd / 6; // 24h / 6 = one 4h block
            const volumeSurgeRatio = avg4hVol > 0 ? Math.round((vol4hUsd / avg4hVol) * 100) / 100 : 1;

            return {
                ...coin,
                chg4h,
                range4h,
                high4h,
                low4h,
                last1hChg,
                momentumPct,
                open4h,
                close4h,
                volumeSurgeRatio,
            };
        } catch (err) {
            return null;
        }
    });

    const candleResults = await batchAsync(candleTasks, CANDLE_CONCURRENCY, CANDLE_DELAY_MS);
    const withCandles = candleResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    if (verbose) {
        const candleElapsed = ((Date.now() - candleStartTime) / 1000).toFixed(1);
        console.log(`  ✅ Got 4H candles for ${withCandles.length}/${volCoins.length} coins in ${candleElapsed}s`);
    }

    // ── Step 4.5: Filter out coins with boring 4H range ──
    const volatile = withCandles.filter(r => r.range4h >= MIN_4H_RANGE);
    if (verbose) console.log(`  🔥 ${volatile.length} coins pass minimum 4H range (>= ${MIN_4H_RANGE}%)`);

    // ── Step 5: Score each coin ──
    const scored = volatile.map(r => ({
        ...r,
        score: calculateMoverScore(r),
    }));

    // ── Step 6: Filter by minimum score and sort ──
    const qualified = scored
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score);

    // ── Step 6.5: Order book depth check — can $10K enter < 3% slippage? ──
    const obCandidates = qualified.slice(0, maxCoins * 2);
    if (verbose) console.log(`  💧 Checking order book depth for ${obCandidates.length} coins ($${ENTRY_SIZE_USD.toLocaleString()} entry, max ${MAX_SLIPPAGE_PCT}% slippage)...`);
    const obStartTime = Date.now();

    const obTasks = obCandidates.map(coin => async () => {
        try {
            const book = await coinbaseApi.fetchOrderBook(coin.pair, 2);
            const slippage = calculateSlippage(book.asks, ENTRY_SIZE_USD);
            return { ...coin, slippagePct: Math.round(slippage * 100) / 100 };
        } catch (err) {
            return { ...coin, slippagePct: Infinity };
        }
    });

    const obResults = await batchAsync(obTasks, ORDERBOOK_CONCURRENCY, ORDERBOOK_DELAY_MS);
    const liquidCoins = obResults
        .filter(r => r.status === 'fulfilled' && r.value && r.value.slippagePct <= MAX_SLIPPAGE_PCT)
        .map(r => r.value);

    if (verbose) {
        const obElapsed = ((Date.now() - obStartTime) / 1000).toFixed(1);
        const rejNames = [];
        obCandidates.forEach((c, i) => {
            const r = obResults[i];
            if (r.status === 'fulfilled' && r.value && r.value.slippagePct > MAX_SLIPPAGE_PCT) {
                rejNames.push(`${c.symbol}(${r.value.slippagePct === Infinity ? '∞' : r.value.slippagePct.toFixed(1)}%)`);
            }
        });
        if (rejNames.length) console.log(`  ⚠️  Rejected ${rejNames.length} thin order books: ${rejNames.join(', ')}`);
        console.log(`  ✅ ${liquidCoins.length} coins pass depth check in ${obElapsed}s`);
    }

    // ── Step 6.7: Real-time candle quality check — kill OMNI-type garbage ──
    // Fetches 1-min candles (last 15 min) + ticker spread for each surviving coin
    // Rejects coins with: wide spread, missing candles, or thin per-minute volume
    const qualCandidates = liquidCoins.slice(0, maxCoins * 2);
    if (verbose) console.log(`  🔬 Candle quality check for ${qualCandidates.length} coins (${QUALITY_CHECK_MINUTES}m window, spread<${MAX_SPREAD_PCT}%, active>=${MIN_ACTIVE_CANDLES}/${QUALITY_CHECK_MINUTES}, medVol>=$${MIN_MEDIAN_CANDLE_VOL})...`);
    const qualStartTime = Date.now();
    const qNow = new Date();
    const qStart = new Date(qNow.getTime() - QUALITY_CHECK_MINUTES * 60 * 1000);

    const qualTasks = qualCandidates.map(coin => async () => {
        try {
            // Fetch 1-min candles and ticker in parallel
            const [candles, ticker] = await Promise.all([
                coinbaseApi.fetchCandles(coin.pair, 60, qStart.toISOString(), qNow.toISOString()),
                coinbaseApi.fetchProductTicker(coin.pair),
            ]);
            const bid = parseFloat(ticker.bid) || 0;
            const ask = parseFloat(ticker.ask) || 0;
            const spreadPct = bid > 0 ? ((ask - bid) / bid) * 100 : 99;

            // Per-candle USD volumes
            const vols = (candles || []).map(c => (c.volume || 0) * (c.close || 0)).sort((a, b) => a - b);
            const activeCandles = candles ? candles.length : 0;
            const medVol = vols.length > 0 ? vols[Math.floor(vols.length / 2)] : 0;

            return { ...coin, spreadPct: Math.round(spreadPct * 1000) / 1000, activeCandles, medCandleVol: Math.round(medVol) };
        } catch {
            return { ...coin, spreadPct: 99, activeCandles: 0, medCandleVol: 0 };
        }
    });

    const qualResults = await batchAsync(qualTasks, QUALITY_CONCURRENCY, QUALITY_DELAY_MS);
    const rejQual = [];
    const qualityCoins = qualResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
        .filter(c => {
            if (c.spreadPct > MAX_SPREAD_PCT) {
                rejQual.push(`${c.symbol}(spread=${c.spreadPct.toFixed(2)}%)`);
                return false;
            }
            // ATR-scaled candle leniency: high-ATR coins (>= 12%) get relaxed active threshold
            // KAVA (12.3% ATR) was killed with 5 active candles at quiet hours — that's fine for proven volatile coins
            const activeThresh = (c.avgDailyATRPct && c.avgDailyATRPct >= 12) ? 4 : MIN_ACTIVE_CANDLES;
            if (c.activeCandles < activeThresh) {
                rejQual.push(`${c.symbol}(active=${c.activeCandles}/${QUALITY_CHECK_MINUTES})`);
                return false;
            }
            if (c.medCandleVol < MIN_MEDIAN_CANDLE_VOL) {
                rejQual.push(`${c.symbol}(medVol=$${c.medCandleVol})`);
                return false;
            }
            return true;
        });

    if (verbose) {
        const qualElapsed = ((Date.now() - qualStartTime) / 1000).toFixed(1);
        if (rejQual.length) console.log(`  ⚠️  Rejected ${rejQual.length} low-quality coins: ${rejQual.join(', ')}`);
        console.log(`  ✅ ${qualityCoins.length} coins pass candle quality check in ${qualElapsed}s`);
    }

    // ── Step 7: Take top N from quality coins ──
    const topCoins = qualityCoins.slice(0, maxCoins);

    if (verbose) {
        const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n  🏆 Top ${topCoins.length} coins selected (score >= ${minScore}) in ${totalElapsed}s total:`);
        console.log('  ' + '─'.repeat(155));
        console.log('  Rank  Symbol      Score   ATR%  ReqATR  MaxDay  Pos%   4H Chg    4H Range   1H Chg   VolSurge   Vol (USD)   Slip    Price');
        console.log('  ' + '─'.repeat(155));
        for (let i = 0; i < topCoins.length; i++) {
            const r = topCoins[i];
            const volStr = r.vol24hUsd > 1e6
                ? (r.vol24hUsd / 1e6).toFixed(1) + 'M'
                : (r.vol24hUsd / 1e3).toFixed(0) + 'K';
            const chg4hStr = (r.chg4h > 0 ? '+' : '') + r.chg4h.toFixed(2) + '%';
            const rangeStr = r.range4h.toFixed(2) + '%';
            const chg1hStr = (r.last1hChg > 0 ? '+' : '') + r.last1hChg.toFixed(2) + '%';
            const slipStr = r.slippagePct != null ? r.slippagePct.toFixed(2) + '%' : 'N/A';
            const atrStr = r.avgDailyATRPct != null ? r.avgDailyATRPct.toFixed(1) + '%' : 'N/A';
            const reqATRStr = r.dynamicATRReq != null ? r.dynamicATRReq.toFixed(1) + '%' : 'N/A';
            const maxDayStr = r.maxDailyRangePct != null ? r.maxDailyRangePct.toFixed(1) + '%' : 'N/A';
            const posStr = r.pricePositionPct != null ? r.pricePositionPct.toFixed(0) + '%' : 'N/A';
            const surgeStr = r.volumeSurgeRatio != null ? r.volumeSurgeRatio.toFixed(1) + 'x' : 'N/A';
            console.log(
                '  ' + String(i + 1).padStart(4) + '  ' +
                r.symbol.padEnd(12) +
                String(r.score).padStart(5) + '   ' +
                atrStr.padStart(5) + '  ' +
                reqATRStr.padStart(6) + '  ' +
                maxDayStr.padStart(6) + '  ' +
                posStr.padStart(4) + '  ' +
                chg4hStr.padStart(9) + '  ' +
                rangeStr.padStart(9) + '  ' +
                chg1hStr.padStart(8) + '  ' +
                surgeStr.padStart(8) + '  ' +
                volStr.padStart(10) + '  ' +
                slipStr.padStart(7) + '  ' +
                String(r.last)
            );
        }
        console.log('  ' + '─'.repeat(155));
    }

    // Return in the format loadTokensFromPrescanner expects
    return topCoins.map(r => ({
        symbol: r.symbol,
        pct24h: r.chg24h,
        pct4h: r.chg4h,
        vol24h: r.vol24hUsd,
        score: r.score,
        price: r.last,
        avgDailyATRPct: r.avgDailyATRPct,
        dynamicATRReq: r.dynamicATRReq,
        maxDailyRangePct: r.maxDailyRangePct,
        explosiveDayPass: r.explosiveDayPass,
        pricePositionPct: r.pricePositionPct,
        volumeSurgeRatio: r.volumeSurgeRatio,
        volatileDays: r.volatileDays,
    }));
}

// ═══════════════════════════════════════════════════════
// CLI MODE — run standalone to test
// ═══════════════════════════════════════════════════════
if (require.main === module) {
    const args = process.argv.slice(2);
    const maxCoins = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1]) || 30;
    const minVol = parseInt(args.find(a => a.startsWith('--min-vol='))?.split('=')[1]) || 300000;
    const minScore = parseInt(args.find(a => a.startsWith('--min-score='))?.split('=')[1]) || 15;

    console.log('═'.repeat(80));
    console.log('PRESCANNER V4.0 — Momentum & Volume Surge Priority (fixes AGLD-type sideways)');
    console.log('═'.repeat(80));
    console.log(`Config: max=${maxCoins} coins, minVol=$${(minVol/1000).toFixed(0)}K, minScore=${minScore}`);
    console.log(`Gates:  baseATR=${BASE_ATR_REQ}%, scale=${VOL_SCALE_FACTOR}/2x vol, explosiveDay=${EXPLOSIVE_DAY_PCT}%, minBestDay=${MIN_BEST_DAY_RANGE_PCT}%\n`);

    scanAllCoins({ maxCoins, minVolume: minVol, minScore, verbose: true })
        .then(coins => {
            console.log(`\n✅ Scanner complete. ${coins.length} coins ready for analysis.`);
            console.log('\nCoins:', coins.map(c => c.symbol).join(', '));
        })
        .catch(err => {
            console.error('Fatal:', err);
            process.exit(1);
        });
}

module.exports = { scanAllCoins, calculateMoverScore, analyzeVolatility, EXCLUDED_SYMBOLS };
