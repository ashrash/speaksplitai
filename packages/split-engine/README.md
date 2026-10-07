# @speaksplit/split-engine

Pure, deterministic TypeScript used by the mobile app, the web pay page and the API. No runtime
dependencies.

| Module        | What it does                                                                            |
| ------------- | --------------------------------------------------------------------------------------- |
| `currency.ts` | Supported ISO 4217 currencies and their minor units (mirrors the `currencies` table)    |
| `decimal.ts`  | Exact decimal parsing and rounding on `bigint` (half-even, half-up, truncate)           |
| `money.ts`    | Major ↔ minor units (`toMinor`, `formatMinor`) and currency conversion (`convertMinor`) |
| `allocate.ts` | Largest-remainder allocation: parts always sum to the total, each within one unit       |
| `splits.ts`   | Equal, exact, percent, shares and adjustment splits                                     |
| `balances.ts` | Net balance per member and currency; pairwise "who owes whom" without simplification    |
| `simplify.ts` | Fewest transfers to settle everyone, per currency (exact for up to 16 people)           |

Amounts are integers in the currency's minor unit (`MinorUnits`). Percentages, shares and rates
are passed as decimal strings (or plain JS numbers, read as the decimal written) and never go
through floating-point arithmetic.

Still to do: itemised splits (line items, tax and tip).
