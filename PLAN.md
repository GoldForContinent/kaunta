# Kaunta — Stock-take "expected amount", shifts & login-flow plan

Working plan. Status of each item is tracked with checkboxes; uncheck/check as we
build. Design discussions with the owner happened 2026-09-24.

---

## 1. The problem (owner words, confirmed)

1. When stock-taking, the app should show an **expected amount in shillings**, not
   just "bottles left".
2. The math is hard because **subdivision makes more money than selling whole**:
   a bottle sold whole = KES 140, but sold as 4 quarters @ 40 = KES 160. So
   "bottles gone × full price" is the wrong expected figure.
3. If stock runs out and is **refilled** mid-day, does the expected amount
   recalculate? (Yes — see §4.)
4. The login flow should make it obvious that the owner has their own dashboard and
   bartenders access the counter with a 6-digit code the owner provides.

### What bar owners will be happy about

All of these match real theft/liquidity problems they already solve on paper:
per-staff accountability (supermarket style), shift handover, an expected-money
range per drink, and shot-glass math for big bars. Two guard rails:

1. **Keep the bartender tap screen untouched** — counter stays "tap the drink, done".
   All math, ranges and reports live on the owner dashboard.
2. **Never make them type at stock-take except the physical count.** Everything else
   is derived automatically.

---

## 2. Expected amount — two numbers + a range

- Each drink gets an owner-set flag: **divisible** (spirits = yes, beer = no).
  Non-divisible drinks only ever show the "full" number.
- Per drink, compute:
  - **min** = bottles gone × full price
  - **max** = bottles gone × (units-per-bottle × smallest-unit price)
    e.g. 250 ml bottle, quarter @ 40 → 4 quarters × 40 = **160**; non-divisible
    drinks have min = max = full price.
- The owner sees a **range**, e.g. *"KES 560 – 640 expected · ledger shows KES 612"*.
  Inside the range = fine; outside = investigate.
- **Per-drink rows come first; the owner total is the sum of the per-drink
  calculations** (built from bottles stocked + refilled that day).

### 2a. Shots (big bars)

- Owner sets a **shot-glass size in ml** and a **shot price** per drink
  (e.g. 30 ml @ KES 80).
- App computes units per bottle: `750 ÷ 30 = 25 shots → 25 × 80 = 2000` expected if
  the whole bottle went in shots. Used as the divided-max when no half/quarter price
  is configured.
- Works alongside full/half/quarter prices — the divided-max uses whichever
  breakdown the owner set for that drink.

---

## 3. Refills

- `expected per drink = (opening + refills) × ml − counted ml`.
- Every refill is **logged with a qty and timestamp** ("Received stock" action), not
  just the `+` stepper.
- The range and per-drink money recalculate automatically on every change (they are
  derived, never stored).

---

## 4. Shifts & handover

- **All sales carry the logged-in bartender id.** Today `sales.who` is only filled
  for debts; extend it so every sale records `who` automatically (no extra tapping).
- New **shift open / close** ops (`set_shift`):
  - "Start shift" → staff id + timestamp.
  - "Hand over" → close time + per-drink counted stock + cash totals recorded.
- Owner dashboard shows a **per-shift report**: who sold what, cash in drawer,
  expected vs counted variance.
- `bar_meta.open` already exists; extend it into a proper `shifts` table
  (shift_id, staff id, open_at, close_at, counts) synced like every other op.

---

## 5. Refill / expected-money note (question 3 answered)

Expected **money** = sum of recorded sales (cash + M-Pesa + deni). Refills never
change expected money — they only add sellable ml. Expected **stock** =
(opening + refills) × ml − soldMl, which already recomputes because it is derived.

---

## 6. Login flow

- `kaunta.html` gate: clearly split **"I'm the owner"** vs **"I'm a bartender —
  join with the 6-digit code from my owner"** (currently a buried signup toggle).
- `owner.html` gate: state staff use the Kaunta counter + join code; this screen is
  owner-only.
- Owner dashboard: show the **join code prominently** (today it is only in
  Settings → /api/me).

---

## 7. Data model & file changes (draft)

### Ops / state

| Change | From | To |
|---|---|---|
| `sales.who` | deni only | every sale (staff id) |
| `drinks.divisible` | — | new flag (1/0) |
| `drinks.shot_ml` | — | new, ml per shot (0 = off) |
| `drinks.shot_price` | — | new (0 = off) |
| `drinks.open` | opening bottles (stepper) | opening + refills; keep refill history |
| `bar_meta.open` | shift-open ts | shift open/close via `shifts` table |
| `changes.type` | … | add `set_shift`, `restock`, `set_drink_flags` |

### New server pieces

- `shifts` table (migration `0003_shift.sql`): shift_id, bar_id, user_id, open_at,
  close_at, close_counts (JSON of counted bottles), close_cash.
- New ops in `sync.js` `applyStatements()` / `TYPES`:
  `set_shift`, `restock` (drink, qty, ts), `set_drink_flags`.
- `summary.js` (owner dashboard): per-drink expected gap (min/max/ledger),
  per-drink stock count, per-shift report endpoint/data block.

### New frontend pieces

- `kaunta.html`:
  - Stock view: "Received stock" action with qty + time log.
  - Shift: "Start shift" / "Hand over" controls.
  - Sale op includes `who` = current staff id automatically.
  - Gate login: clear owner vs bartender paths.
- `owner.html`:
  - Stock-take / cash-up card: enter physical remaining count → per-drink
    min/max/ledger + owner total range.
  - Per-shift report card (staff totals, variance).
  - Drink editor: divisible flag, shot ml + shot price.
  - Join code shown on the dashboard header.

---

## 8. Suggested build order

- [ ] **Part A** — two-amounts + range + shots math (core): drink flags, shot
      fields, per-drink calculation, stock-take cash-up screen, owner total range.
- [ ] **Part B** — refills: "Received stock" action, restock log, auto-recalc.
- [ ] **Part C** — shifts: per-sale `who`, `set_shift` op, `shifts` table,
      per-shift report, handover UI.
- [ ] **Part D** — login flow copy + join code visibility.
- [ ] Tests / migration `0003` + `npm run migrate`.

---

## 9. Open questions (ask owner)

1. When a drink has both quarter price and shot price set, which one is the
   "divided max" — the higher, or owner-picked?
2. Deni sales: subtract from cash expectation or show separately in the range?
3. Handover: physical cash count entered by the outgoing bartender or by the
   receiving one?