"""Supplier baselines and the portfolio-wide payee-account ledger.

This is the part of the system that carries the most detection power. Every
intrinsic check in the other layers can be satisfied by a competent forger; a
change of destination account relative to what this supplier has been paid on
before cannot be, because the fraudster does not control our history.

Storage is a JSON file so the demo runs with no infrastructure. The interface
(`get_supplier`, `observe`, `accounts_for`, `suppliers_for_account`) is what a
production implementation would put behind the bank's payee master data.
"""
from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field, asdict
from datetime import date
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
STORE_PATH = DATA_DIR / "baselines.json"

_lock = threading.Lock()


@dataclass
class AccountRecord:
    bsb: str
    account_number: str
    bank: str | None = None
    account_name: str | None = None
    first_seen: str | None = None
    last_seen: str | None = None
    times_seen: int = 0
    verified: bool = False          # confirmed out-of-band (call-back / COP)
    verified_note: str | None = None

    @property
    def key(self) -> str:
        return f"{self.bsb}:{self.account_number}"


@dataclass
class SupplierBaseline:
    key: str
    name: str
    abn: str | None = None
    licence: str | None = None
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    accounts: list[AccountRecord] = field(default_factory=list)
    producers: list[str] = field(default_factory=list)
    creators: list[str] = field(default_factory=list)
    authors: list[str] = field(default_factory=list)
    pdf_versions: list[str] = field(default_factory=list)
    title_pattern_present: bool = False
    byte_sizes: list[int] = field(default_factory=list)
    logo_hashes: list[str] = field(default_factory=list)
    invoice_numbers: list[str] = field(default_factory=list)
    invoice_dates: list[str] = field(default_factory=list)
    payment_terms_days: list[int] = field(default_factory=list)
    totals: list[float] = field(default_factory=list)
    stages_claimed: list[str] = field(default_factory=list)
    document_hashes: list[str] = field(default_factory=list)
    invoice_count: int = 0

    # ---- derived helpers -------------------------------------------------
    @property
    def primary_account(self) -> AccountRecord | None:
        if not self.accounts:
            return None
        verified = [a for a in self.accounts if a.verified]
        pool = verified or self.accounts
        return max(pool, key=lambda a: (a.times_seen, a.last_seen or ""))

    def account(self, bsb: str | None, number: str | None) -> AccountRecord | None:
        if not bsb or not number:
            return None
        return next((a for a in self.accounts if a.bsb == bsb and a.account_number == number), None)

    def median_byte_size(self) -> int | None:
        if not self.byte_sizes:
            return None
        s = sorted(self.byte_sizes)
        return s[len(s) // 2]

    def is_established(self) -> bool:
        """Enough history for the differential rules to mean something."""
        return self.invoice_count >= 1 and bool(self.accounts)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        primary = self.primary_account
        d["primary_account"] = asdict(primary) if primary else None
        d["established"] = self.is_established()
        return d


def _norm_key(name: str | None, abn: str | None) -> str | None:
    if abn:
        digits = re.sub(r"\D", "", abn)
        if len(digits) == 11:
            return f"abn:{digits}"
    if name:
        return "name:" + re.sub(r"[^a-z0-9]", "", name.lower())
    return None


class BaselineStore:
    def __init__(self, path: Path = STORE_PATH):
        self.path = path
        self.suppliers: dict[str, SupplierBaseline] = {}
        self.load()

    # ---- persistence -----------------------------------------------------
    def load(self) -> None:
        if not self.path.exists():
            return
        blob = json.loads(self.path.read_text())
        for key, raw in blob.get("suppliers", {}).items():
            accounts = [AccountRecord(**a) for a in raw.pop("accounts", [])]
            self.suppliers[key] = SupplierBaseline(**raw, accounts=accounts)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        blob = {"suppliers": {k: asdict(v) for k, v in self.suppliers.items()}}
        self.path.write_text(json.dumps(blob, indent=2, sort_keys=True))

    # ---- lookup ----------------------------------------------------------
    def get_supplier(self, name: str | None, abn: str | None) -> SupplierBaseline | None:
        key = _norm_key(name, abn)
        if key and key in self.suppliers:
            return self.suppliers[key]
        # Fall back to a name match when the ABN key misses, and vice versa.
        if abn:
            nk = _norm_key(name, None)
            if nk and nk in self.suppliers:
                return self.suppliers[nk]
        if name:
            target = re.sub(r"[^a-z0-9]", "", name.lower())
            for sup in self.suppliers.values():
                if re.sub(r"[^a-z0-9]", "", sup.name.lower()) == target:
                    return sup
        return None

    def suppliers_for_account(self, bsb: str | None, number: str | None) -> list[SupplierBaseline]:
        """Which other payees have we seen using this exact account?"""
        if not bsb or not number:
            return []
        out = []
        for sup in self.suppliers.values():
            if sup.account(bsb, number):
                out.append(sup)
        return out

    def account_is_known_anywhere(self, bsb: str | None, number: str | None) -> bool:
        return bool(self.suppliers_for_account(bsb, number))

    # ---- learning --------------------------------------------------------
    def observe(self, inv, *, verified: bool, note: str | None = None) -> SupplierBaseline:
        """Fold a document the bank has accepted as genuine into the baseline."""
        from .extract import ExtractedInvoice  # noqa: F401  (typing only)

        key = _norm_key(inv.supplier_name, inv.supplier_abn)
        if not key:
            raise ValueError("Cannot update a baseline without a supplier name or ABN.")
        with _lock:
            sup = self.suppliers.get(key)
            if sup is None:
                sup = SupplierBaseline(key=key, name=inv.supplier_name or key, abn=inv.supplier_abn)
                self.suppliers[key] = sup

            if inv.supplier_abn and not sup.abn:
                sup.abn = inv.supplier_abn
            if inv.supplier_licence and not sup.licence:
                sup.licence = inv.supplier_licence
            for value, bucket in (
                (inv.supplier_email, sup.emails),
                (inv.supplier_phone, sup.phones),
                (inv.meta.producer, sup.producers),
                (inv.meta.creator, sup.creators),
                (inv.meta.author, sup.authors),
                (inv.meta.pdf_version, sup.pdf_versions),
            ):
                if value and value not in bucket:
                    bucket.append(value)
            for h in inv.layout.image_hashes:
                if h not in sup.logo_hashes:
                    sup.logo_hashes.append(h)
            if inv.meta.title:
                sup.title_pattern_present = True
            sup.byte_sizes.append(inv.meta.byte_size)
            if inv.invoice_number:
                sup.invoice_numbers.append(inv.invoice_number)
            if inv.invoice_date:
                sup.invoice_dates.append(inv.invoice_date.isoformat())
            if inv.invoice_date and inv.due_date:
                sup.payment_terms_days.append((inv.due_date - inv.invoice_date).days)
            if inv.total is not None:
                sup.totals.append(inv.total)
            for item in inv.line_items:
                from .reference import classify_stage
                st = classify_stage(item.description)
                if st and st[0] not in sup.stages_claimed:
                    sup.stages_claimed.append(st[0])
            if inv.meta.sha256 and inv.meta.sha256 not in sup.document_hashes:
                sup.document_hashes.append(inv.meta.sha256)
            sup.invoice_count += 1

            pay = inv.payment
            if pay.bsb and pay.account_number:
                rec = sup.account(pay.bsb, pay.account_number)
                seen_on = (inv.invoice_date or date.today()).isoformat()
                if rec is None:
                    rec = AccountRecord(
                        bsb=pay.bsb, account_number=pay.account_number,
                        bank=pay.bank_printed, account_name=pay.account_name,
                        first_seen=seen_on,
                    )
                    sup.accounts.append(rec)
                rec.times_seen += 1
                rec.last_seen = seen_on
                if verified:
                    rec.verified = True
                    rec.verified_note = note
            self.save()
            return sup

    def reset(self) -> None:
        with _lock:
            self.suppliers.clear()
            self.save()
