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

- **Frontend → Vercel.** Set the project's root directory to `bill_split`, and set `NEXT_PUBLIC_BACKEND_URL` to the backend's HTTPS URL.
- **Backend → Oracle Cloud, Always Free tier.** RapidOCR's text detector can use upward of 1GB during a single scan of a high-resolution photographed receipt — past what most free-tier PaaS platforms allow (Render's free tier caps at 512MB, which is what prompted this move). Oracle's Always Free ARM (Ampere A1) instances give up to 24GB RAM at zero cost, permanently, in exchange for managing a real VM instead of a one-click deploy. High-level setup:

  1. Provision a `VM.Standard.A1.Flex` instance (Ubuntu 22.04, ARM64) with a **reserved** (not ephemeral) public IP — reserved IPs don't change if the instance restarts, which matters since `NEXT_PUBLIC_BACKEND_URL` gets baked into the frontend at build time.
  2. Open inbound ports 80 and 443 in **both** firewall layers — Oracle's Network Security Group *and* the instance's own `iptables` rules. These are independent; both default to blocking everything but SSH, and it's easy to open one and forget the other.
  3. `git clone` the repo, then inside `backend/`: create a venv and `pip install -r requirements.txt`.
  4. Run the backend as a systemd service (not a foreground SSH process) so it survives reboots and restarts itself on crash:

     ```ini
     # /etc/systemd/system/moneysplit-backend.service
     [Unit]
     Description=MoneySplit backend
     After=network.target

     [Service]
     User=ubuntu
     WorkingDirectory=/home/ubuntu/Bill-Split/backend
     Environment=FRONTEND_ORIGIN=https://your-frontend.vercel.app
     ExecStart=/home/ubuntu/Bill-Split/backend/venv/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
     Restart=always
     RestartSec=5

     [Install]
     WantedBy=multi-user.target
     ```
     Then: `sudo systemctl daemon-reload && sudo systemctl enable --now moneysplit-backend`

  5. Put [Caddy](https://caddyserver.com) in front on ports 80/443 — it fetches and renews a free HTTPS certificate automatically, no manual cert management. A bare IP address can't hold a Let's Encrypt certificate, so give it a hostname via a wildcard DNS service like [sslip.io](https://sslip.io) instead of buying a domain — `203-0-113-10.sslip.io` resolves to `203.0.113.10` with zero setup:

     ```
     # /etc/caddy/Caddyfile
     your-hostname.sslip.io {
         reverse_proxy 127.0.0.1:8000
     }
     ```
     Then: `sudo systemctl reload caddy`

Both env vars reference each other's deployed URL, so the usual order is: deploy backend → deploy frontend with `NEXT_PUBLIC_BACKEND_URL` set → go back and set `FRONTEND_ORIGIN` on the backend (then `sudo systemctl restart moneysplit-backend`).

## Project structure

```
.
├── backend/          FastAPI + RapidOCR scanning service
│   ├── app.py
│   └── requirements.txt
└── bill_split/        Next.js frontend
    └── app/
        ├── page.tsx           Step 1: upload + region selection + row editing
        └── review/page.tsx    Step 2: assign items + split calculation
```
