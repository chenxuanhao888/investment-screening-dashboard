# Model validation protocol

## Frozen prospective test

- Frozen model: `full-a-v3-price-plan-frozen-20260814`
- Start date: 2026-08-14
- Minimum observation period: 6 months; preferred: 12 months
- Any scoring, filter, price-plan, holding-period, or execution change requires a new model version and restarts the clock.
- Signals are recorded before their outcomes are known and are never rewritten.
- Entry and exit slippage are both 10 bps.
- A one-price limit board is treated as untradeable.
- If target and stop are both touched in the same daily bar, the stop is assumed first.
- Positions exit at target, stop, or after 20 trading days.

Primary reports after 6 and 12 months: fill rate, closed-trade win rate, payoff ratio, expectancy, maximum drawdown, turnover, benchmark excess return, and results split by market regime and score decile.

## Strict historical full-market test

The historical test must use a point-in-time security master for every trading date, including delisted and suspended securities. Required daily fields are adjusted OHLC, volume, amount, trade status, ST status, listing date, exchange-specific price-limit regime, and point-in-time PE/PB or a documented lagged substitute.

The test is invalid if it reconstructs past universes from today's listed companies. Data must also pass checks for duplicate codes, future-data leakage, corporate-action continuity, missing delisted securities, impossible fills, and stale quotes.

Execution rules match the frozen prospective test. Orders blocked by suspension, one-price limit boards, or insufficient liquidity are rejected. Results must be walk-forward and must publish yearly returns plus the worst year, drawdown, Sharpe, turnover, costs, parameter sensitivity, and benchmark-relative statistics.
