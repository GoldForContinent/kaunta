# Kaunta — Bar Ledger (offline-first PWA + Cloudflare backend)

Kaunta is a **bar point-of-sale ledger** for small bars in Kenya. It is designed to work
when a bar's Wi-Fi is weak or down: every tap is recorded instantly on the phone and
synced to the cloud the moment a connection exists.

**One sentence version:** a cashier opens `kaunta.html` on their phone, taps drinks as
they are served (cash, M-Pesa, or "deni" = on credit), the app stores every sale on the
phone first and syncs to the cloud when online. The owner opens `owner.html` to see live
totals, debts and top drinks, and pays a monthly subscription via M-Pesa to keep the bar
account unlocked.

---

## 1. From idea to implementation (how this fits together)

The design was built around three real-life constraints for a small Kenyan bar:

| Constraint | Solution chosen |
|---|---|
| Bars often have bad / no internet | **Offline-first**: sales are written to the phone (`localStorage` "outbox") and pushed later. Nothing is lost and nothing double-counts. |
| Hiring/hosting servers is expensive | **100% on the free Cloudflare tier**: Workers (code) + D1 (SQL database) + Pages (static site). No VM, no monthly bill to start. |
| Most people won't register a payment API | **Two payment modes**: full M-Pesa Daraja STK push (auto) **or** a "manual" mode (owner pays a Till number and types the M-Pesa code) that works with *zero* configuration. |

Everything runs with three pieces:

```
   FRONTEND (your phone)                BACKEND (the API)                 DATABASE
   ─────────────────────                ──────────────────                ────────
   kaunta.html   (counter)       ──►    Cloudflare Worker          ──►    Cloudflare D1
   owner.html   (dashboard)             server/src/index.js                (SQLite: bars,
   sw.js       (offline)                auth · sync · summary · pay        sales, debts,
   manifest  (installable)              HTTPS + CORS handled               subscriptions)
   (hosted on Cloudflare Pages)                 │
                                              M-Pesa Daraja (Safaricom) ←→ phone PIN prompt
```

- **The phone app** is a *static* website — no app store, no framework, just HTML/JS.
  For PWA installability it needs to be served over **HTTPS** with a manifest + service
  worker, which is why it lives on **Cloudflare Pages** (`https://kaunta.pages.dev`).
- **The API** is one Cloudflare **Worker** (JavaScript), which talks to the **D1**
  database and to **Safaricom's M-Pesa** API when money is involved.
- Staff phones and the owner's phone share one bar through a **join code**; the server
  is the single source of truth once syncs happen.

---

## 2. How a single "tap" travels through the system

```
1. Cashier taps "Tusker — 150 cash" on kaunta.html
2. App creates an op:  { type:'sale', drink:'d-Tusker', qty:1, price:150,
                         pay:'cash', oid:'unique-op-id' }
3. App saves the op to the phone's OUTBOX (localStorage)     <-- works offline
4. When online, sync() POSTs the outbox to  /api/op
5. Worker checks the bar's subscription:
      • suspended  -> 402, app shows "Pay to continue"
      • otherwise  -> apply
6. Worker runs the op inside ONE batched transaction:
      • insert into `changes` (append-only log, newest row gets seq N+1)
      • update `sales` / `debts` / `drinks` state tables
7. Worker replies with { ok, subscription, ... }
8. App clears the op from the outbox and remembers last_seen seq
```

**Why nothing double-counts:** every op carries a client-generated `oid`. The database has
a UNIQUE index on `(bar_id, oid)`, so if the phone retries the same sync five times, the
op is applied exactly once.

**How other screens stay in sync:** every synced op is saved in the `changes` table with an
auto-incrementing `seq`. Any device can call `/api/sync` with `last_seq` and receive
everything newer than it — `changes: [{seq, type, payload}, …]`.

### Money (subscription) flow

Accounts get a **30-day free trial**. Before the trial (or a paid period) ends the bar is
in a *grace* of 7 days; after that the API returns `402` and sales are blocked until the
owner pays **KES 500/month**:

- **Auto mode (Daraja keys configured):** owner taps "Pay" → `pay/request` → Safaricom STK
  push → customer enters PIN on the phone → Safaricom calls back
  `POST /api/pay/callback` → worker marks the payment paid and extends
  `current_period_end` by 30 days.
- **Manual mode (no keys set — works out of the box):** the app shows the owner's Till
  number + account number, he pays manually, then **verifies** by pasting the M-Pesa
  transaction code → `pay/verify` (idempotent per code) credits the month.

The trial/active/grace/suspended state is **computed in code** (`util.js subState()`),
not stored — so it can never drift out of date.

---

## 3. Project layout

```
pubmanager/
├─ public/              ★ the website (what Cloudflare Pages serves)
│  ├─ index.html           Marketing homepage (hero, features, pricing, FAQ)
│  ├─ kaunta.html          Counter app (markup + JavaScript) — used by staff, PWA entry
│  ├─ owner.html           Owner dashboard (login, live summary, pay)
│  ├─ admin.html           Systems console (operator only: bars, renews, payments, announcements)
│  ├─ sw.js                Service worker: caches the app for offline, network-first pages
│  ├─ manifest.webmanifest PWA manifest (name, icons, start_url, standalone)
│  └─ icon.svg / icon-*.png  App icons (192, 512, maskable)
├─ .gitignore           Not uploading node_modules / .wrangler
├─ README.md            This file
└─ server/              The Cloudflare backend (deployed as a Worker)
   ├─ wrangler.toml     Worker config + D1 binding + M-Pesa env vars
   ├─ package.json      npm scripts: dev / deploy / migrate
   └─ src/
      ├─ index.js       The router — every public URL maps to a handler here
      ├─ auth.js        Register, login, logout, bearer-token auth middleware
      ├─ sync.js        /api/op + /api/sync (offline queue replay + seq pull), subOf()
      ├─ summary.js     /api/summary (owner dashboard single pull)
      ├─ billing.js     M-Pesa: payInfo / payRequest / payCallback / payVerify
      ├─ admin.js       /api/admin/* — stats, bars, renew, status, price, payments, announcements
      ├─ util.js        json(), CORS, uuid, token, PBKDF2 password hash, subState()
      ├─ 0001_init.sql  D1 schema (migration #1)
      └─ 0002_announcements.sql  Global announcements table (migration #2)
```

---

## 4. Database schema (D1 = SQLite, runs on Cloudflare)

| Table | Holds |
|---|---|
| `users` | People. `role` = `owner` or `staff`, each linked to one `bar_id` |
| `bars` | One bar per account: name, unique `slug`, 6-digit `join_code` |
| `subscriptions` | `trial_ends_at`, `current_period_end`, `price_cents` (50000 = KES 500) |
| `payments` | Ledger of money received: `mpesa_ref`, `checkout_id`, `status` |
| `sessions` | Bearer tokens (SHA-256 hash of token), 90-day expiry |
| `changes` | **Append-only sync log** — `seq` autoincrement, `oid` dedupe index |
| `drinks` | Drink catalogue + sizes, prices (full/half/quarter), `soldMl` |
| `sales` | Every sale row |
| `debts` / `regs` | "Deni" balances and the regulars who owe them |
| `bar_meta` | Shift-open timestamp, last-sync time |
| `announcements` | Global broadcasts shown in every bar's app (`bar_id NULL` = all bars) |

The full file is `server/src/0001_init.sql`.

---

## 5. API endpoints

Auth = `Authorization: Bearer <token>` (obtained from `/api/login`). Everything except the
public routes below requires it.

| Method & path | Auth | Purpose | Notes |
|---|---|---|---|
| `POST /api/register` | — | Owner signup **or** staff join (with `code`) | Owner signup creates a bar + 30-day trial sub |
| `POST /api/login` | — | Returns `{ token, user }` | PBKDF2 check, hashed session, 90 days |
| `POST /api/logout` | ✔ | Deletes session | |
| `GET /api/me` | ✔ | Current user + bar | |
| `POST /api/op` | ✔ | Apply offline sale/debt ops | Idempotent by `oid`; `402` if suspended |
| `POST /api/sync` | ✔ | Send ops + pull changes since `last_seq` | Returns `{ changes, max_seq, subscription, regs }` |
| `GET /api/summary?from&until&tz` | ✔ (owner) | Totals, hourly, top drinks, debts, feed, regs | One pull for the dashboard |
| `GET /api/pay/info` | ✔ | Price + payment `mode` (`manual` or `stk`) | |
| `POST /api/pay/request` | ✔ (owner) | Start payment | STK push, or returns manual steps |
| `POST /api/pay/callback` | — | Safaricom webhook callback | Public, from M-Pesa |
| `POST /api/pay/verify` | ✔ (owner) | Verify a manual M-Pesa code | Idempotent per `mpesa_ref` |
| `POST /api/change-password` | ✔ | Change your own password | Requires `current_password` + `new_password` (≥6); PBKDF2 re-hash. Settings → Change password in the app |
| `GET /api/announcements` | — | Latest **active global announcement** | Public; every app reads it |
| `GET /api/admin/stats` | ✔ (admin) | Platform overview: subscription counts, revenue, today | Role-gated to `admin` |
| `GET /api/admin/bars?q=` | ✔ (admin) | Bars directory with search + subscription state | × |
| `POST /api/admin/renew` | ✔ (admin) | Gift days to a bar (`bar_id`, `days`) | Extends from now / period end |
| `POST /api/admin/status` | ✔ (admin) | `trial` / `activate` / `suspend` a bar | × |
| `POST /api/admin/price` | ✔ (admin) | Change a bar's monthly price (`price_ksh`) | × |
| `GET /api/admin/payments?n=` | ✔ (admin) | Payments ledger across all bars | × |
| `GET /api/admin/announcements` | ✔ (admin) | List announcements | × |
| `POST /api/admin/announce` | ✔ (admin) | Post a global announcement (`body`) | Shows in every app |
| `POST /api/admin/announce/delete` | ✔ (admin) | Delete an announcement (`id`) | × |
| `POST /api/admin/reset-password` | ✔ (admin) | Reset any account's password (`email`, optional `new_password`) | For forgotten passwords; auto-generates a temp password if none given. Hand it to the owner |
| `GET /health` | — | Liveness probe | |

---

## 6. First-time deployment (the babysteps path)

You need: **Node.js 18+** (has npm), a free **Cloudflare account**, and the phone you'll
install the app on. No credit card required.

### Part A — Get the database online (Cloudflare D1)

All commands below run inside the `server/` folder.

```powershell
cd server
npm install                      # 1. installs wrangler (the Cloudflare CLI)
npx wrangler login               # 2. opens a browser to log into your Cloudflare account
npx wrangler d1 create kaunta    # 3. creates the database (SQLite) in the cloud
```

Step 3 prints a **database_id** (a UUID). Open `server/wrangler.toml` and replace the
placeholder:

```toml
database_id = "replace-with-your-d1-database-id"   # ← paste your real UUID here
```

Then create the tables (this runs `src/0001_init.sql`):

```powershell
npm run migrate                  # = wrangler d1 migrations apply kaunta --remote
```

You can peek at the database from your browser dashboard: **Workers & Pages → D1 →
kaunta → Console**.

### Part B — Get the API online (Cloudflare Workers)

```powershell
npm run deploy                   # uploads server/src to a Cloudflare Worker
```

When it finishes wrangler prints your API URL (this project's live URL):

```
https://kaunta-api.kaunta-api.workers.dev
```

Test it (a green `{"ok":true,"ts":...}` means the worker is alive):

```
https://kaunta-api.kaunta-api.workers.dev/health
```

> **Important:** the frontend needs to know this URL. This project already has it baked in:
> - `public/kaunta.html` → `DEFAULT_API`
> - `public/owner.html` → `API_BASE` fallback
> - `server/wrangler.toml` → `[vars] DARAJA_CALLBACK_URL` (used by M-Pesa)
>
> You can also set the API URL later **inside the app** without editing files:
> kaunta.html → settings (🔧) → "API URL" → Save server.

### Part C — Get the site online (Cloudflare Pages) → this is the installable **link**

The phone app is a *static* site, so it goes on Cloudflare **Pages** (free static hosting
that must be HTTPS for PWA install). The site files live in the **`public/`** folder.

**Way 1 — CLI (one command):** create the project once, then deploy the folder:

```powershell
npx wrangler pages project create kaunta --production-branch main --force
npx wrangler pages deploy public --project-name kaunta --branch main
```

> Pages *deploy* needs an API token:
> `$env:CLOUDFLARE_API_TOKEN = "<your token>"` (create one at
> dash.cloudflare.com/profile/api-tokens using the "Edit Cloudflare Workers" template).
> Alternatively log in with `npx wrangler login` if your wrangler version accepts it.

**Way 2 — dashboard (no CLI):** **Workers & Pages → Create → Pages → Upload assets** →
drag the **8 files inside `public/`** (`kaunta.html`, `owner.html`, `sw.js`,
`manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png`,
`icon-512-maskable.png`) → Deploy.

**Way 3 — git (auto-deploy on push, optional):** repository is at
`https://github.com/GoldForContinent/kaunta`. In **Workers & Pages → Create → Pages →
Connect to Git** pick the repo, set **Build command: (blank)** and **Build output
directory: `public`**, then Save & Deploy. Every `git push` to `main` redeploys the site.

Either way you get:

```
https://kaunta.pages.dev                       (production on branch `main`)
```

> Don't upload the `server/` folder to Pages — it contains the API source; the API lives
> separately on the Worker, deployed from `server/` with `npm run deploy`.

### Part D — Install it as a PWA on the phone (the "link first" part)

1. Open the Pages URL (`https://kaunta.pages.dev/kaunta.html`) **in the phone browser** —
   Android Chrome or iOS Safari.
2. Register the owner account (email + password + bar name) from the counter app, **or**
   log in.
3. Make sure Settings → API URL points at your Worker URL.
4. Android Chrome: **⋮ → "Add to Home screen"** / chrome shows an **Install app** prompt.
   iOS Safari: **Share → Add to Home Screen**.
5. The app now opens full-screen from the home screen and works offline (the outbox
   keeps collecting and syncs later).

**Why you need the link first:** a PWA cannot be "sent" like an app; the phone must open
the HTTPS site once, then Chrome/Safari lets you add it to the home screen.

### Part E — (optional) custom domain

- Adds a nicer address: **Pages → your project → Custom domains → Set up a custom domain**.
- Update the `DARAJA_CALLBACK_URL` and the API URL in the frontend to match.

### Part F — (optional) real M-Pesa payments (Daraja STK push)

Out of the box the app runs in **manual mode** (owner pays a Till, then verifies a code),
which needs **no setup at all**. To switch on automatic STK push you need Safaricom Daraja
credentials, configured in `wrangler.toml` (or in the dashboard → Worker → Settings →
Variables):

```toml
vars.MPESA_ENV = "sandbox"            # or "production"
vars.MPESA_CONSUMER_KEY = "…"
vars.MPESA_CONSUMER_SECRET = "…"
vars.MPESA_PASSPHRASE = "…"           # the passphrase for the STK password hash
vars.MPESA_TILL = "123456"            # your paybill / till number
vars.DARAJA_CALLBACK_URL = "https://kaunta-api.kaunta-api.workers.dev/api/pay/callback"
vars.MPESA_MANUAL_ALLOW = "1"         # keep manual-pay verification too
```

Test in **sandbox** (`MPESA_ENV = "sandbox"`) first, then switch to production.
Once keys are present AND `MPESA_TILL` is set, the `/api/pay/info` endpoint reports
`mode: "stk"` automatically.

---

## 7. Development workflow (run it on your PC first)

```powershell
cd server
npx wrangler login
npx wrangler d1 migrations apply kaunta --local    # build a local D1 copy
npm run dev                                        # → http://localhost:8787
```

- Point the frontend at it: kaunta.html → settings → API URL →
  `http://localhost:8787` (works because localhost is treated as secure).
- Because you haven't set M-Pesa keys locally, the app uses **manual mode** — fine for
  testing the full ledger, sync and subscription flow.
- Every time the database schema changes, add a *new* numbered file
  (`0002_….sql`) and `npm run migrate`.

---

## 8. Environment variables (wrangler.toml `vars`)

| Variable | Purpose | Default / notes |
|---|---|---|
| `MPESA_ENV` | `sandbox` vs `production` | Unset → manual-mode pay |
| `MPESA_CONSUMER_KEY` | Daraja API key | Unset → manual-mode pay |
| `MPESA_CONSUMER_SECRET` | Daraja API secret | |
| `MPESA_PASSPHRASE` | STK password hash passphrase | |
| `MPESA_TILL` | Paybill / till shortcode | Unset → manual-mode pay |
| `DARAJA_CALLBACK_URL` | Where Safaricom calls back | Your Worker + `/api/pay/callback` |
| `MPESA_MANUAL_ALLOW` | Allow manual-code verification even in STK mode | set to `"1"` to enable |

---

## 9. Concepts in one minute (Cloudflare for total beginners)

- **Cloudflare Workers** — code that runs on Cloudflare's edge network when a URL is hit.
  No server to rent; free tier included. Your whole backend is `server/src/*.js`.
- **Cloudflare D1** — a real SQL (SQLite) database that lives in the cloud, accessed from
  the Worker through `env.DB` with `.prepare("…").bind(…).first()/.all()/.run()/.batch()`.
- **Cloudflare Pages** — free static website hosting (this hosts `kaunta.html` + friends)
  and is always HTTPS — required before a phone will install a PWA.
- **PWA (Progressive Web App)** — a website that can be "installed" to the home screen.
  Ingredients: HTTPS + `manifest.webmanifest` + `sw.js` (service worker).
- **Service worker (sw.js)** — a background script the browser keeps, that caches files
  for offline use and answers network requests (here: network-first for pages, cached
  fallback when offline, API calls never cached).
- **localStorage** — simple persistent storage on the phone. Kaunta keeps its *outbox*
  here so sales survive being offline.
- **Bearer token** — the secret you send after login (`Authorization: Bearer …`) so the
  API knows who you are. Stored hashed in `sessions`.
- **Idempotent** — an operation that is safe to repeat. The `oid` + UNIQUE index guarantee
  retrying a sync never double-sells a beer.
- **Migration** — a numbered `.sql` file describing schema changes, applied in order.
- **STK push** — Safaricom's "send a prompt to the phone to enter your PIN" service.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| App says "no-server" / login fails | API URL not set. Settings → API URL → your Worker URL, save. |
| **CORS** error in browser console | You called the API from a different origin; worker adds CORS headers automatically — make sure you hit the real worker and not `localhost` when deployed. |
| Signup works but dashboard says 402/suspended | Trial/grace ended, or `current_period_end` unset — pay via manual mode or STK. (A **fresh** account always gets a 30-day trial.) |
| `npm run migrate` finds nothing | The migration file must be numbered, e.g. `0001_init.sql` (this repo already is). |
| `wrangler d1 create`/`deploy` fails | Not logged in (`npx wrangler login`) or the placeholder `database_id` was not replaced. |
| PWA won't install | Must be opened over **HTTPS** on the phone; keep the `manifest` + `sw.js` intact; use a browser that supports PWAs. |
| M-Pesa "did not accept the request" | `MPESA_TILL` / passphrase mismatch, or `DARAJA_CALLBACK_URL` is not a real reachable HTTPS URL; test in sandbox first. |

---

## 11. The whole picture in three sentences

1. **Idea:** let a small bar record every sale instantly and never lose data, even with no
   internet, and let the owner watch the money from anywhere.
2. **Build:** a phone-first PWA (`kaunta.html`/`owner.html`) writes every action to an
   offline outbox; a Cloudflare Worker applies them idempotently to a D1 database and
   syncs every device by sequence number; a subscription gate (trial → KES 500/month via
   M-Pesa, auto STK or manual code) protects the service.
3. **Run:** deploy the Worker (`npm run deploy`) → deploy the static site to Cloudflare
   Pages → open the `pages.dev` link on the phone → "Add to Home Screen" → done. The
   phone app and API keep talking over HTTPS with CORS handled, and everything is on the
   free Cloudflare tier until your bars grow.
```