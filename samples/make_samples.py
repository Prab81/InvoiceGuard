"""Generate the test corpus.

Every identifying detail is invented: the builders, the ABNs, the licence
numbers, the contacts, the borrowers and all account numbers. Only the
*structure* of each case is drawn from real redirection fraud.

Two independent cases, because the two fraud shapes look nothing alike.

Case one - Harrowgate Homes. The forger controls the document only.
  authentic_INV-101538.pdf   first-generation export, ANZ, titled and authored
  authentic_INV-101540.pdf   a second genuine invoice, so the baseline has history
  authentic_INV-101551.pdf   a genuine invoice the baseline has never seen
  fraudulent_INV-101544.pdf  anonymous re-render paying a Commonwealth account
  tampered_INV-101541.pdf    the ANZ original with a patch pasted over the payments

Case two - Calderwood Constructions. The attacker also controls the email
channel, which is what supplier-email compromise actually looks like: a
look-alike reply domain, a changed callback number, compressed terms, urgency
wording, and a polite notice announcing the "new" bank details.
  authentic_INV-2291.pdf     first-generation export, NAB
  fraudulent_INV-2304.pdf    Westpac account, look-alike domain, 3-day terms

Run:  python samples/make_samples.py
"""
from __future__ import annotations

import io
import random
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent
W, H = A4

DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJAVU_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


# --------------------------------------------------------------------------
# suppliers
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Supplier:
    slug: str
    name_top: str
    name_sub: str
    legal_name: str
    abn: str
    licence: str
    po_box: str
    city: str
    phone: str
    email: str
    bank: str
    bsb: str
    account: str
    customer: tuple[str, str]
    site: tuple[str, str]
    ink: str
    accent: str
    accent_2: str
    logo_seed: int


HARROWGATE = Supplier(
    slug="harrowgate",
    name_top="HARROWGATE", name_sub="H O M E S",
    legal_name="Harrowgate Homes Pty Ltd",
    abn="53 173 584 802", licence="CC2074R",
    po_box="PO Box 418", city="Newstead Tas 7250",
    phone="0491 570 110", email="accounts@harrowgatehomes.com.au",
    bank="ANZ", bsb="013 006", account="384920175",
    customer=("J Alderton & R", "Alderton"),
    site=("Construction of new residential dwelling at 18", "Ferndale Rd, Westbury"),
    ink="#16283f", accent="#1f7ad6", accent_2="#2f9bf0", logo_seed=1,
)

CALDERWOOD = Supplier(
    slug="calderwood",
    name_top="CALDERWOOD", name_sub="C O N S T R U C T I O N S",
    legal_name="Calderwood Constructions Pty Ltd",
    abn="86 131 549 265", licence="BLD 41287",
    po_box="PO Box 902", city="Kingston Tas 7050",
    phone="0491 570 224", email="payments@calderwoodconstructions.com.au",
    bank="NAB", bsb="083 004", account="512746839",
    customer=("T Whitlock & S", "Whitlock"),
    site=("Construction of new residential dwelling at 7", "Marchmont Cr, Kingston"),
    ink="#1d3226", accent="#177a5c", accent_2="#2aa87e", logo_seed=31,
)


# --------------------------------------------------------------------------
# drawing
# --------------------------------------------------------------------------
def _logo(sup: Supplier, size: int, noisy: bool) -> ImageReader:
    """Stand-in letterhead mark. `noisy` perturbs the pixels so a re-encode
    produces different bytes, which is what the image-hash check compares."""
    img = Image.new("RGB", (size, size), "white")
    d = ImageDraw.Draw(img)
    s = size
    d.polygon([(s * .5, s * .08), (s * .95, s * .38), (s * .5, s * .68), (s * .05, s * .38)], fill=sup.accent)
    d.polygon([(s * .05, s * .38), (s * .5, s * .68), (s * .5, s * .95), (s * .05, s * .66)], fill=sup.ink)
    d.polygon([(s * .95, s * .38), (s * .5, s * .68), (s * .5, s * .95), (s * .95, s * .66)], fill=sup.accent_2)
    if noisy:
        rng = random.Random(sup.logo_seed + 7)
        px = img.load()
        for _ in range(size * size // 3):
            x, y = rng.randrange(size), rng.randrange(size)
            r, g, b = px[x, y]
            px[x, y] = (min(255, r + rng.randint(-6, 6)), min(255, g + rng.randint(-6, 6)),
                        min(255, b + rng.randint(-6, 6)))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=not noisy)
    buf.seek(0)
    return ImageReader(buf)


def _fonts(embed: bool) -> tuple[str, str]:
    """Base-14 fonts keep the file tiny; embedded TTFs inflate it, exactly as a
    re-render through a PDF library does."""
    if not embed:
        return "Helvetica", "Helvetica-Bold"
    try:
        pdfmetrics.registerFont(TTFont("Doc", DEJAVU))
        pdfmetrics.registerFont(TTFont("Doc-Bold", DEJAVU_BOLD))
        return "Doc", "Doc-Bold"
    except Exception:
        return "Helvetica", "Helvetica-Bold"


def draw_invoice(c: canvas.Canvas, sup: Supplier, spec: dict,
                 regular: str, bold: str, logo: ImageReader) -> dict:
    ink = HexColor(sup.ink)
    y = H - 60
    c.drawImage(logo, 55, y - 52, 62, 62, mask="auto")
    c.setFont(bold, 21)
    c.setFillColor(ink)
    c.drawString(128, y - 14, sup.name_top)
    c.setFont(regular, 9 if len(sup.name_sub) > 14 else 11)
    c.setFillColor(HexColor(sup.accent))
    c.drawString(130, y - 28, sup.name_sub)

    c.setFillColor(ink)
    c.setFont(regular, 8.5)
    right = W - 55
    for i, line in enumerate([
        f"ABN {sup.abn}",
        f"Licence No. {sup.licence}",
        "",
        sup.po_box,
        sup.city,
        f"Ph {spec['phone']}",
        spec["email"],
    ]):
        c.drawRightString(right, y - 6 - i * 11, line)

    c.setLineWidth(1)
    c.line(55, y - 62, right, y - 62)
    c.setFont(regular, 15)
    c.drawCentredString(W / 2, y - 92, "TAX INVOICE")

    top = y - 130
    c.setFont(regular, 9)
    c.drawString(55, top, sup.customer[0])
    c.drawString(55, top - 12, sup.customer[1])

    for i, (label, value) in enumerate([
        ("Date", spec["date"]),
        ("Invoice Number", spec["number"]),
        ("Reference", spec["reference"]),
    ]):
        yy = top - i * 34
        c.setFont(bold, 8.5)
        c.drawRightString(right, yy, label)
        c.setFont(regular, 8.5)
        c.drawRightString(right, yy - 12, value)

    ty = top - 118
    c.setFont(bold, 8.5)
    c.drawString(55, ty, "Description")
    c.drawRightString(400, ty, "Unit Price")
    c.drawRightString(470, ty, "GST")
    c.drawRightString(right, ty, "Amount AUD")
    c.line(55, ty - 5, right, ty - 5)

    c.setFont(regular, 8.5)
    c.drawString(55, ty - 20, sup.site[0])
    c.drawString(55, ty - 31, sup.site[1])
    c.drawString(55, ty - 46, spec["item"])
    c.drawRightString(400, ty - 46, spec["unit_price"])
    c.drawRightString(470, ty - 46, "10%")
    c.drawRightString(right, ty - 46, spec["line_amount"])

    ry = ty - 64
    rows = [
        ("Subtotal", spec["subtotal"], False),
        ("Total GST 10%", spec["gst"], False),
        ("Invoice Total AUD", spec["total"], False),
        ("Total Net Payments AUD", "0.00", False),
        ("Amount Due AUD", spec["total"], True),
    ]
    for i, (label, value, strong) in enumerate(rows):
        yy = ry - i * 14
        c.setFont(bold if strong else regular, 8.5)
        c.drawRightString(470, yy, label)
        c.drawRightString(right, yy, value)
        if label.startswith("Invoice Total"):
            c.line(300, yy + 10, right, yy + 10)
    c.line(300, ry - len(rows) * 14 + 4, right, ry - len(rows) * 14 + 4)

    py = ry - len(rows) * 14 - 26
    c.setFont(bold, 9)
    c.drawString(55, py, f"Due Date: {spec['due']}")
    if spec.get("urgent"):
        c.setFont(bold, 8.5)
        c.setFillColor(HexColor("#8a1220"))
        c.drawString(200, py, spec["urgent"])
        c.setFillColor(ink)

    py -= 24
    c.setFont(bold, 8.5)
    c.drawString(55, py, "PAYMENT DETAILS")
    c.setFont(regular, 8.5)
    anchors = {}
    for i, (label, value) in enumerate([
        ("Account Name", spec["account_name"]),
        ("Bank", spec["bank"]),
        ("BSB", spec["bsb"]),
        ("Account", spec["account"]),
    ]):
        yy = py - 12 - i * 11
        c.drawString(55, yy, f"{label}: {value}")
        anchors[label] = yy
    c.setFont(regular, 8.5)
    c.drawString(55, py - 74, "Please use invoice number as payment reference")
    if spec.get("notice"):
        c.setFont(bold, 8.5)
        c.drawString(55, py - 88, spec["notice"])
    return {"payment_y": anchors, "payment_top": py}


def set_metadata(path: Path, *, producer: str, creator: str, title: str | None,
                 author: str | None, created: str, modified: str, version: str) -> None:
    reader = PdfReader(str(path))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    meta = {"/Producer": producer, "/Creator": creator, "/CreationDate": created, "/ModDate": modified}
    if title:
        meta["/Title"] = title
    if author:
        meta["/Author"] = author
    writer.add_metadata(meta)
    buf = io.BytesIO()
    writer.write(buf)
    data = buf.getvalue()
    if data.startswith(b"%PDF-1."):
        data = b"%PDF-" + version.encode() + data[len(b"%PDF-1.4"):]
    path.write_bytes(data)


# --------------------------------------------------------------------------
# builders
# --------------------------------------------------------------------------
def build(sup: Supplier, out: str, *, number: str, date: str, due: str, reference: str,
          item: str, unit: str, subtotal: str, gst: str, total: str,
          bank: str | None = None, bsb: str | None = None, account: str | None = None,
          email: str | None = None, phone: str | None = None,
          notice: str | None = None, urgent: str | None = None,
          producer: str, creator: str, title: str | None, author: str | None,
          created: str, modified: str | None = None, version: str,
          embed_fonts: bool = False, noisy_logo: bool = False, logo_px: int = 120) -> Path:
    path = OUT / out
    regular, bold = _fonts(embed=embed_fonts)
    c = canvas.Canvas(str(path), pagesize=A4)
    geom = draw_invoice(c, sup, {
        "email": email or sup.email, "phone": phone or sup.phone,
        "date": date, "number": number, "reference": reference,
        "item": item, "unit_price": unit, "line_amount": subtotal,
        "subtotal": subtotal, "gst": gst, "total": total, "due": due,
        "account_name": sup.legal_name,
        "bank": bank or sup.bank, "bsb": bsb or sup.bsb, "account": account or sup.account,
        "notice": notice, "urgent": urgent,
    }, regular, bold, _logo(sup, logo_px, noisy=noisy_logo))
    c.save()
    set_metadata(path, producer=producer, creator=creator, title=title, author=author,
                 created=created, modified=modified or created, version=version)
    return path, geom


def build_tampered(sup: Supplier) -> Path:
    """A cruder forgery: the genuine PDF with a white patch pasted over the
    payment block and replacement details typed on top."""
    path = OUT / "tampered_INV-101541.pdf"
    regular, bold = _fonts(embed=False)
    patch_font, _ = _fonts(embed=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    geom = draw_invoice(c, sup, {
        "email": sup.email, "phone": sup.phone,
        "date": "08 Jan 2026", "number": "INV-101541", "reference": "1132",
        "item": "Frame stage", "unit_price": "28,863.6364", "line_amount": "28,863.64",
        "subtotal": "28,863.64", "gst": "2,886.36", "total": "31,750.00", "due": "22 Jan 2026",
        "account_name": sup.legal_name, "bank": sup.bank, "bsb": sup.bsb, "account": sup.account,
    }, regular, bold, _logo(sup, 120, noisy=False))

    ys = geom["payment_y"]
    top, bottom = ys["Bank"] + 9, ys["Account"] - 3
    c.setFillColor(white)
    c.setStrokeColor(white)
    c.rect(50, bottom, 250, top - bottom, stroke=0, fill=1)
    c.setFillColor(HexColor(sup.ink))
    c.setFont(patch_font, 8.5)
    c.drawString(55, ys["Bank"], "Bank: Commonwealth")
    c.drawString(55, ys["BSB"], "BSB: 062-000")
    c.drawString(55, ys["Account"], "Account: 10456213")
    c.save()
    set_metadata(path, producer="iLovePDF", creator="Microsoft: Print To PDF",
                 title=None, author=None, created="D:20260107091200+11'00'",
                 modified="D:20260108184500+11'00'", version="1.4")
    return path


def main() -> None:
    made = []

    # ---- case one: the forger controls the document -----------------------
    genuine = dict(producer="Microsoft: Print To PDF", creator="Microsoft: Print To PDF",
                   author="J Mejia", version="1.7")
    made.append(build(HARROWGATE, "authentic_INV-101538.pdf", number="INV-101538",
                      date="05 Nov 2025", due="19 Nov 2025", reference="1132",
                      item="Site works - Waste water system", unit="21,590.9091",
                      subtotal="21,590.91", gst="2,159.09", total="23,750.00",
                      title="Invoice INV-101538 (1).pdf", created="D:20251105104000+11'00'",
                      **genuine)[0])
    made.append(build(HARROWGATE, "authentic_INV-101540.pdf", number="INV-101540",
                      date="03 Dec 2025", due="17 Dec 2025", reference="1132",
                      item="Slab stage", unit="34,545.4545",
                      subtotal="34,545.45", gst="3,454.55", total="38,000.00",
                      title="Invoice INV-101540.pdf", created="D:20251203093000+11'00'",
                      **genuine)[0])
    made.append(build(HARROWGATE, "authentic_INV-101551.pdf", number="INV-101551",
                      date="12 Feb 2026", due="26 Feb 2026", reference="1132",
                      item="Frame stage", unit="28,863.6364",
                      subtotal="28,863.64", gst="2,886.36", total="31,750.00",
                      title="Invoice INV-101551.pdf", created="D:20260212081500+11'00'",
                      **genuine)[0])
    made.append(build(HARROWGATE, "fraudulent_INV-101544.pdf", number="INV-101544",
                      date="10 Feb 2026", due="24 Feb 2026", reference="1132",
                      item="Base stage", unit="43,181.8182",
                      subtotal="43,181.82", gst="4,318.18", total="47,500.00",
                      bank="Commonwealth", bsb="062-000", account="10456213",
                      producer="Pdftools SDK", creator="", title=None, author=None,
                      created="D:20260209231900+11'00'", modified="D:20260209232400+11'00'",
                      version="1.4", embed_fonts=True, noisy_logo=True, logo_px=260)[0])
    made.append(build_tampered(HARROWGATE))

    # ---- case two: the attacker also controls the email channel -----------
    made.append(build(CALDERWOOD, "authentic_INV-2291.pdf", number="INV-2291",
                      date="14 Jan 2026", due="28 Jan 2026", reference="4471",
                      item="Frame stage", unit="31,363.6364",
                      subtotal="31,363.64", gst="3,136.36", total="34,500.00",
                      producer="MYOB AccountRight", creator="MYOB AccountRight",
                      title="INV-2291 Calderwood.pdf", author="D Prasad",
                      created="D:20260114141500+11'00'", version="1.6")[0])
    made.append(build(CALDERWOOD, "fraudulent_INV-2304.pdf", number="INV-2304",
                      date="18 Feb 2026", due="21 Feb 2026", reference="4471",
                      item="Lock up stage", unit="40,909.0909",
                      subtotal="40,909.09", gst="4,090.91", total="45,000.00",
                      bank="Westpac", bsb="032 002", account="447196025",
                      # The reply-to domain is one homoglyph away from the real one,
                      # and the callback number is the attacker's.
                      email="payments@calderwoodconstructlons.com.au", phone="0491 570 831",
                      notice="Please note our banking details have changed.",
                      urgent="URGENT - immediate payment required to avoid delay",
                      producer="Smallpdf", creator="", title=None, author=None,
                      created="D:20260217194500+11'00'", modified="D:20260218081100+11'00'",
                      version="1.4", embed_fonts=True, noisy_logo=True, logo_px=200)[0])

    for p in made:
        print(f"{p.name:32} {p.stat().st_size:>8,} bytes")


if __name__ == "__main__":
    sys.exit(main())
