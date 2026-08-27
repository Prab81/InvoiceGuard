"""Generate a test corpus that reproduces the case this system was built for.

Four documents from the same fictitious builder:

  authentic_INV-101538.pdf   first-generation export, ANZ account, titled+authored
  fraudulent_INV-101544.pdf  anonymous re-render, Commonwealth account, 2x the size
  tampered_INV-101541.pdf    the ANZ original with a patch pasted over the payment block
  authentic_INV-101540.pdf   a second genuine invoice, so the baseline has history
  authentic_INV-101551.pdf   a genuine invoice the baseline has never seen (true negative)

Run:  python samples/make_samples.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import io
import random
import sys
from pathlib import Path

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
NAVY = HexColor("#16283f")
BLUE = HexColor("#1f7ad6")

DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
LIBERATION = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"


def _logo(size: int, seed: int, noisy: bool) -> ImageReader:
    """A stand-in letterhead mark. `seed`/`noisy` change the encoded bytes so the
    image-hash comparison has something real to compare."""
    img = Image.new("RGB", (size, size), "white")
    d = ImageDraw.Draw(img)
    s = size
    d.polygon([(s * .5, s * .08), (s * .95, s * .38), (s * .5, s * .68), (s * .05, s * .38)], fill="#1f7ad6")
    d.polygon([(s * .05, s * .38), (s * .5, s * .68), (s * .5, s * .95), (s * .05, s * .66)], fill="#16283f")
    d.polygon([(s * .95, s * .38), (s * .5, s * .68), (s * .5, s * .95), (s * .95, s * .66)], fill="#2f9bf0")
    if noisy:  # a re-encode never round-trips to the same bytes
        rng = random.Random(seed)
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
        pdfmetrics.registerFont(TTFont("Doc-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
        return "Doc", "Doc-Bold"
    except Exception:
        return "Helvetica", "Helvetica-Bold"


def draw_invoice(c: canvas.Canvas, spec: dict, regular: str, bold: str, logo: ImageReader) -> dict:
    y = H - 60
    c.drawImage(logo, 55, y - 52, 62, 62, mask="auto")
    c.setFont(bold, 21)
    c.setFillColor(NAVY)
    c.drawString(128, y - 14, "SPITERI")
    c.setFont(regular, 11)
    c.setFillColor(BLUE)
    c.drawString(130, y - 28, "H O M E S")

    c.setFillColor(NAVY)
    c.setFont(regular, 8.5)
    right = W - 55
    for i, line in enumerate([
        "ABN 98 479 906 916",
        "Licence No. CC1630M",
        "",
        "PO Box 133",
        "Newstead Tas 7250",
        "Ph 0418244872",
        spec["email"],
    ]):
        c.drawRightString(right, y - 6 - i * 11, line)

    c.setLineWidth(1)
    c.line(55, y - 62, right, y - 62)
    c.setFont(regular, 15)
    c.drawCentredString(W / 2, y - 92, "TAX INVOICE")

    top = y - 130
    c.setFont(regular, 9)
    c.drawString(55, top, "Vicki Donald & Mark")
    c.drawString(55, top - 12, "Shliebs")

    col = W - 200
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
    c.drawString(55, ty - 20, "Construction of new residential dwelling at 24")
    c.drawString(55, ty - 31, "Westbury Pl, Deloraine")
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
    data = b"%PDF-" + version.encode() + data[len(b"%PDF-1.4"):] if data.startswith(b"%PDF-1.") else data
    path.write_bytes(data)


def build_authentic(number: str, date_str: str, due: str, reference: str, item: str,
                    unit: str, subtotal: str, gst: str, total: str, out: str,
                    title: str, created: str) -> Path:
    path = OUT / out
    regular, bold = _fonts(embed=False)
    c = canvas.Canvas(str(path), pagesize=A4)
    draw_invoice(c, {
        "email": "bjorn@spiterihomes.com.au", "date": date_str, "number": number,
        "reference": reference, "item": item, "unit_price": unit, "line_amount": subtotal,
        "subtotal": subtotal, "gst": gst, "total": total, "due": due,
        "account_name": "Spiteri Homes Pty Ltd", "bank": "ANZ",
        "bsb": "017 042", "account": "475503373",
    }, regular, bold, _logo(120, 1, noisy=False))
    c.save()
    set_metadata(path, producer="Microsoft: Print To PDF", creator="Microsoft: Print To PDF",
                 title=title, author="J Mejia", created=created, modified=created, version="1.7")
    return path


def build_fraudulent() -> Path:
    """The forgery: same template, re-rendered anonymously, money sent elsewhere."""
    path = OUT / "fraudulent_INV-101544.pdf"
    regular, bold = _fonts(embed=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    draw_invoice(c, {
        "email": "bjorn@spiterihomes.com.au", "date": "10 Feb 2026", "number": "INV-101544",
        "reference": "1132", "item": "Base stage", "unit_price": "43,181.8182",
        "line_amount": "43,181.82", "subtotal": "43,181.82", "gst": "4,318.18",
        "total": "47,500.00", "due": "24 Feb 2026",
        "account_name": "Spiteri Homes Pty Ltd", "bank": "Commonwealth",
        "bsb": "064-242", "account": "10118743",
    }, regular, bold, _logo(600, 7, noisy=True))
    c.save()
    set_metadata(path, producer="Pdftools SDK", creator="", title=None, author=None,
                 created="D:20260209231900+11'00'", modified="D:20260209232400+11'00'",
                 version="1.4")
    return path


def build_tampered() -> Path:
    """A cruder forgery: the genuine PDF with a white patch pasted over the
    payment block and replacement details typed on top."""
    path = OUT / "tampered_INV-101541.pdf"
    regular, bold = _fonts(embed=False)
    patch_font, _ = _fonts(embed=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    geom = draw_invoice(c, {
        "email": "bjorn@spiterihomes.com.au", "date": "08 Jan 2026", "number": "INV-101541",
        "reference": "1132", "item": "Frame stage", "unit_price": "28,863.6364",
        "line_amount": "28,863.64", "subtotal": "28,863.64", "gst": "2,886.36",
        "total": "31,750.00", "due": "22 Jan 2026",
        "account_name": "Spiteri Homes Pty Ltd", "bank": "ANZ",
        "bsb": "017 042", "account": "475503373",
    }, regular, bold, _logo(120, 1, noisy=False))

    ys = geom["payment_y"]
    top = ys["Bank"] + 9
    bottom = ys["Account"] - 3
    c.setFillColor(white)
    c.setStrokeColor(white)
    c.rect(50, bottom, 250, top - bottom, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.setFont(patch_font, 8.5)
    c.drawString(55, ys["Bank"], "Bank: Commonwealth")
    c.drawString(55, ys["BSB"], "BSB: 064-242")
    c.drawString(55, ys["Account"], "Account: 10118743")
    c.save()
    set_metadata(path, producer="iLovePDF", creator="Microsoft: Print To PDF",
                 title=None, author=None, created="D:20260107091200+11'00'",
                 modified="D:20260108184500+11'00'", version="1.4")
    return path


def main() -> None:
    made = [
        build_authentic("INV-101538", "05 Nov 2025", "19 Nov 2025", "1132",
                        "Site works - Waste water system", "21,590.9091",
                        "21,590.91", "2,159.09", "23,750.00",
                        "authentic_INV-101538.pdf", "Invoice INV-101538 (1).pdf",
                        "D:20251105104000+11'00'"),
        build_authentic("INV-101540", "03 Dec 2025", "17 Dec 2025", "1132",
                        "Slab stage", "34,545.4545",
                        "34,545.45", "3,454.55", "38,000.00",
                        "authentic_INV-101540.pdf", "Invoice INV-101540.pdf",
                        "D:20251203093000+11'00'"),
        build_authentic("INV-101551", "12 Feb 2026", "26 Feb 2026", "1132",
                        "Frame stage", "28,863.6364",
                        "28,863.64", "2,886.36", "31,750.00",
                        "authentic_INV-101551.pdf", "Invoice INV-101551.pdf",
                        "D:20260212081500+11'00'"),
        build_fraudulent(),
        build_tampered(),
    ]
    for p in made:
        print(f"{p.name:32} {p.stat().st_size:>8,} bytes")


if __name__ == "__main__":
    sys.exit(main())
