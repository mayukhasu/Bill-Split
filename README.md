# MoneySplit

Upload a photo or PDF of a receipt, mark which columns are the item names and prices, assign each item to whoever ordered it, and get a per-person total — tax and tip included.

It's built for real receipts, not just clean digital ones: crumpled thermal paper, phone photos held at an angle, uneven lighting. The scanning pipeline (OCR engine, region matching, item/price pairing) was iterated against actual photographed receipts to handle exactly that.

## How it works

1. **Set up your split** — add participants, then upload a receipt. Draw a box around the item-name column and the price column (and optionally tax/tip/fees/misc/total); the backend reads whatever falls inside each box. Multi-page receipts are marked page by page and stitched into one list.
2. Detected rows appear in an editable list next to a live view of the receipt, so you can fix a misread name, drag rows to reorder them, or insert one the scan missed — without leaving the page.
3. **Assign & split** — tap a name on each item, or "Everyone" for shared charges. Tax and tip get distributed proportionally to what each person ordered, or split evenly if you'd rather.

## Architecture

Two separate services:

- **`bill_split/`** — the Next.js (App Router, TypeScript) frontend. Handles the UI, region-selection canvas, and split-calculation logic.
- **`backend/`** — a FastAPI service that does the actual scanning: renders PDF pages with `pypdfium2`, runs them through [RapidOCR](https://github.com/RapidAI/RapidOCR) (ONNX-based OCR — no external system dependency like Tesseract needs), and matches detected text against whatever regions you drew.

They're separate because the backend's OCR dependencies don't fit a serverless/edge runtime like Vercel's — it needs a real, persistent Python process. See [Deployment](#deployment) below.

## Running locally

**Backend** (needs Python 3.10+):
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 app.py
```
Starts on `http://127.0.0.1:5001`. No OCR system packages to install separately — RapidOCR's models ship inside the pip package.

**Frontend** (needs Node 18+):
```bash
cd bill_split
npm install
npm run dev
```
Starts on `http://localhost:3000` and expects the backend at `http://127.0.0.1:5001` by default.

Start the backend first — the frontend will tell you if it can't reach it.

## Environment variables

| Variable | Where | Purpose | Default |
|---|---|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | frontend | Base URL of the FastAPI backend | `http://127.0.0.1:5001` |
| `FRONTEND_ORIGIN` | backend | Extra CORS origin to allow, on top of localhost | *(none)* |

`NEXT_PUBLIC_BACKEND_URL` gets inlined into the frontend at **build time** — set it in your hosting platform's project settings before building, not just in a local `.env` file.

## Deployment

- **Frontend → Vercel.** Set the project's root directory to `bill_split`, and set `NEXT_PUBLIC_BACKEND_URL` to wherever the backend ends up.
- **Backend → Render** (or any host that runs an arbitrary Python process — Fly.io, Cloud Run, etc.). A `render.yaml` blueprint at the repo root configures this automatically if you connect the repo via Render's Blueprint flow. Set `FRONTEND_ORIGIN` to the deployed frontend's URL once you have it.

Both env vars reference each other's deployed URL, so the usual order is: deploy backend → deploy frontend with `NEXT_PUBLIC_BACKEND_URL` set → go back and set `FRONTEND_ORIGIN` on the backend.

## Project structure

```
.
├── backend/          FastAPI + RapidOCR scanning service
│   ├── app.py
│   └── requirements.txt
├── bill_split/        Next.js frontend
│   └── app/
│       ├── page.tsx           Step 1: upload + region selection + row editing
│       └── review/page.tsx    Step 2: assign items + split calculation
└── render.yaml        Backend deployment blueprint (Render)
```
