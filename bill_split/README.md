# MoneySplit — Frontend

The web UI for MoneySplit: scan a receipt, mark which columns are the item names and prices, assign items to whoever ordered them, and see what everyone owes (including tax and tip).

Built with [Next.js](https://nextjs.org) (App Router) and TypeScript. This is the frontend half of the app — it talks to a separate FastAPI + RapidOCR backend (in `../backend`) that does the actual receipt scanning. Both need to be running for the app to work.

## How it works

1. **Set up your split** (`/`) — add participants, then upload a PDF or photo of a receipt. Draw boxes around the item-name column and the price column (and optionally tax/tip/fees/misc/total); the backend reads whatever falls inside each box. For multi-page receipts, mark each page separately.
2. Detected rows show up in an editable list next to a live view of the receipt — fix a misread name, drag rows to reorder them, or insert one the scan missed.
3. **Assign & split** (`/review`) — tap a name on each item, or use "Everyone" for shared charges. Tax and tip get distributed proportionally to what each person ordered (or split evenly, your choice).

## Running locally

The backend needs to be running too — see `backend/` at the repo root (FastAPI + RapidOCR, `python3 app.py`, listens on port 5001 by default).

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). By default this expects the backend at `http://127.0.0.1:5001` — override with `NEXT_PUBLIC_BACKEND_URL` if it's running elsewhere.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | Base URL of the FastAPI backend | `http://127.0.0.1:5001` |

This is a `NEXT_PUBLIC_*` variable, so Next.js inlines it at **build time** — when deploying, set it in the hosting platform's environment variables before building, not just in a local `.env` file.

## Deployment

Deployed as a standard Next.js app (e.g. on Vercel, with this directory — `bill_split` — set as the project's root directory). The backend is deployed separately (see the "Deployment" section in the repo root [README](../README.md)) since it needs Python/OCR dependencies that don't fit Vercel's serverless functions.
