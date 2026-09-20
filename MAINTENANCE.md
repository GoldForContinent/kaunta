# Kaunta — MAINTENANCE.md (read me before every change)

**Who this is for:** you (the owner) working together with AI coding agents and the
Cloudflare CLI. This is your step-by-step manual for changing the **code**, the
**database**, or the **Cloudflare config** — safely, without breaking the app for
clients who are waiting at the counter.

---

## 1. The 5 golden rules (never skip)

1. **Never edit code in the Cloudflare dashboard.** The dashboard is for viewing and
   config only. All code lives on your PC and in GitHub.
2. **Every change goes: PC → GitHub → Cloudflare.** If it's not in git, it's not real.
3. **The database only ever moves forward.** Never edit or rename an already-applied
   migration file. Add a **new** numbered one (`0002_…`, `0003_…`).
4. **Test with the test account, not your real bar.** The test account
   (email `test@kaunta.dev`, password `test1234`) was created for this — your real
   clients' data stays untouched.
5. **If it breaks, roll back. Don't panic-fix live.** Cloudflare keeps the previous
   Worker version and automatic database backups. Restore = 1 click. (Details in §6.)

---

## 2. Where things live

| Folder / file | What it is | How it changes |
|---|---|---|
| `public/` | The **website** clients use (installed as a PWA on phones) | Edit → deploy to Pages |
| `public/index.html` | Marketing homepage (`https://kaunta.pages.dev/`) | Edit → deploy to Pages |
| `public/admin.html` | **Systems console** (operator only) | Edit → deploy to Pages |
| `server/src/*.js` | The **API logic** (runs as a Cloudflare Worker) | Edit → deploy the Worker |
| `server/src/admin.js` | Systems-admin API (stats, bars, renew, price, payments, announcements) | Edit → deploy the Worker |
| `server/wrangler.toml` | Worker config + D1 binding + env vars | Edit → redeploy the Worker |
| `server/scripts/create-admin.mjs` | Creates a systems-admin account (PBKDF2 matching the API) | run + `d1 execute` |
| `server/src/0001_init.sql` | Database schema (migration #1) | ❌ never edit — see §5 |
| `server/src/0002_announcements.sql` | Migration #2 — `announcements` table (global broadcasts) | apply via `npm run migrate` |
| GitHub repo | `https://github.com/GoldForContinent/kaunta` | your history + backup |

Live addresses (already deployed):
- Website: `https://kaunta.pages.dev` (homepage) → `…/kaunta.html` (counter), `…/owner.html` (owner), `…/admin.html` (systems)
- API: `https://kaunta-api.kaunta-api.workers.dev`
- Database: D1 `kaunta` in your Cloudflare account

---

## 3. Giving the agent access to Cloudflare (do this at the START of every session)

AI sessions don't remember each other, so **every** time you start working with an agent
you must re-grant access. Two pieces, both quick:

### 3a. The API token (needed for deploying the website AND database commands)

1. Open `https://dash.cloudflare.com/profile/api-tokens`
2. **Create Token → "Edit Cloudflare Workers" template → Continue → Create Token**
3. **Add the D1 permission too:** on the token's permission list add
   `Account → D1 → Edit` (also enables `npm run migrate` + `d1 execute`, which the
   Workers template alone does **not** include).
4. Copy the token. The agent needs it to run Pages deploys, `npm run migrate`, and
   `wrangler d1 execute`.

Where it's stored: it may survive as a file at
`C:\Users\ADMIN\AppData\Local\Temp\opencode\cf-token.txt`, but Windows can wipe that
folder. **Keep a personal copy** at `C:\Users\ADMIN\cloudflare-token.txt` so you always
have it and can hand it to the agent. It is high-access, so treat it like a password.

### 3b. The browser login (needed for the API + database commands)

In a terminal, once:
```powershell
cd C:\Users\ADMIN\OneDrive\Desktop\pubmanager\server
npx wrangler login        # opens the browser → log in → Allow
```

> **Why two methods?** In the current wrangler version:
> - `npm run deploy`, `npm run migrate`, and database queries work with the browser
>   login (OAuth).
> - Uploading the website to **Pages** insists on the API token (§3a) instead.

### What to paste to the agent to start a safe session
> "Open `MAINTENANCE.md` and follow the safety flow. I want to
> change **<what/where>**. When done, deploy it to Cloudflare — zero impact on live
> clients, test first."

---

## 4. Changing the website (files in `public/`)

**Good to know:** installing a phone PWA means old versions stay cached. A redeploy
doesn't instantly update every phone — that's normal; the service worker refreshes in
the background (network-first), and users see the new version on their next open.

1. **Edit the file(s)** in `public/` (e.g. `kaunta.html`, `owner.html`, `sw.js`).
2. **Commit + push to GitHub** (your safety net):
   ```powershell
   cd C:\Users\ADMIN\OneDrive\Desktop\pubmanager
   git add -A
   git commit -m "change: describe it here"
   git push
   ```
3. **Deploy the site** (from the repo root):
   ```powershell
   $env:CLOUDFLARE_API_TOKEN = "<your token from §3a>"
   cd server
   npx wrangler pages deploy ..\public --project-name kaunta --branch main
   ```
4. **Verify:** open `https://kaunta.pages.dev/kaunta.html` and check the change.

> Optional upgrade (avoids step 3 forever): connect the GitHub repo in **Workers & Pages →
> Create → Pages → Connect to Git** (output dir `public`, build command blank). Then any
> `git push` auto-deploys the site.

---

## 5. Changing the database (schema)

**The only rule: never touch an applied migration.** The database records which migration
files it has already run (`d1_migrations` table). Editing an old one makes the database
and the file disagree and can corrupt the schema.

### Add a new table / column (a real schema change)
1. Create a new file `server/src/0002_<what>.sql` (keep the `000N_` numbering), e.g.:
   ```sql
   -- 0002
   ALTER TABLE sales ADD COLUMN cashier_note TEXT DEFAULT '';
   ```
   (Inspect the existing schema in `server/src/0001_init.sql` for style.)
2. Check what's pending:
   ```powershell
   cd C:\Users\ADMIN\OneDrive\Desktop\pubmanager\server
   npx wrangler d1 migrations list kaunta
   ```
3. Apply **only the new** migration to the live database:
   ```powershell
   npm run migrate        # = wrangler d1 migrations apply kaunta --remote
   ```
4. Update the **code** to use the new column if needed (see §7), then redeploy the Worker.
5. Commit + push.

### One-off data fixes (no schema change)
Preview first, then run:
```powershell
npx wrangler d1 execute kaunta --remote --command "SELECT COUNT(*) FROM sales;"
npx wrangler d1 execute kaunta --remote --command "UPDATE bars SET name='My Bar' WHERE slug='test-bar-38cc';"
```

### Backups
- Every migration automatically takes a backup.
- Manual backup: **dash.cloudflare.com → Workers & Pages → D1 → kaunta → Backups →
  Create backup** (do this right before any risky change).
- Restore: same screen → pick the backup → **Restore**. This is your fastest escape.

### The systems admin console (`admin.html`)

An **operator** account (role `admin`, no bar) manages every tenant from
`https://kaunta.pages.dev/admin.html`. It can renew/gift days to any bar, reset trial,
activate, suspend, change a bar's price, see the payments ledger, and **broadcast an
announcement** that appears in every bar's counter app (`kaunta.html`) and owner
dashboard (`owner.html`).

**Forgotten passwords** are handled here too: each bar row has **Reset password…** — it
asks for the account email (and optionally a new password) and calls
`POST /api/admin/reset-password`. If no new password is given, one is auto-generated and
shown — the owner then **changes it in the app** (Settings → Change password, which hits
`/api/change-password` and requires the current password). There is no reset-by-email
flow; the admin is the recovery path.

Creating the admin account (hash matches the API's PBKDF2 exactly):
```powershell
$env:CLOUDFLARE_API_TOKEN = "<token with D1:Edit from §3a>"
cd C:\Users\ADMIN\OneDrive\Desktop\pubmanager\server
$sql = node scripts/create-admin.mjs admin@you.co.ke "your-password"
npx wrangler d1 execute kaunta --remote --command $sql
```
To remove a leaked admin: `npx wrangler d1 execute kaunta --remote --command "DELETE FROM users WHERE email='admin@you.co.ke';"`

> **Never edit `server/src/admin.js` to give regular owner/staff accounts admin power.**

---

## 6. Changing the API (files in `server/src/` or `wrangler.toml`)

1. **Edit** the JS files (or `wrangler.toml` env vars).
2. **Test locally first** (catches most mistakes):
   ```powershell
   cd C:\Users\ADMIN\OneDrive\Desktop\pubmanager\server
   npx wrangler d1 migrations apply kaunta --local   # build local copy of DB
   npm run dev                                       # API on http://localhost:8787
   ```
   Check `http://localhost:8787/health`. In the app settings you can point the API URL at
   `http://localhost:8787` for a full test. Stop with `Ctrl+C`.
3. **Commit + push** (same `git` steps as §4).
4. **Deploy the Worker** (takes ~10 seconds, live immediately):
   ```powershell
   cd C:\Users\ADMIN\OneDrive\Desktop\pubmanager\server
   npm run deploy
   ```
5. **Verify with a real request:**
   ```powershell
   curl.exe https://kaunta-api.kaunta-api.workers.dev/health
   ```
   Then register/login through the app with the test account.

### M-Pesa keys (env vars)
Never put real M-Pesa secrets in git. Change them in `wrangler.toml` **or** in the
dashboard: **Workers & Pages → kaunta-api → Settings → Variables**. Redeploy the Worker
afterwards. (Without keys the app just runs in manual-pay mode — it never breaks.)

---

## 7. The safe flow — combine the steps for a "both" change

When a change touches **code + database** (very common), do it in this order:

| # | Step | Command / Where | Why this order |
|---|---|---|---|
| 1 | Backup DB | dashboard → D1 → Backups | escape hatch |
| 2 | Write migration | `server/src/0002_….sql` | schema first |
| 3 | Apply migration | `npm run migrate` | live DB now matches code's expectation |
| 4 | Edit API code | `server/src/*.js` | then test |
| 5 | Run locally | `npm run dev` + test account | catch errors free |
| 6 | Commit + push | `git …` | history + auto-rollback point |
| 7 | Deploy Worker | `npm run deploy` | ~10s live |
| 8 | Deploy site (if frontend changed) | §4 step 3 | old app + new API = mismatch, so site last |
| 9 | Verify | `/health`, test account, real flow | confirm |

---

## 8. When something goes wrong (roll back quickly)

**Fear nothing — nothing is hard to undo here.**

| Problem | Fastest fix |
|---|---|
| API erroring (500s) after a deploy | **Roll back the Worker:** `dash → kaunta-api → Deployments → pick the previous version → ⋮ → Rollback to this version`. Or `npx wrangler rollback`. |
| New migration corrupted data | Restore the D1 backup taken right before (`D1 → kaunta → Backups → Restore`). |
| Website broke after a Pages deploy | Redeploy the previous `public/` from git (`git log` → prior commit) — §4 step 3. |
| Site still shows the OLD version | Phones cache; clear site data or wait — the service worker updates in the background. |
| `npm run dev` fails (workerd missing) | In `server/`, run `npm approve-scripts`, approve **workerd**, reopen a terminal, retry. |
| "Not logged in" from wrangler | `npx wrangler login` (from `server/`) for API/DB; API token (§3a) for Pages. |
| `/health` down / 523 | Check Worker logs: `npx wrangler tail --remote` or dashboard → kaunta-api → Logs. |

---

## 9. Cheat sheet (all the commands in one place)

```powershell
# one-time (per PC or new session)
npx wrangler login                                  # browser login for API/DB commands
$env:CLOUDFLARE_API_TOKEN = "<token>"               # needed for Pages deploy only

# deploy the website
npx wrangler pages deploy public --project-name kaunta --branch main

# deploy the API worker
npm run deploy                                      # from server/

# database
npm run migrate                                     # apply new migrations (remote)
npx wrangler d1 migrations list kaunta              # what's pending
npx wrangler d1 execute kaunta --remote --command "SELECT 1;"
npx wrangler d1 migrations apply kaunta --local     # local copy for dev

# test + logs
curl.exe https://kaunta-api.kaunta-api.workers.dev/health
npx wrangler tail --remote                          # live API logs

# git safety net
git add -A; git commit -m "describe change"; git push
```

---

## 10. Starting over on a fresh computer

1. Install Node.js from nodejs.org.
2. Clone: `git clone https://github.com/GoldForContinent/kaunta`
3. `cd server` → `npm install`
4. Do §3 (grant the agent access). **Do NOT re-run `d1 create` or `migrate` unless you
   want a fresh empty database** — the live DB already exists and is bound to the Worker.
5. Deploy the Worker once to refresh from your copy: `npm run deploy`.
6. Deploy the site: §4. Done.

---

### Final reminder for live deployments
- Small, single-purpose changes. One change → test → deploy → verify.
- Take a DB backup before any database work.
- Keep the test bar (`test@kaunta.dev`) as your practice ground — real clients' bar
  never gets touched by tests.
- If you're unsure about anything, follow this file top to bottom. Past the first
  success, this whole process takes under a minute per change.