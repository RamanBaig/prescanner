# prescanner

A tool for scanning cryptocurrency trade logs and identifying short-term pump outcomes on the Coinbase Exchange.

## Branches

### `main`

- `README.md` — this file
- `ss/` — a directory containing:
  - `ssdd` — a file inside the `ss` directory

### `master`

The master branch contains the core prescanner data and results for 2025.

**What it does:**
Tracks 20 "Pumper Coins" on Coinbase Exchange. For each log timestamp, fetches 5-minute candles for the next 4 hours (7:00 AM – 11:55 AM ET) and records the peak high as a percentage move from the entry price. Used to label winners for algo training.

**Directory structure:**

- `by_month/` — raw trade analysis log files organized by month
  - `Jan_2025/` through `Dec_2025/` — `.log` files per day (e.g. `coinbase_trade_analysis_2025-01-01_ET_1000_UTC_*.log`)

- `results/` — processed outcome files
  - `2025_overall_summary.txt` / `.json` — full-year aggregated stats
  - `{Month}_2025_outcomes.txt` / `.json` — per-month outcome records (all 12 months)

**2025 full-year highlights (from `results/2025_overall_summary.txt`):**

| Metric | Value |
|---|---|
| Total log files processed | 21,000 |
| Total coin-slots | 319,062 |
| Average 4hr peak | 2.86% |
| 5%+ pumps in 4hr | 46,255 (14.50%) |
| 10%+ pumps in 4hr | 15,170 (4.75%) |
| 15%+ pumps in 4hr | 7,028 (2.20%) |
| 20%+ pumps in 4hr | 3,912 (1.23%) |

> **Note:** 10%+ is the winner threshold used for algo training label assignment.
