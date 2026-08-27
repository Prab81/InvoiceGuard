"""HTTP surface + static UI host."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .analyzer import analyze_pair, analyze_single
from .baseline import BaselineStore
from .extract import extract

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SAMPLES = ROOT / "samples"
MAX_BYTES = 20 * 1024 * 1024

app = FastAPI(title="InvoiceGuard", version="0.1.0",
              description="Layered detection of redirected and forged supplier invoices.")
store = BaselineStore()


def _read(upload: UploadFile) -> bytes:
    data = upload.file.read()
    if not data:
        raise HTTPException(400, f"{upload.filename or 'file'} is empty.")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"{upload.filename} exceeds the {MAX_BYTES // 1024 // 1024} MB limit.")
    if not data.startswith(b"%PDF"):
        raise HTTPException(415, f"{upload.filename} is not a PDF.")
    return data


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "suppliers_on_file": len(store.suppliers)}


@app.post("/api/analyze")
async def analyze(
    invoice: UploadFile = File(...),
    reference: UploadFile | None = File(None),
    supplier_hint: str | None = Form(None),
) -> JSONResponse:
    data = _read(invoice)
    if reference is not None and reference.filename:
        ref = _read(reference)
        result = analyze_pair(data, invoice.filename or "invoice.pdf",
                              ref, reference.filename or "reference.pdf",
                              store, supplier_hint=supplier_hint or None)
    else:
        result = analyze_single(data, invoice.filename or "invoice.pdf", store,
                                supplier_hint=supplier_hint or None)
    return JSONResponse(result)


@app.post("/api/analyze/sample")
async def analyze_sample(name: str = Form(...), reference_name: str | None = Form(None)) -> JSONResponse:
    path = SAMPLES / Path(name).name
    if not path.exists():
        raise HTTPException(404, f"No sample named {name}.")
    if reference_name:
        ref_path = SAMPLES / Path(reference_name).name
        if not ref_path.exists():
            raise HTTPException(404, f"No sample named {reference_name}.")
        return JSONResponse(analyze_pair(path.read_bytes(), path.name,
                                         ref_path.read_bytes(), ref_path.name, store))
    return JSONResponse(analyze_single(path.read_bytes(), path.name, store))


@app.get("/api/samples")
def samples() -> dict:
    return {"samples": sorted(p.name for p in SAMPLES.glob("*.pdf"))}


@app.get("/api/baselines")
def baselines() -> dict:
    return {"suppliers": [s.to_dict() for s in store.suppliers.values()]}


@app.post("/api/baselines/accept")
async def accept(
    invoice: UploadFile = File(...),
    verified: str = Form("false"),
    note: str | None = Form(None),
    supplier_hint: str | None = Form(None),
) -> JSONResponse:
    """Record a document the bank has confirmed as genuine.

    `verified=true` means the destination account was confirmed out-of-band -
    a call-back to the number held in the contract, not one taken from the
    document. That flag is what later invoices are measured against.
    """
    inv = extract(_read(invoice), invoice.filename or "invoice.pdf", supplier_hint=supplier_hint or None)
    try:
        sup = store.observe(inv, verified=verified.lower() in ("1", "true", "yes"), note=note)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return JSONResponse({"supplier": sup.to_dict()})


@app.delete("/api/baselines")
def reset() -> dict:
    store.reset()
    return {"status": "cleared"}


@app.post("/api/baselines/seed")
def seed() -> dict:
    """Load the bundled genuine invoices as this supplier's payment history."""
    store.reset()
    for name, note in [
        ("authentic_INV-101538.pdf",
         "Account confirmed by call-back to the number in the building contract, 06 Nov 2025."),
        ("authentic_INV-101540.pdf", None),
    ]:
        path = SAMPLES / name
        if path.exists():
            store.observe(extract(path.read_bytes(), name), verified=note is not None, note=note)
    return {"suppliers": [s.to_dict() for s in store.suppliers.values()]}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


app.mount("/static", StaticFiles(directory=WEB), name="static")
