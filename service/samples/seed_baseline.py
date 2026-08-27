"""Seed the supplier baseline from invoices the bank has already paid.

In production this job would run off the payments ledger: every drawdown that
settled without a dispute is a labelled example of where this supplier's money
legitimately goes.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sys
from pathlib import Path

from invoiceguard.baseline import BaselineStore
from invoiceguard.extract import extract

ROOT = Path(__file__).resolve().parent


def main(reset: bool = True) -> None:
    store = BaselineStore()
    if reset:
        store.reset()
    for name, note in [
        ("authentic_INV-101538.pdf", "Account confirmed by call-back to the number in the building contract, 06 Nov 2025."),
        ("authentic_INV-101540.pdf", None),
        ("authentic_INV-2291.pdf", "Account confirmed by call-back, 15 Jan 2026."),
    ]:
        path = ROOT / name
        inv = extract(path.read_bytes(), name)
        sup = store.observe(inv, verified=note is not None, note=note)
        print(f"seeded {name} -> {sup.name} ({sup.invoice_count} invoice(s) on file)")
    for abn in ("53 173 584 802", "86 131 549 265"):
        sup = store.get_supplier(None, abn)
        primary = sup.primary_account
        print(f"{sup.name}: verified account {primary.bsb} / {primary.account_number} ({primary.bank})")


if __name__ == "__main__":
    sys.exit(main(reset="--keep" not in sys.argv))
