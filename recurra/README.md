# Recurra — Subscription Tracker

Self-hosted web app to **track recurring subscriptions, upcoming payments, and spending across categories and currencies**.

Reimplemented from scratch with **original branding and content** on **Node.js (built-ins only) + SQLite + vanilla JS**, keeping the useful interaction patterns observed in Wallos (visual subscription list, dashboard, billing calendar, statistics, household/category/currency management, reminders, exchange-rate integration).

## Relationship to Wallos

- Upstream inspiration: [ellite/Wallos](https://github.com/ellite/Wallos) at commit `52820e87ca5a6e105fdbb7f1c0c681bc0cfee2fd` (reviewed), which is **GPL-3.0**.
- A pristine copy is kept at `../wallos/` for reference only; no Wallos code or assets are copied here.
- Because the product behaviour is derived from a GPL-3.0 work, **this app is also licensed GPL-3.0-only** — see `LICENSE.md`. See `ATTRIBUTION.md`.

## Features (parity with the brief)

- **Visual subscription list**: emoji avatar + colour, name, price, next payment, billing cycle (`Every N day(s)/week(s)/month(s)/year(s)` / One-time), category, household member, payment method, auto-renew / manual / inactive badges.
- **CRUD + renew**: add / edit / delete; “✔ Paid” advances `next_payment` by its cycle (Wallos `updatenextpayment` behaviour).
- **Dashboard**: upcoming payments, overdue manual renewals, monthly / yearly / per-day cost, inactive savings, monthly budget bar, calendar peek.
- **Billing calendar**: month grid projecting every occurrence (days / weeks / months / years logic, one-time exact date, `start_date` respected), with monthly totals and still-due amounts.
- **Statistics**: totals, average, most/cheapest, splits by category / member / payment method / cycle / currency, 12-month projection from real occurrences.
- **Categories, members, payment methods, currencies**: full management; currencies carry `rate_to_main` (main per 1 foreign) and convert all aggregates to the main currency.
- **Exchange-rate integration (optional)**: `POST /api/currencies/refresh` pulls live rates from `open.er-api.com` (no key); manual rates always work offline.
- **Payment reminders (optional integration)**: reminder window in settings + `GET /api/reminders?days=N` + in-app bell panel.
- **Search / filter / sort / views**: text search, category / member / state filters, sort by next payment / price / name, list / grid toggle (Wallos patterns).
- **Monthly normalisation**: `pricePerMonth` uses Wallos formulas (daily `30/f`, weekly `4.35/f`, monthly `1/f`, yearly `/(12·f)`, one-time `0`).

## Requirements

- Node.js ≥ 22 (uses built-in `node:sqlite`, `node:http` — **no `npm install` needed**)
- No PHP, Docker, or external services required.

## Run

```sh
cd recurra
node server.js            # http://localhost:8282
PORT=3000 node server.js  # custom port
node server.js --seed     # reseed demo data and exit
```

Open `http://localhost:8282`. Demo data is seeded on first run (dates relative to today so upcoming/calendar/reminders work immediately).

## API

| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/overview` | dashboard aggregates |
| GET/POST | `/api/subscriptions` | `?search&category&member&payment&state&sort&order` |
| GET/PUT/DELETE | `/api/subscriptions/:id` | full update |
| POST | `/api/subscriptions/:id/renew` | advance `next_payment` |
| GET | `/api/stats` | totals + splits + 12-mo projection |
| GET | `/api/calendar?year&month` | projected occurrences |
| GET | `/api/reminders?days=` | due within window |
| GET/POST | `/api/categories` `/api/members` `/api/payment-methods` `/api/currencies` | lookups |
| PUT/DELETE | `…/:id` | edit / delete (blocked while in use) |
| GET/PUT | `/api/settings` | `main_currency_id, monthly_budget, reminder_days, show_monthly_price, convert_currency` |
| POST | `/api/currencies/refresh` | live rates via open.er-api.com |
| POST | `/api/reset` | reseed demo dataset |

Currencies: `rate_to_main` = units of main currency per 1 unit of this currency (main = 1).

## Data

SQLite file: `data/recurra.db` (auto-created; WAL mode). Delete it to start empty — it reseeds on next boot. Single-household model (Wallos multi-user login intentionally simplified for this rebuild).

## Scripts

- `npm start` → `node server.js`
- `npm run test:api` → boots the server on an ephemeral port and checks health/overview/subs/stats/calendar/reminders.

## License

GPL-3.0-only. See `LICENSE.md` and `ATTRIBUTION.md`.
