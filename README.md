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
- The proxy does NOT store any data; it's a pure passthrough

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
