"""Static reference data used by the rule layers.

Nothing here talks to the network. In production the BSB table should be
replaced by the fortnightly APCA/AusPayNet BSB directory and the ABN lookup by
the ABR web service; the shapes below are deliberately the same so swapping the
source is a one-function change.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# --------------------------------------------------------------------------
# BSB -> institution
# --------------------------------------------------------------------------
# Three-digit entries win over two-digit ones. This is a working subset of the
# public directory: enough to cover the majority of Australian retail volume.
BSB_3 = {
    "013": "Australia and New Zealand Banking Group",
    "017": "Australia and New Zealand Banking Group",
    "032": "Westpac Banking Corporation",
    "033": "Westpac Banking Corporation",
    "036": "Westpac Banking Corporation",
    "062": "Commonwealth Bank of Australia",
    "063": "Commonwealth Bank of Australia",
    "064": "Commonwealth Bank of Australia",
    "065": "Commonwealth Bank of Australia",
    "066": "Commonwealth Bank of Australia",
    "067": "Commonwealth Bank of Australia",
    "082": "National Australia Bank",
    "083": "National Australia Bank",
    "084": "National Australia Bank",
    "085": "National Australia Bank",
    "112": "BankSA",
    "114": "St George Bank",
    "182": "Macquarie Bank",
    "183": "Macquarie Bank",
    "193": "Bank of Melbourne",
    "484": "Suncorp Bank",
    "633": "Bendigo and Adelaide Bank",
    "637": "Greater Bank",
    "650": "Newcastle Permanent",
    "670": "ubank",
    "923": "ING Bank (Australia)",
    "944": "Australian Military Bank",
}

BSB_2 = {
    "01": "Australia and New Zealand Banking Group",
    "03": "Westpac Banking Corporation",
    "04": "Westpac Banking Corporation",
    "06": "Commonwealth Bank of Australia",
    "08": "National Australia Bank",
    "09": "Reserve Bank of Australia",
    "10": "BankSA",
    "11": "St George Bank",
    "12": "Bank of Queensland",
    "14": "Rabobank Australia",
    "18": "Macquarie Bank",
    "19": "Bank of Melbourne",
    "48": "Suncorp Bank",
    "63": "Bendigo and Adelaide Bank",
    "80": "Cuscal (mutuals / credit unions)",
    "92": "ING Bank (Australia)",
}

# Short brand names an invoice is likely to print, mapped to the registry name.
BANK_ALIASES = {
    "anz": "Australia and New Zealand Banking Group",
    "anz bank": "Australia and New Zealand Banking Group",
    "commonwealth": "Commonwealth Bank of Australia",
    "commonwealth bank": "Commonwealth Bank of Australia",
    "commbank": "Commonwealth Bank of Australia",
    "cba": "Commonwealth Bank of Australia",
    "westpac": "Westpac Banking Corporation",
    "nab": "National Australia Bank",
    "national australia bank": "National Australia Bank",
    "st george": "St George Bank",
    "stgeorge": "St George Bank",
    "banksa": "BankSA",
    "bank of melbourne": "Bank of Melbourne",
    "boq": "Bank of Queensland",
    "bank of queensland": "Bank of Queensland",
    "bendigo": "Bendigo and Adelaide Bank",
    "macquarie": "Macquarie Bank",
    "suncorp": "Suncorp Bank",
    "ing": "ING Bank (Australia)",
    "ubank": "ubank",
}

# Typical account-number digit lengths per institution (excluding BSB).
ACCOUNT_DIGIT_RANGE = {
    "Commonwealth Bank of Australia": (8, 9),
    "Australia and New Zealand Banking Group": (9, 9),
    "Westpac Banking Corporation": (6, 9),
    "National Australia Bank": (9, 10),
    "St George Bank": (9, 9),
    "Bank of Queensland": (8, 9),
    "Bendigo and Adelaide Bank": (9, 9),
    "Macquarie Bank": (9, 9),
    "Suncorp Bank": (8, 9),
    "ING Bank (Australia)": (9, 9),
}

_DEFAULT_ACCOUNT_RANGE = (5, 10)


@dataclass
class BsbInfo:
    raw: str
    digits: str
    known: bool
    institution: str | None
    matched_on: str | None  # "3-digit" | "2-digit" | None


def normalise_bsb(value: str | None) -> str | None:
    """'017 042', '017-042', '017042' -> '017042'. None if not 6 digits."""
    if not value:
        return None
    digits = re.sub(r"\D", "", value)
    return digits if len(digits) == 6 else None


def lookup_bsb(value: str | None) -> BsbInfo:
    digits = normalise_bsb(value)
    if not digits:
        return BsbInfo(raw=value or "", digits="", known=False, institution=None, matched_on=None)
    if digits[:3] in BSB_3:
        return BsbInfo(value or "", digits, True, BSB_3[digits[:3]], "3-digit")
    if digits[:2] in BSB_2:
        return BsbInfo(value or "", digits, True, BSB_2[digits[:2]], "2-digit")
    return BsbInfo(value or "", digits, False, None, None)


def canonical_bank_name(printed: str | None) -> str | None:
    """Map whatever the invoice printed on the 'Bank:' line to a registry name."""
    if not printed:
        return None
    key = re.sub(r"[^a-z ]", "", printed.lower()).strip()
    key = re.sub(r"\s+(bank|banking corporation|pty ltd|limited|ltd)$", "", key).strip()
    if key in BANK_ALIASES:
        return BANK_ALIASES[key]
    for alias, name in BANK_ALIASES.items():
        if key.startswith(alias) or alias in key:
            return name
    return None


def account_digit_range(institution: str | None) -> tuple[int, int]:
    return ACCOUNT_DIGIT_RANGE.get(institution or "", _DEFAULT_ACCOUNT_RANGE)


# --------------------------------------------------------------------------
# ABN / ACN
# --------------------------------------------------------------------------
_ABN_WEIGHTS = (10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19)


def validate_abn(value: str | None) -> bool:
    """ATO modulus-89 check. Works entirely offline."""
    if not value:
        return False
    digits = re.sub(r"\D", "", value)
    if len(digits) != 11:
        return False
    nums = [int(c) for c in digits]
    nums[0] -= 1
    return sum(n * w for n, w in zip(nums, _ABN_WEIGHTS)) % 89 == 0


def validate_acn(value: str | None) -> bool:
    if not value:
        return False
    digits = re.sub(r"\D", "", value)
    if len(digits) != 9:
        return False
    total = sum(int(d) * w for d, w in zip(digits[:8], (8, 7, 6, 5, 4, 3, 2, 1)))
    return (10 - total % 10) % 10 == int(digits[8])


# --------------------------------------------------------------------------
# PDF producer / creator fingerprints
# --------------------------------------------------------------------------
# Toolchains that indicate a document was re-rendered, re-saved or edited after
# it left the issuer's accounting system. None of these is proof of fraud on its
# own -- they are weighted as corroboration, not as a verdict.
EDITOR_FINGERPRINTS: list[tuple[str, str, str]] = [
    (r"pdftools?\s*sdk|pdftools ag|3-heights", "Pdftools SDK / 3-Heights",
     "server-side PDF manipulation library; common in re-write and flattening pipelines"),
    (r"ilovepdf", "iLovePDF", "free online PDF editor"),
    (r"smallpdf", "Smallpdf", "free online PDF editor"),
    (r"sejda", "Sejda", "free online PDF editor"),
    (r"pdf24", "PDF24", "free desktop/online PDF editor"),
    (r"pdfescape", "PDFescape", "free online PDF form/text editor"),
    (r"pdfelement|wondershare", "Wondershare PDFelement", "consumer PDF editing suite"),
    (r"foxit\s*(phantom|pdf editor)", "Foxit PhantomPDF / PDF Editor", "consumer PDF editing suite"),
    (r"nitro\s*pdf|nitro pro", "Nitro Pro", "consumer PDF editing suite"),
    (r"acrobat|adobe pdf library", "Adobe Acrobat", "interactive PDF editor"),
    (r"ghostscript|gpl ghostscript", "Ghostscript", "re-distiller; strips original structure"),
    (r"skia/pdf", "Chromium print-to-PDF", "page re-printed from a browser"),
    (r"quartz pdfcontext", "macOS Quartz", "file re-saved through macOS Preview / print pipeline"),
    (r"itext|openpdf", "iText / OpenPDF", "programmatic PDF assembly library"),
    (r"pdftk", "PDFtk", "command-line PDF manipulation"),
    (r"cairo|reportlab|fpdf|tcpdf|dompdf", "generic PDF generator library",
     "document was generated by a script rather than an accounting package"),
]

# Producers that normally indicate a first-generation export from a real
# accounting/ERP system. Seeing one of these is mildly reassuring.
ACCOUNTING_PRODUCERS = [
    r"xero", r"myob", r"quickbooks|intuit", r"reckon", r"sage", r"netsuite",
    r"sap", r"dynamics", r"buildxact", r"databuild", r"beams", r"simpro",
    r"microsoft:\s*print to pdf", r"microsoft.*word", r"crystal reports",
]


def match_editor_fingerprint(producer: str | None, creator: str | None) -> tuple[str, str] | None:
    blob = f"{producer or ''} {creator or ''}".lower()
    if not blob.strip():
        return None
    for pattern, label, note in EDITOR_FINGERPRINTS:
        if re.search(pattern, blob):
            return label, note
    return None


def looks_like_accounting_export(producer: str | None, creator: str | None) -> bool:
    blob = f"{producer or ''} {creator or ''}".lower()
    return any(re.search(p, blob) for p in ACCOUNTING_PRODUCERS)


# --------------------------------------------------------------------------
# Language cues
# --------------------------------------------------------------------------
BANK_CHANGE_NOTICE = re.compile(
    r"(new|updated|changed|change of|different)\s+(bank|banking|account|payment)\s*"
    r"(details|account|information)?|please note our (bank|account)|"
    r"we have (changed|updated) our (bank|account)",
    re.I,
)

URGENCY_LANGUAGE = re.compile(
    r"\burgent(ly)?\b|\bimmediate(ly)?\b|as soon as possible|\basap\b|"
    r"same day|today only|avoid (delay|penalt)|final notice|overdue",
    re.I,
)

# Progress-payment stage vocabulary for residential construction lending.
CONSTRUCTION_STAGES = [
    ("deposit", 1), ("site works", 2), ("site start", 2), ("slab", 3), ("base", 3),
    ("frame", 4), ("lock up", 5), ("lockup", 5), ("lock-up", 5),
    ("fixing", 6), ("fit out", 6), ("fitout", 6),
    ("practical completion", 7), ("completion", 7), ("final", 7),
]


def classify_stage(description: str | None) -> tuple[str, int] | None:
    if not description:
        return None
    low = description.lower()
    best: tuple[str, int] | None = None
    for name, order in CONSTRUCTION_STAGES:
        if name in low and (best is None or len(name) > len(best[0])):
            best = (name, order)
    return best
