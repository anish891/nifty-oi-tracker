# Nifty OI Tracker — Live Change in OI Dashboard

A live, auto-refreshing Nifty 50 option chain dashboard showing Change in OI for ±10 strikes around the current ATM strike. Data is pulled directly from NSE India's API.

## Features
- **Real NSE data** — fetches from `nseindia.com` API, same source as Sensibull/NiftyTrader
- **Auto-refresh** — 3s / 5s / 10s / 30s options
- **Change in OI** with inline bar charts for both calls and puts
- **Buildup detection** — Long Buildup, Short Buildup, Long Unwinding, Short Covering
- **PCR bar** — real-time put-call ratio with sentiment indicator
- **Expiry selector** — switch between weekly / monthly expiries
- **All key metrics** — Spot, ATM, PCR, Max Call OI strike (resistance), Max Put OI strike (support)
- **Sortable columns** — click any column header to sort

---

## Deploy to Vercel (free, takes 3 minutes)

### Step 1 — Push to GitHub
```bash
# If you don't have git initialized:
git init
git add .
git commit -m "initial"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/nifty-oi-tracker.git
git push -u origin main
```

### Step 2 — Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → Sign up / Log in
2. Click **Add New Project**
3. Import your GitHub repo
4. **No env variables needed** — just click **Deploy**
5. Done! You'll get a URL like `https://nifty-oi-tracker.vercel.app`

---

## Run locally (for testing)
```bash
npm install
npm start
# Open http://localhost:3000
```

---

## How it works

```
Browser  →  /api/option-chain  →  NSE India API
             (your Vercel backend adds proper headers & cookies)
```

NSE blocks direct browser requests (CORS). The backend proxy:
1. Fetches a session cookie from `nseindia.com`
2. Uses that cookie + browser-like headers to call the NSE option chain API
3. Parses and returns clean JSON to your frontend
4. Caches for 5 seconds to avoid hammering NSE

---

## Notes
- NSE API is only live during market hours (9:15 AM – 3:30 PM IST on weekdays)
- Outside market hours, NSE returns the last EOD snapshot
- If NSE blocks requests temporarily, you may see an error — it auto-retries

---

## History & persistence (optional but recommended)

Each time NSE publishes a new option-chain snapshot (~once a minute) the server stores a compact copy
(series point + per-strike OI/price/IV). That powers the **Intraday Timeline** chart, the 5m/15m rate-of-change
figures (which now survive a page refresh), and end-of-day **session summaries** used by
"Sessions That Looked Like Today" and the IV z-score.

Storage is **Upstash Redis over REST** (no connection pool, no extra dependency):

1. Vercel → your project → **Storage / Marketplace → Upstash Redis → Create** (free tier is plenty:
   ≈1–2 KB per snapshot, ~400 snapshots per trading day).
2. Vercel injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
3. Redeploy. The chip on the timeline card switches from `History: in-memory` to `History: saved`.

Without those variables the app still works; history just lives in memory and disappears on restart / cold start.
Check status any time at `/api/storage-status`.

**Recording while nobody has the page open.** Snapshots are recorded whenever someone's browser polls, and also by
`GET /api/cron/snapshot` — hit it every minute during market hours (09:15–15:30 IST, Mon–Fri) from an external pinger
(e.g. cron-job.org) or Vercel Cron on a plan that allows per-minute crons (Hobby only allows daily). Set `CRON_SECRET`
to require `Authorization: Bearer <secret>` (or `?key=<secret>`).

### Using the history

- **Replay slider** (under the Intraday Timeline): drag through the stored day and the OI-by-strike chart redraws as it looked at that minute. *Back to live* (or `L`) returns.
- **Strike detail**: click a strike in the option chain, or a bar in the OI chart, to see that strike's call/put OI, premium and IV across the session.
- **Shareable links**: the expiry, OI view and timeline overlay are kept in the URL, e.g. `/?expiry=13-Oct-2026&view=m15&overlay=vix`. An expiry that no longer exists is ignored.
- **Data-health chips** in the top bar show whether NSE data is fresh and whether VIX, previous-session pivots and persistent history are actually available (hover for details).
- **Keyboard**: `R` refresh · `A` alerts · `G` greeks · `T` theme · `L` back to live · `?` help · `Esc` close panels.

Optional env: `NIFTY_LOT_SIZE` (GEX scaling, default 65), `RISK_FREE_RATE` (default 0.065).

---

## File structure
```
nifty-oi-tracker/
├── api/
│   └── index.js        ← Backend proxy (runs on Vercel serverless)
├── public/
│   └── index.html      ← Frontend dashboard
├── package.json
├── vercel.json         ← Vercel routing config
└── README.md
```
