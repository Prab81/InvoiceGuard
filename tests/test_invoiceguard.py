"""End-to-end checks over the generated corpus, plus unit checks on the
reference data and the scoring model.

Run:  ./.venv/bin/python -m pytest tests -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "samples"
sys.path.insert(0, str(ROOT))

from invoiceguard.analyzer import analyze_pair, analyze_single  # noqa: E402
from invoiceguard.baseline import BaselineStore  # noqa: E402
from invoiceguard.extract import extract, parse_date  # noqa: E402
from invoiceguard.models import Finding  # noqa: E402
from invoiceguard.reference import (  # noqa: E402
    canonical_bank_name, lookup_bsb, match_editor_fingerprint, normalise_bsb, validate_abn,
)
from invoiceguard.scoring import score  # noqa: E402

AUTHENTIC = "authentic_INV-101538.pdf"
AUTHENTIC_2 = "authentic_INV-101540.pdf"
UNSEEN_GENUINE = "authentic_INV-101551.pdf"
FRAUD = "fraudulent_INV-101544.pdf"
TAMPERED = "tampered_INV-101541.pdf"


def read(name: str) -> bytes:
    return (SAMPLES / name).read_bytes()


@pytest.fixture(scope="module", autouse=True)
def corpus():
    if not (SAMPLES / FRAUD).exists():
        sys.path.insert(0, str(SAMPLES))
        import make_samples
        make_samples.main()


@pytest.fixture
def store(tmp_path) -> BaselineStore:
    """A store seeded with the two invoices the bank has already paid."""
    s = BaselineStore(tmp_path / "baselines.json")
    s.observe(extract(read(AUTHENTIC), AUTHENTIC), verified=True, note="call-back 06 Nov 2025")
    s.observe(extract(read(AUTHENTIC_2), AUTHENTIC_2), verified=False)
    return s


@pytest.fixture
def empty_store(tmp_path) -> BaselineStore:
    return BaselineStore(tmp_path / "empty.json")


def codes(result: dict) -> set[str]:
    return {f["code"] for f in result["risk"]["findings"]}


# --------------------------------------------------------------- reference
def test_abn_checksum():
    assert validate_abn("53 173 584 802")
    assert not validate_abn("98 479 906 917")
    assert not validate_abn("1234")


def test_bsb_registry_maps_both_case_accounts():
    assert lookup_bsb("013 006").institution.startswith("Australia and New Zealand")
    assert lookup_bsb("062-000").institution == "Commonwealth Bank of Australia"
    assert not lookup_bsb("999-999").known
    assert normalise_bsb("013006") == normalise_bsb("013 006") == "013006"


def test_printed_bank_names_resolve_to_the_registry():
    assert canonical_bank_name("ANZ") == lookup_bsb("013006").institution
    assert canonical_bank_name("Commonwealth") == lookup_bsb("062000").institution


def test_editor_fingerprints():
    assert match_editor_fingerprint("Pdftools SDK", "")[0].startswith("Pdftools")
    assert match_editor_fingerprint("iLovePDF", "")[0] == "iLovePDF"
    assert match_editor_fingerprint("Microsoft: Print To PDF", "") is None


def test_date_parsing():
    assert parse_date("05 Nov 2025").isoformat() == "2025-11-05"
    assert parse_date("24/02/2026").isoformat() == "2026-02-24"
    assert parse_date("not a date") is None


# ---------------------------------------------------------------- extraction
def test_authentic_fields_are_read():
    inv = extract(read(AUTHENTIC), AUTHENTIC)
    assert inv.supplier_abn == "53 173 584 802"
    assert inv.payment.bsb == "013006"
    assert inv.payment.account_number == "384920175"
    assert inv.payment.bank_printed == "ANZ"
    assert inv.invoice_number == "INV-101538"
    assert inv.invoice_date.isoformat() == "2025-11-05"
    assert inv.amount_due == 23750.00
    assert inv.meta.author == "J Mejia"


def test_abn_is_not_mistaken_for_a_bsb():
    """'ABN 53 173 584 802' contains '479 906', which matches a bare BSB pattern."""
    inv = extract(read(AUTHENTIC), AUTHENTIC)
    assert inv.layout.all_bsb_matches == ["013006"]


def test_overlay_reveals_both_accounts():
    inv = extract(read(TAMPERED), TAMPERED)
    assert set(inv.layout.all_bsb_matches) == {"013006", "062000"}
    # The instrument reported is the one painted last - what a reader sees.
    assert inv.payment.bsb == "062000"
    assert inv.payment.account_number == "10456213"
    assert inv.layout.covered_text_snippets, "original text under the patch was not recovered"
    assert inv.layout.overprint_ratio > 0.02


# ------------------------------------------------------------------ scoring
def test_fraudulent_invoice_is_blocked(store):
    result = analyze_single(read(FRAUD), FRAUD, store)
    assert result["risk"]["band"] == "high_risk"
    assert "PAY_ACCOUNT_CHANGED" in codes(result)
    assert "META_PRODUCER_CHANGED" in codes(result)
    assert "META_STRIPPED" in codes(result)


def test_tampered_invoice_is_blocked_on_forensics(store):
    result = analyze_single(read(TAMPERED), TAMPERED, store)
    assert result["risk"]["band"] == "high_risk"
    found = codes(result)
    assert "FOR_HIDDEN_TEXT_UNDER_OVERLAY" in found
    assert "PAY_MULTIPLE_ACCOUNTS_ON_DOC" in found
    assert "FOR_FONT_DRIFT_IN_PAYMENT_BLOCK" in found


def test_genuine_invoice_already_on_file_scores_clean(store):
    result = analyze_single(read(AUTHENTIC), AUTHENTIC, store)
    assert result["risk"]["band"] == "likely_authentic"
    assert result["risk"]["score"] == 0


def test_unseen_genuine_invoice_scores_clean(store):
    """A real new invoice from the same supplier must not trip the model."""
    result = analyze_single(read(UNSEEN_GENUINE), UNSEEN_GENUINE, store)
    assert result["risk"]["band"] == "likely_authentic", result["risk"]["top_reasons"]


def test_no_baseline_reports_reduced_confidence(empty_store):
    result = analyze_single(read(FRAUD), FRAUD, empty_store)
    assert result["risk"]["baseline_available"] is False
    assert "PAY_NO_BASELINE" in codes(result)
    assert "PAY_ACCOUNT_CHANGED" not in codes(result)


def test_mule_account_shared_between_suppliers(store, tmp_path):
    """The same destination account showing up under a second payee."""
    other = extract(read(FRAUD), FRAUD)
    other.supplier_name = "Northern Roofing Pty Ltd"
    other.supplier_abn = None
    store.observe(other, verified=False)
    result = analyze_single(read(FRAUD), FRAUD, store)
    assert "PAY_ACCOUNT_SHARED_ACROSS_SUPPLIERS" in codes(result)


# ------------------------------------------------------------------ compare
def test_compare_mode_works_without_any_history(empty_store):
    result = analyze_pair(read(FRAUD), FRAUD, read(AUTHENTIC), AUTHENTIC, empty_store)
    assert result["mode"] == "compare"
    assert result["risk"]["band"] in ("suspicious", "high_risk")
    found = codes(result)
    assert "CMP_PAYMENT_CHANGED" in found
    assert "CMP_PRODUCER_CHANGED" in found
    assert "CMP_METADATA_STRIPPED" in found
    assert result["reference_risk"]["band"] == "likely_authentic"
    assert any(r["field"] == "BSB" and not r["same"] for r in result["diff"])


def test_compare_two_genuine_invoices_is_quiet(empty_store):
    result = analyze_pair(read(UNSEEN_GENUINE), UNSEEN_GENUINE, read(AUTHENTIC), AUTHENTIC, empty_store)
    assert "CMP_PAYMENT_CHANGED" not in codes(result)
    assert result["risk"]["band"] == "likely_authentic", result["risk"]["top_reasons"]


# ------------------------------------------------------------- score model
def test_critical_finding_forces_a_block_regardless_of_total():
    result = score([Finding("X", "t", "payment", "critical", 1, "e")], baseline_available=True)
    assert result.band == "high_risk"


def test_layer_caps_prevent_metadata_alone_from_blocking():
    noise = [Finding(f"M{i}", "t", "metadata", "medium", 12, "e") for i in range(10)]
    result = score(noise, baseline_available=True)
    assert result.layer_scores["metadata"] == 30.0
    assert result.band != "high_risk"


def test_verified_match_pulls_the_score_down():
    findings = [
        Finding("PAY_ACCOUNT_VERIFIED_MATCH", "t", "payment", "info", -12, "e"),
        Finding("META_X", "t", "metadata", "low", 5, "e"),
    ]
    assert score(findings, baseline_available=True).score == 0.0


# ------------------------------------------------------------------ learning
def test_observing_an_invoice_makes_its_account_the_baseline(empty_store):
    inv = extract(read(AUTHENTIC), AUTHENTIC)
    sup = empty_store.observe(inv, verified=True, note="call-back")
    assert sup.primary_account.verified
    assert sup.primary_account.bsb == "013006"
    reloaded = BaselineStore(empty_store.path)
    assert reloaded.get_supplier(None, "53 173 584 802").primary_account.account_number == "384920175"
