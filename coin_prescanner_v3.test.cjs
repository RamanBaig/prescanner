// coin_prescanner_v3.test.cjs — Full test suite for calculateMoverScore,
//   analyzeVolatility, and calculateSlippage
// Run with:  node coin_prescanner_v3.test.cjs
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');

// ─── Inline the three pure functions under test ──────────────────────────────
// We duplicate them here so tests run without the coinbaseApi dependency.

// ── Constants needed by analyzeVolatility ──
const MIN_DAILY_CANDLES = 3;
const VOLATILE_DAY_THRESHOLD = 5.0;
const BASE_ATR_REQ = 7.0;
const VOL_SCALE_BASE = 500_000;
const VOL_SCALE_FACTOR = 1.5;
const EXPLOSIVE_DAY_PCT = 15.0;
const EXPLOSIVE_ATR_DISCOUNT = 0.70;
const MIN_BEST_DAY_RANGE_PCT = 10.0;
const MIN_VOLATILE_DAYS = 2;

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

    const volScaling = vol24hUsd > VOL_SCALE_BASE
        ? Math.log2(vol24hUsd / VOL_SCALE_BASE) * VOL_SCALE_FACTOR
        : 0;
    const rawATRReq = BASE_ATR_REQ + volScaling;
    const fullATRReq = sorted.length >= 7 ? rawATRReq : rawATRReq - 1.0;
    const rangeThresh = sorted.length >= 7 ? MIN_BEST_DAY_RANGE_PCT : MIN_BEST_DAY_RANGE_PCT - 2.0;
    const minVolDays = sorted.length >= 7 ? MIN_VOLATILE_DAYS : 1;

    const explosiveDayPass = maxRangePct >= EXPLOSIVE_DAY_PCT;
    const effectiveATRReq = explosiveDayPass ? fullATRReq * EXPLOSIVE_ATR_DISCOUNT : fullATRReq;

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

function calculateMoverScore(stats) {
    const { chg4h, range4h, vol24hUsd, momentumPct, last1hChg, avgDailyATRPct, pricePositionPct, volumeSurgeRatio,
            consecGreen, trendConsistency, volExpansion, priceAboveVwap4h, obvBullish4h } = stats;
    let score = 0;

    const vexp = volExpansion != null ? volExpansion : 1.0;

    if (chg4h >= 15) score += 22;
    else if (chg4h >= 10) score += 20;
    else if (chg4h >= 7) score += 18;
    else if (chg4h >= 5) score += 15;
    else if (chg4h >= 3) score += 12;
    else if (chg4h >= 2) score += 9;
    else if (chg4h >= 1) score += 6;
    else if (chg4h >= 0.5) score += 4;
    else if (chg4h >= 0) score += 2;

    if (range4h >= 20) score += 15;
    else if (range4h >= 15) score += 13;
    else if (range4h >= 10) score += 11;
    else if (range4h >= 7) score += 9;
    else if (range4h >= 5) score += 8;
    else if (range4h >= 3) score += 5;
    else if (range4h >= 2.5) score += 3;

    if (vol24hUsd >= 500000 && vol24hUsd <= 5000000) score += 15;
    else if (vol24hUsd > 5000000 && vol24hUsd <= 10000000) score += 12;
    else if (vol24hUsd > 10000000 && vol24hUsd <= 20000000) score += 8;
    else if (vol24hUsd > 20000000) score += 4;
    else if (vol24hUsd >= 300000) score += 11;
    else if (vol24hUsd >= 100000) score += 6;
    else if (vol24hUsd >= 50000) score += 1;

    if (last1hChg >= 3) score += 15;
    else if (last1hChg >= 2) score += 13;
    else if (last1hChg >= 1) score += 11;
    else if (last1hChg >= 0.5) score += 8;
    else if (last1hChg >= 0) score += 5;
    else if (last1hChg >= -1) score += 2;

    const atr = avgDailyATRPct || 0;
    if (atr >= 12) score += 10;
    else if (atr >= 10) score += 9;
    else if (atr >= 8) score += 8;
    else if (atr >= 6) score += 6;
    else if (atr >= 5) score += 4;
    else if (atr >= 4) score += 2;

    const pos = pricePositionPct || 50;
    if (pos >= 90) score += 5;
    else if (pos >= 80) score += 4;
    else if (pos >= 70) score += 3;
    else if (pos >= 50) score += 1;

    const surge = volumeSurgeRatio || 1;
    if (surge >= 3.0) score += 15;
    else if (surge >= 2.5) score += 13;
    else if (surge >= 2.0) score += 11;
    else if (surge >= 1.5) score += 8;
    else if (surge >= 1.2) score += 5;
    else if (surge >= 1.0) score += 3;
    else if (surge >= 0.8) score += 1;

    const cg = consecGreen != null ? consecGreen : 0;
    if (cg >= 3) score += 8;
    else if (cg >= 2) score += 5;
    else if (cg >= 1) score += 2;

    if (vexp >= 2.0) score += 5;
    else if (vexp >= 1.5) score += 3;
    else if (vexp >= 1.2) score += 1;

    if (priceAboveVwap4h) score += 4;
    if (obvBullish4h) score += 4;

    if (last1hChg > 3.5 && vexp >= 2.5 && chg4h > 0) score -= 18;
    if (chg4h < -3 && last1hChg > 1) score -= 15;
    if (chg4h > 15) score -= 10;
    if (chg4h > 8 && last1hChg < -1) score -= 12;
    if (surge < 0.3) score -= 12;
    else if (surge < 0.5) score -= 6;
    if (pos < 20) score -= 8;

    if (range4h >= 5 && Math.abs(last1hChg) < 0.5) score -= 10;
    if (chg4h >= 3 && chg4h <= 8 && last1hChg < -0.5) score -= 6;

    const tc = trendConsistency != null ? trendConsistency : 0.5;
    if (tc < 0.25 && range4h >= 3) score -= 10;
    if (vexp < 0.5 && range4h >= 5) score -= 5;
    if (range4h < 3 && vexp < 0.8) score -= 5;

    return Math.max(0, score);
}

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

    if (remaining > 0) return Infinity;
    const avgPrice = entryUsd / totalCoinsBought;
    return ((avgPrice - bestAsk) / bestAsk) * 100;
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅  ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌  ${name}`);
        console.log(`       ${err.message}`);
        failed++;
        failures.push({ name, err });
    }
}

function approx(a, b, tol = 0.01) {
    assert.ok(Math.abs(a - b) <= tol, `Expected ${a} ≈ ${b} (tol=${tol})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASE PROFILE — neutral coin with no special signals and no penalties
// ═══════════════════════════════════════════════════════════════════════════════
const BASE = {
    chg4h: 1,           // +6 pts (C1)
    range4h: 3,         // +5 pts (C2)
    vol24hUsd: 1000000, // +15 pts (C3 sweet spot)
    last1hChg: 0.5,     // +8 pts (C4)
    avgDailyATRPct: 8,  // +8 pts (C5)
    pricePositionPct: 50, // +1 pt (C6)
    volumeSurgeRatio: 1.0, // +3 pts (C7)
    consecGreen: 1,     // +2 pts (C8)
    volExpansion: 1.0,  // 0 pts (C9 needs ≥1.2)
    priceAboveVwap4h: false, // 0 pts (C10)
    obvBullish4h: false,     // 0 pts (C11)
    momentumPct: 0.5,
    trendConsistency: 0.5,   // no penalty
};
// Expected base score: 6+5+15+8+8+1+3+2 = 48

console.log('\n════════════════════════════════════════');
console.log('  calculateMoverScore — Component Tests');
console.log('════════════════════════════════════════');

test('base profile scores 48', () => {
    assert.strictEqual(calculateMoverScore(BASE), 48);
});

// ── Component 1: 4H change ────────────────────────────────────────────────────
test('C1: chg4h >= 15 → +22 pts', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: 15 });
    assert.strictEqual(s, 48 - 6 + 22); // replace +6 with +22
});
test('C1: chg4h >= 10 → +20 pts', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: 10 });
    assert.strictEqual(s, 48 - 6 + 20);
});
test('C1: chg4h >= 7 → +18 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, chg4h: 7 }), 48 - 6 + 18);
});
test('C1: chg4h >= 5 → +15 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, chg4h: 5 }), 48 - 6 + 15);
});
test('C1: chg4h >= 3 → +12 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, chg4h: 3 }), 48 - 6 + 12);
});
test('C1: chg4h >= 2 → +9 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, chg4h: 2 }), 48 - 6 + 9);
});
test('C1: chg4h >= 0.5 → +4 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, chg4h: 0.5 }), 48 - 6 + 4);
});
test('C1: chg4h 0 → +2 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, chg4h: 0 }), 48 - 6 + 2);
});
test('C1: chg4h negative → 0 pts from C1', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: -5 });
    assert.strictEqual(s, 48 - 6); // C1 gives 0
});

// ── Component 2: 4H range ─────────────────────────────────────────────────────
test('C2: range4h >= 20 → +15 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, range4h: 20 }), 48 - 5 + 15);
});
test('C2: range4h >= 15 → +13 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, range4h: 15 }), 48 - 5 + 13);
});
test('C2: range4h >= 10 → +11 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, range4h: 10 }), 48 - 5 + 11);
});
test('C2: range4h >= 7 → +9 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, range4h: 7 }), 48 - 5 + 9);
});
test('C2: range4h >= 5 → +8 pts', () => {
    // Note: range4h=5 triggers stale-move penalty check too (but last1hChg=0.5 ≥ 0.5, no fire)
    assert.strictEqual(calculateMoverScore({ ...BASE, range4h: 5 }), 48 - 5 + 8);
});
test('C2: range4h < 2.5 → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, range4h: 2 }), 48 - 5);
});

// ── Component 3: Volume sweet spot ───────────────────────────────────────────
test('C3: vol $500K-$5M sweet spot → +15 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 2500000 }), 48);
});
test('C3: vol $5M-$10M → +12 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 7500000 }), 48 - 15 + 12);
});
test('C3: vol $10M-$20M → +8 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 15000000 }), 48 - 15 + 8);
});
test('C3: vol > $20M → +4 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 50000000 }), 48 - 15 + 4);
});
test('C3: vol $300K-$500K → +11 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 400000 }), 48 - 15 + 11);
});
test('C3: vol $100K-$300K → +6 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 200000 }), 48 - 15 + 6);
});
test('C3: vol $50K-$100K → +1 pt', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 75000 }), 48 - 15 + 1);
});
test('C3: vol < $50K → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, vol24hUsd: 10000 }), 48 - 15);
});

// ── Component 4: 1H momentum ─────────────────────────────────────────────────
test('C4: last1hChg >= 3 → +15 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, last1hChg: 3 }), 48 - 8 + 15);
});
test('C4: last1hChg >= 2 → +13 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, last1hChg: 2 }), 48 - 8 + 13);
});
test('C4: last1hChg >= 1 → +11 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, last1hChg: 1 }), 48 - 8 + 11);
});
test('C4: last1hChg 0 → +5 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, last1hChg: 0 }), 48 - 8 + 5);
});
test('C4: last1hChg -0.5 → +2 pts (within [-1,0))', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, last1hChg: -0.5 }), 48 - 8 + 2);
});
test('C4: last1hChg < -1 → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, last1hChg: -2 }), 48 - 8);
});

// ── Component 5: ATR ─────────────────────────────────────────────────────────
test('C5: ATR >= 12 → +10 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, avgDailyATRPct: 12 }), 48 - 8 + 10);
});
test('C5: ATR >= 10 → +9 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, avgDailyATRPct: 10 }), 48 - 8 + 9);
});
test('C5: ATR >= 6 → +6 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, avgDailyATRPct: 6 }), 48 - 8 + 6);
});
test('C5: ATR >= 5 → +4 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, avgDailyATRPct: 5 }), 48 - 8 + 4);
});
test('C5: ATR >= 4 → +2 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, avgDailyATRPct: 4 }), 48 - 8 + 2);
});
test('C5: ATR < 4 → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, avgDailyATRPct: 3 }), 48 - 8);
});

// ── Component 6: Price position ───────────────────────────────────────────────
test('C6: pos >= 90 → +5 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, pricePositionPct: 90 }), 48 - 1 + 5);
});
test('C6: pos >= 80 → +4 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, pricePositionPct: 80 }), 48 - 1 + 4);
});
test('C6: pos >= 70 → +3 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, pricePositionPct: 70 }), 48 - 1 + 3);
});
test('C6: pos 50 → +1 pt', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, pricePositionPct: 50 }), 48);
});
test('C6: pos < 50 → 0 pts from C6', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, pricePositionPct: 30 }), 48 - 1);
});

// ── Component 7: Volume surge ─────────────────────────────────────────────────
test('C7: surge >= 3.0 → +15 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volumeSurgeRatio: 3.0 }), 48 - 3 + 15);
});
test('C7: surge >= 2.5 → +13 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volumeSurgeRatio: 2.5 }), 48 - 3 + 13);
});
test('C7: surge >= 2.0 → +11 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volumeSurgeRatio: 2.0 }), 48 - 3 + 11);
});
test('C7: surge >= 1.5 → +8 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volumeSurgeRatio: 1.5 }), 48 - 3 + 8);
});
test('C7: surge >= 1.2 → +5 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volumeSurgeRatio: 1.2 }), 48 - 3 + 5);
});
test('C7: surge 0.8 → +1 pt', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volumeSurgeRatio: 0.8 }), 48 - 3 + 1);
});
test('C7: surge < 0.8 → 0 pts from C7 (plus stagnant vol penalty)', () => {
    // surge=0.6: C7=0, penalty=-6 (surge<0.5 is 0.6 which is >=0.5 so no penalty — just 0 pts from C7)
    // Actually surge=0.6 is >= 0.5 so no penalty, just 0 from C7 (since it's < 0.8)
    // Wait: surge=0.6 < 0.8 → C7 gives 0 pts. No penalty because surge >= 0.5.
    const s = calculateMoverScore({ ...BASE, volumeSurgeRatio: 0.6 });
    assert.strictEqual(s, 48 - 3); // -3 pts from C7 going 0
});

// ── Component 8: Consecutive green candles (V4.1 NEW) ────────────────────────
test('C8: consecGreen >= 3 → +8 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, consecGreen: 3 }), 48 - 2 + 8);
});
test('C8: consecGreen >= 2 → +5 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, consecGreen: 2 }), 48 - 2 + 5);
});
test('C8: consecGreen 1 → +2 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, consecGreen: 1 }), 48);
});
test('C8: consecGreen 0 → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, consecGreen: 0 }), 48 - 2);
});
test('C8: consecGreen null → defaults to 0', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, consecGreen: null }), 48 - 2);
});

// ── Component 9: Volatility expansion (V4.1 NEW) ─────────────────────────────
test('C9: volExpansion >= 2.0 → +5 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volExpansion: 2.0 }), 48 + 5);
});
test('C9: volExpansion >= 1.5 → +3 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volExpansion: 1.5 }), 48 + 3);
});
test('C9: volExpansion >= 1.2 → +1 pt', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volExpansion: 1.2 }), 48 + 1);
});
test('C9: volExpansion 1.0 → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volExpansion: 1.0 }), 48);
});
test('C9: volExpansion null → defaults to 1.0 (no points, no penalty)', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, volExpansion: null }), 48);
});

// ── Component 10: Price above VWAP (V4.2 NEW) ────────────────────────────────
test('C10: priceAboveVwap4h=true → +4 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, priceAboveVwap4h: true }), 48 + 4);
});
test('C10: priceAboveVwap4h=false → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, priceAboveVwap4h: false }), 48);
});

// ── Component 11: OBV direction (V4.2 NEW) ────────────────────────────────────
test('C11: obvBullish4h=true → +4 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, obvBullish4h: true }), 48 + 4);
});
test('C11: obvBullish4h=false → 0 pts', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, obvBullish4h: false }), 48);
});
test('C10+C11 both true → +8 pts combined', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, priceAboveVwap4h: true, obvBullish4h: true }), 48 + 8);
});

console.log('\n════════════════════════════════════════');
console.log('  calculateMoverScore — Penalty Tests');
console.log('════════════════════════════════════════');

// ── Penalty: Spike blow-off (V4.1 FIXED) ─────────────────────────────────────
// OLD: fired on last1hChg > 2.5 alone
// NEW: requires last1hChg > 3.5 AND volExpansion >= 2.5 AND chg4h > 0
test('Penalty: spike requires BOTH last1hChg>3.5 AND vexp>=2.5 (all three met → -18)', () => {
    const s = calculateMoverScore({
        ...BASE, last1hChg: 4, volExpansion: 2.5, chg4h: 5,
    });
    // C1 +15, C2 +5, C3 +15, C4 +15, C5 +8, C6 +1, C7 +3, C8 +2, C9 +5, spike -18
    // = 15+5+15+15+8+1+3+2+5 - 18 = 69 - 18 = 51
    assert.strictEqual(s, 51);
});
test('Penalty: last1hChg=3 (≤3.5) → no spike penalty even with high vexp', () => {
    // In base: last1hChg=3 → C4=+15, vexp=2.5 → C9=+5; chg4h=1
    const s = calculateMoverScore({
        ...BASE, last1hChg: 3, volExpansion: 2.5, chg4h: 1,
    });
    // C1+6, C2+5, C3+15, C4+15, C5+8, C6+1, C7+3, C8+2, C9+5 = 60. No spike (last1hChg=3 ≤ 3.5).
    assert.strictEqual(s, 60);
});
test('Penalty: last1hChg=4 but vexp=2.0 (< 2.5) → no spike penalty', () => {
    const s = calculateMoverScore({
        ...BASE, last1hChg: 4, volExpansion: 2.0, chg4h: 1,
    });
    // C1+6, C2+5, C3+15, C4+15, C5+8, C6+1, C7+3, C8+2, C9+5 = 60. No spike.
    assert.strictEqual(s, 60);
});
test('Penalty: last1hChg=4 and vexp=2.5 but chg4h <= 0 → no spike', () => {
    const s = calculateMoverScore({
        ...BASE, last1hChg: 4, volExpansion: 2.5, chg4h: 0,
    });
    // C1=+2 (chg4h=0), C2+5, C3+15, C4+15, C5+8, C6+1, C7+3, C8+2, C9+5 = 56. No spike.
    assert.strictEqual(s, 56);
});

// ── Penalty: Dead cat bounce ──────────────────────────────────────────────────
test('Penalty: dead cat bounce (chg4h < -3 AND last1hChg > 1) → -15', () => {
    const s = calculateMoverScore({
        ...BASE, chg4h: -5, last1hChg: 2,
        // C1=0, C4=+13, C2=+5, C3=+15, C5=+8, C6=+1, C7=+3, C8=+2, C9=0
        // =47, dead_cat=-15, C4=last1hChg=2→13, base had C1=6→now 0
        // Actually: 0+5+15+13+8+1+3+2 = 47, -15 = 32
    });
    assert.strictEqual(s, 32);
});
test('Penalty: dead cat does NOT fire if chg4h >= -3', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: -2, last1hChg: 2 });
    // C1=0, C2+5, C3+15, C4+13, C5+8, C6+1, C7+3, C8+2 = 47
    assert.strictEqual(s, 47);
});

// ── Penalty: Overextended ─────────────────────────────────────────────────────
test('Penalty: chg4h > 15 → overextended -10', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: 16 });
    // C1=+22 (>=15), C2+5, C3+15, C4+8, C5+8, C6+1, C7+3, C8+2 = 64, -10 overextended = 54
    assert.strictEqual(s, 54);
});
test('Penalty: chg4h = 15 exactly → NOT overextended (> not >=)', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: 15 });
    // C1=+22, no overextended penalty
    assert.strictEqual(s, 48 - 6 + 22); // = 64
});

// ── Penalty: Peaked ───────────────────────────────────────────────────────────
test('Penalty: peaked (chg4h > 8 AND last1hChg < -1) → -12', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: 10, last1hChg: -2 });
    // C1=+20, C2+5, C3+15, C4=0 (last1hChg<-1), C5+8, C6+1, C7+3, C8+2 = 54, -12 peaked = 42
    assert.strictEqual(s, 42);
});

// ── Penalty: Volume dead / stagnant ──────────────────────────────────────────
test('Penalty: surge < 0.3 → -12 (ghost town)', () => {
    const s = calculateMoverScore({ ...BASE, volumeSurgeRatio: 0.2 });
    // C7=0 (surge<0.8), -12 = 48-3-12 = 33
    assert.strictEqual(s, 33);
});
test('Penalty: surge < 0.5 → -6 (stagnant)', () => {
    const s = calculateMoverScore({ ...BASE, volumeSurgeRatio: 0.4 });
    // C7=0 (surge<0.8), -6 = 48-3-6 = 39
    assert.strictEqual(s, 39);
});
test('Penalty: surge = 0.5 → no volume penalty (boundary)', () => {
    const s = calculateMoverScore({ ...BASE, volumeSurgeRatio: 0.5 });
    // C7=0 (surge=0.5 < 0.8 so no C7 pts), no penalty (surge >= 0.5)
    assert.strictEqual(s, 48 - 3);
});

// ── Penalty: Bottom of range ──────────────────────────────────────────────────
test('Penalty: pos < 20 → -8 (downtrend)', () => {
    const s = calculateMoverScore({ ...BASE, pricePositionPct: 10 });
    // C6=0 (pos<50), -8 = 48-1-8 = 39
    assert.strictEqual(s, 39);
});

// ── Penalty: Stale move ───────────────────────────────────────────────────────
test('Penalty: stale move (range4h >= 5 AND |last1hChg| < 0.5) → -10', () => {
    const s = calculateMoverScore({ ...BASE, range4h: 8, last1hChg: 0.2 });
    // C2=+9, C4=+5 (last1hChg=0.2→≥0), stale_move=-10
    // 48 - 5(C2 was+5) + 9(C2 now) - 8(C4 was+8) + 5(C4 now) - 10 = 39
    assert.strictEqual(s, 39);
});
test('Penalty: stale move does NOT fire if last1hChg = 0.5 exactly (boundary)', () => {
    // Math.abs(0.5) < 0.5 is false → no penalty
    const s = calculateMoverScore({ ...BASE, range4h: 8, last1hChg: 0.5 });
    // C2=+9, C4=+8(≥0.5), no stale penalty
    assert.strictEqual(s, 48 - 5 + 9); // = 52
});

// ── Penalty: Momentum fading ──────────────────────────────────────────────────
test('Penalty: momentum fading (chg4h 3-8 AND last1hChg < -0.5) → -6', () => {
    const s = calculateMoverScore({ ...BASE, chg4h: 5, last1hChg: -1 });
    // C1=+15, C4=+2 (last1hChg=-1 → ≥-1), fading=-6
    // 48 -6(C1) +15 -8(C4) +2 -6 = 45
    assert.strictEqual(s, 45);
});
test('Penalty: fading does NOT fire if chg4h > 8 (peaked penalty covers that)', () => {
    // Use last1hChg=-1.1 to trigger peaked (-12), confirm fading (-6) does NOT also fire
    const s = calculateMoverScore({ ...BASE, chg4h: 9, last1hChg: -1.1 });
    // C1 +18 (>=7), C2 +5, C3 +15, C4 0 (last1hChg<-1), C5 +8, C6 +1, C7 +3, C8 +2 = 52
    // Peaked: chg4h=9>8, last1hChg=-1.1<-1 → -12
    // Fading: chg4h=9 > 8 → condition chg4h<=8 is FALSE → does NOT fire
    // Net: 52 - 12 = 40
    assert.strictEqual(s, 40);
});

// ── Penalty: Downtrend disguised (V4.1 NEW) ───────────────────────────────────
test('Penalty: mostly red candles (trendConsistency < 0.25 AND range4h >= 3) → -10', () => {
    const s = calculateMoverScore({ ...BASE, trendConsistency: 0.2, range4h: 5 });
    // C2=+8 (range4h=5), stale-move? last1hChg=0.5 so |0.5| < 0.5 is FALSE → no stale
    // downtrend=-10
    // 48 -5(C2) +8 -10 = 41
    assert.strictEqual(s, 41);
});
test('Penalty: downtrend does NOT fire if trendConsistency >= 0.25', () => {
    const s = calculateMoverScore({ ...BASE, trendConsistency: 0.25, range4h: 5 });
    assert.strictEqual(s, 48 - 5 + 8); // = 51
});
test('Penalty: downtrend does NOT fire if range4h < 3', () => {
    const s = calculateMoverScore({ ...BASE, trendConsistency: 0.2, range4h: 2.9 });
    // C2=0 (range<2.5 → no, range4h=2.9 → 2.5≤r<3 → +3), no downtrend (range<3), squeeze fires? range<3 AND vexp=1.0<0.8? NO vexp=1.0 >= 0.8
    // 48 -5(C2 was+5) +3(C2 now) = 46
    assert.strictEqual(s, 46);
});
test('Penalty: trendConsistency null → defaults to 0.5 (no penalty)', () => {
    assert.strictEqual(calculateMoverScore({ ...BASE, trendConsistency: null }), 48);
});

// ── Penalty: Volatility dying after big move (V4.1 NEW) ──────────────────────
test('Penalty: vexp < 0.5 AND range4h >= 5 → -5', () => {
    const s = calculateMoverScore({ ...BASE, volExpansion: 0.4, range4h: 5 });
    // C2=+8, C9=0, vexp<0.5 && range>=5 → -5, also squeeze? range4h=5 NOT <3, so no squeeze
    // 48 -5(C2) +8 -5(voldying) = 46
    assert.strictEqual(s, 46);
});
test('Penalty: voldying does NOT fire if range4h < 5', () => {
    const s = calculateMoverScore({ ...BASE, volExpansion: 0.4, range4h: 4 });
    // C2=+5 (range4h=4, >=3), no voldying (range<5), squeeze? range4h=4 NOT <3
    // 48 -5(C2) +5 = 48. vexp=0.4 C9=0.
    assert.strictEqual(s, 48);
});

// ── Penalty: Squeeze zone (V4.2 NEW) ─────────────────────────────────────────
test('Penalty: squeeze (range4h < 3 AND vexp < 0.8) → -5', () => {
    const s = calculateMoverScore({ ...BASE, range4h: 2.5, volExpansion: 0.5 });
    // C2=+3 (range=2.5), C9=0, squeeze=-5
    // 48 -5(C2) +3 -5 = 41
    assert.strictEqual(s, 41);
});
test('Penalty: squeeze does NOT fire if vexp >= 0.8', () => {
    const s = calculateMoverScore({ ...BASE, range4h: 2.5, volExpansion: 0.8 });
    // C2=+3, no squeeze
    assert.strictEqual(s, 48 - 5 + 3); // = 46
});
test('Penalty: squeeze does NOT fire if range4h >= 3', () => {
    const s = calculateMoverScore({ ...BASE, range4h: 3, volExpansion: 0.5 });
    // C2=+5 (range=3), no squeeze. voldying? range4h=3 <5 → no
    assert.strictEqual(s, 48 - 5 + 5); // = 48
});

// ── Floor: score never goes below 0 ──────────────────────────────────────────
test('Score floor: worst case returns 0, not negative', () => {
    const s = calculateMoverScore({
        chg4h: -10, range4h: 20, vol24hUsd: 0, last1hChg: 3, avgDailyATRPct: 0,
        pricePositionPct: 10, volumeSurgeRatio: 0.1, consecGreen: 0,
        trendConsistency: 0, volExpansion: 0.3, priceAboveVwap4h: false, obvBullish4h: false,
        momentumPct: 0,
    });
    assert.ok(s >= 0, `Score should be >= 0, got ${s}`);
});

// ── Ideal coin: strong signal on everything ────────────────────────────────────
test('Ideal coin (pump in progress) scores high (>= 90)', () => {
    const s = calculateMoverScore({
        chg4h: 12,          // +20 (C1)
        range4h: 15,        // +13 (C2)
        vol24hUsd: 2000000, // +15 (C3 sweet spot)
        last1hChg: 2,       // +13 (C4)
        avgDailyATRPct: 15, // +10 (C5)
        pricePositionPct: 92, // +5 (C6)
        volumeSurgeRatio: 3.0, // +15 (C7)
        consecGreen: 4,     // +8 (C8)
        volExpansion: 1.8,  // +3 (C9)
        priceAboveVwap4h: true, // +4 (C10)
        obvBullish4h: true,     // +4 (C11)
        trendConsistency: 0.8,
        momentumPct: 0.9,
    });
    // Total before penalties: 20+13+15+13+10+5+15+8+3+4+4 = 110
    // Penalties: chg4h=12 > 8 but last1hChg=2 > -1 → no peaked. No others.
    assert.ok(s >= 90, `Expected ideal coin score >= 90, got ${s}`);
    assert.strictEqual(s, 110);
});

// ── Garbage coin: everything bad ──────────────────────────────────────────────
test('Garbage coin (stale, low vol, downtrend) scores low (<= 20)', () => {
    const s = calculateMoverScore({
        chg4h: 0.5,         // +4 (C1)
        range4h: 6,         // +8 (C2) but stale move fires
        vol24hUsd: 80000,   // +1 (C3)
        last1hChg: 0.1,     // +5 (C4), triggers stale move
        avgDailyATRPct: 3,  // 0 (C5)
        pricePositionPct: 15, // 0 pts, -8 bottom range
        volumeSurgeRatio: 0.25, // 0 pts, -12 ghost town
        consecGreen: 0,     // 0 (C8)
        volExpansion: 0.3,  // 0 (C9), voldying fires (range>=5)
        priceAboveVwap4h: false, // 0
        obvBullish4h: false,     // 0
        trendConsistency: 0.2,   // downtrend penalty (-10, range>=3)
        momentumPct: 0.1,
    });
    // C1+4, C2+8, C3+1, C4+5, C5=0, C6=0, C7=0, C8=0, C9=0 = 18
    // Penalties: stale_move(-10), bot_range(-8), ghost_town(-12), voldying(-5), downtrend(-10)
    // = 18 - 10 - 8 - 12 - 5 - 10 = -27 → floor 0
    assert.strictEqual(s, 0);
});

console.log('\n════════════════════════════════════════');
console.log('  analyzeVolatility — Tests');
console.log('════════════════════════════════════════');

function makeCandle(close, rangePct = 0.10, time = null) {
    // rangePct is the range as a fraction of close
    const halfRange = close * rangePct / 2;
    return {
        time: time || new Date().toISOString(),
        open: close - halfRange * 0.5,
        high: close + halfRange,
        low: close - halfRange,
        close,
        volume: 1000,
    };
}

test('analyzeVolatility: < 3 candles → fail insufficient_data', () => {
    const r = analyzeVolatility([makeCandle(1)], 0);
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.reason, 'insufficient_data');
});
test('analyzeVolatility: null input → fail insufficient_data', () => {
    const r = analyzeVolatility(null, 0);
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.reason, 'insufficient_data');
});

// Build 7 daily candles with ~11% range (good volatile coin)
const goodCandles = Array.from({ length: 7 }, (_, i) => {
    const close = 1.0 + i * 0.02;
    const d = new Date('2025-01-01');
    d.setDate(d.getDate() + i);
    return {
        time: d.toISOString(),
        open: close - 0.05,
        high: close + 0.06,
        low: close - 0.05,
        close,
        volume: 5000,
    };
});
// rangePct per candle: 0.11 / 1.xx ≈ 10%+

test('analyzeVolatility: 7 good volatile candles → pass', () => {
    const r = analyzeVolatility(goodCandles, 500000);
    assert.ok(r.pass || r.reason === 'explosive_discount',
        `Expected pass, got ${r.pass} reason=${r.reason} ATR=${r.avgDailyATRPct} req=${r.dynamicATRReq}`);
});

// Build candles with tiny range (~2% — like BTC/ETH)
const stableCandles = Array.from({ length: 7 }, (_, i) => {
    const close = 50000 + i * 100;
    const d = new Date('2025-01-01');
    d.setDate(d.getDate() + i);
    return {
        time: d.toISOString(),
        open: close - 500,
        high: close + 600,
        low: close - 600,
        close,
        volume: 50000,
    };
});

test('analyzeVolatility: stable large-cap (low ATR) → fail lowATR', () => {
    const r = analyzeVolatility(stableCandles, 250_000_000); // $250M vol like SOL
    assert.strictEqual(r.pass, false);
    assert.ok(r.reason.startsWith('lowATR'), `Expected lowATR reason, got: ${r.reason}`);
});

test('analyzeVolatility: pricePositionPct is computed correctly', () => {
    // weekHigh=1.12 weekLow=1.0, latestClose=1.12
    const candles = [
        { time: '2025-01-01', open: 1.0, high: 1.05, low: 0.95, close: 1.0, volume: 1000 },
        { time: '2025-01-02', open: 1.0, high: 1.10, low: 0.98, close: 1.05, volume: 1000 },
        { time: '2025-01-03', open: 1.05, high: 1.20, low: 1.00, close: 1.15, volume: 1000 },
    ];
    const r = analyzeVolatility(candles, 0);
    // weekHigh=1.20, weekLow=0.95, latestClose=1.15 → (1.15-0.95)/(1.20-0.95)=0.2/0.25=80%
    approx(r.pricePositionPct, 80, 1);
});

test('analyzeVolatility: candles sorted by time regardless of input order', () => {
    const unsorted = [
        { time: '2025-01-03', open: 1.10, high: 1.15, low: 1.08, close: 1.12, volume: 1000 },
        { time: '2025-01-01', open: 1.00, high: 1.05, low: 0.95, close: 1.00, volume: 1000 },
        { time: '2025-01-02', open: 1.00, high: 1.08, low: 0.98, close: 1.07, volume: 1000 },
    ];
    const sorted = [
        { time: '2025-01-01', open: 1.00, high: 1.05, low: 0.95, close: 1.00, volume: 1000 },
        { time: '2025-01-02', open: 1.00, high: 1.08, low: 0.98, close: 1.07, volume: 1000 },
        { time: '2025-01-03', open: 1.10, high: 1.15, low: 1.08, close: 1.12, volume: 1000 },
    ];
    const r1 = analyzeVolatility(unsorted, 0);
    const r2 = analyzeVolatility(sorted, 0);
    assert.strictEqual(r1.avgDailyATRPct, r2.avgDailyATRPct);
    assert.strictEqual(r1.pricePositionPct, r2.pricePositionPct);
});

test('analyzeVolatility: explosive day discount applies', () => {
    // 7 mostly stable candles + 1 explosive 20% day → explosiveDayPass=true
    const candles = Array.from({ length: 7 }, (_, i) => {
        const close = 1.0 + i * 0.01;
        const d = new Date('2025-01-01');
        d.setDate(d.getDate() + i);
        return { time: d.toISOString(), open: close - 0.02, high: close + 0.02, low: close - 0.02, close, volume: 1000 };
    });
    // One explosive candle
    candles[3] = { time: '2025-01-04', open: 1.03, high: 1.26, low: 1.03, close: 1.25, volume: 5000 };
    const r = analyzeVolatility(candles, 500000);
    assert.ok(r.explosiveDayPass, 'Should detect explosive day');
    // The discount makes ATR requirement 70% of normal
    assert.ok(r.dynamicATRReq < 7.0 * 0.75, `Discounted req should be < 5.25, got ${r.dynamicATRReq}`);
});

test('analyzeVolatility: volatileDays count is correct (>= 5% range days)', () => {
    // All 4 candles have exactly 10% range → all should count as volatile
    const candles = Array.from({ length: 4 }, (_, i) => {
        const close = 1.0;
        const d = new Date('2025-01-01');
        d.setDate(d.getDate() + i);
        return { time: d.toISOString(), open: close - 0.05, high: close + 0.05, low: close - 0.05, close, volume: 1000 };
    });
    const r = analyzeVolatility(candles, 0);
    assert.strictEqual(r.volatileDays, 4);
});

test('analyzeVolatility: volume-scaled ATR requirement increases with volume', () => {
    const r_low = analyzeVolatility(stableCandles, 500_000);    // base vol
    const r_high = analyzeVolatility(stableCandles, 50_000_000); // 100x vol
    assert.ok(r_high.dynamicATRReq > r_low.dynamicATRReq,
        `High-vol req (${r_high.dynamicATRReq}) should exceed low-vol req (${r_low.dynamicATRReq})`);
});

console.log('\n════════════════════════════════════════');
console.log('  calculateSlippage — Tests');
console.log('════════════════════════════════════════');

test('calculateSlippage: empty asks → Infinity', () => {
    assert.strictEqual(calculateSlippage([], 1000), Infinity);
});
test('calculateSlippage: null asks → Infinity', () => {
    assert.strictEqual(calculateSlippage(null, 1000), Infinity);
});
test('calculateSlippage: order book too thin → Infinity', () => {
    // Only $500 at best ask, but we want $1000
    const asks = [['1.00', '500']];
    assert.strictEqual(calculateSlippage(asks, 1000), Infinity);
});
test('calculateSlippage: order filled at single level → 0% slippage', () => {
    // Deep level, enough to absorb full $1000 at $1.00
    const asks = [['1.00', '2000']];
    approx(calculateSlippage(asks, 1000), 0, 0.001);
});
test('calculateSlippage: order spills to higher level → positive slippage', () => {
    // $500 at $1.00, $500 at $1.10
    const asks = [['1.00', '500'], ['1.10', '500']];
    const slip = calculateSlippage(asks, 1000);
    // avg price = 1000 / (500/1.00 + 500/1.10) = 1000 / (500 + 454.55) = 1000 / 954.55 ≈ 1.0476
    // slippage = (1.0476 - 1.00) / 1.00 * 100 ≈ 4.76%
    approx(slip, 4.76, 0.1);
});
test('calculateSlippage: best ask price of 0 → Infinity', () => {
    assert.strictEqual(calculateSlippage([['0', '1000']], 500), Infinity);
});
test('calculateSlippage: zero-size levels are skipped', () => {
    // First level has size 0, second has enough
    const asks = [['1.00', '0'], ['1.00', '2000']];
    // bestAsk = 1.00, level 1 skipped (size=0), level 2 fills
    approx(calculateSlippage(asks, 1000), 0, 0.001);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════');
if (failed === 0) {
    console.log(`  ✅  All ${passed} tests passed.`);
} else {
    console.log(`  ⚠️  ${passed} passed, ${failed} FAILED:`);
    failures.forEach(({ name, err }) => {
        console.log(`\n  ❌  ${name}`);
        console.log(`       ${err.message}`);
    });
}
console.log('════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
