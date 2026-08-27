#!/usr/bin/env bash
# Start InvoiceGuard on http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet -r requirements.txt
fi
if [ ! -f samples/authentic_INV-101538.pdf ]; then
  ./.venv/bin/python samples/make_samples.py
fi
if [ ! -f data/baselines.json ]; then
  ./.venv/bin/python samples/seed_baseline.py
fi

exec ./.venv/bin/uvicorn invoiceguard.api:app --host 127.0.0.1 --port "${PORT:-8000}" --reload
