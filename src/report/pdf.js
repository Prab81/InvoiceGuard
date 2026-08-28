// PDF export: laid out directly with jsPDF.
//
// Deliberately not a screenshot of the page. The report is a document a
// reviewer may attach to a case file, so it is typeset as one - wrapped
// paragraphs, tables that repeat their header across a page break, and a
// footer that numbers the pages.

import { jsPDF } from 'jspdf';

const PAGE = { w: 210, h: 297, margin: 15 };
const CONTENT_W = PAGE.w - PAGE.margin * 2;

const SEVERITY_RGB = {
  critical: [158, 28, 49], high: [138, 82, 16], medium: [117, 96, 18],
  low: [74, 96, 118], info: [23, 96, 74],
};
const INK = [19, 27, 38];
const MUTED = [79, 93, 110];
const FAINT = [123, 135, 151];
const ACCENT = [23, 90, 112];
const RULE = [217, 223, 232];
const FLAG_BG = [251, 233, 236];
const HEAD_BG = [238, 241, 246];

export function buildPdf(report) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  let y = PAGE.margin;

  const setFont = (size, style = 'normal', rgb = INK) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...rgb);
  };

  const newPage = () => { doc.addPage(); y = PAGE.margin; };
  const room = (needed) => { if (y + needed > PAGE.h - PAGE.margin - 8) newPage(); };

  const text = (str, { size = 9, style = 'normal', rgb = INK, width = CONTENT_W, x = PAGE.margin, gap = 1.6 } = {}) => {
    setFont(size, style, rgb);
    const lines = doc.splitTextToSize(String(str ?? ''), width);
    for (const line of lines) {
      room(size * 0.42);
      doc.text(line, x, y);
      y += size * 0.42;
    }
    y += gap;
  };

  /* ---- tables ------------------------------------------------------- */
  const table = (columns, rows, { widths, flagColumn, flagValue } = {}) => {
    const cols = widths || columns.map(() => CONTENT_W / columns.length);
    const pad = 1.6;
    const fontSize = 7.6;

    const drawHeader = () => {
      room(7);
      doc.setFillColor(...HEAD_BG);
      doc.rect(PAGE.margin, y - 3.2, CONTENT_W, 5.6, 'F');
      setFont(fontSize, 'bold', MUTED);
      let x = PAGE.margin;
      columns.forEach((c, i) => { doc.text(String(c), x + pad, y); x += cols[i]; });
      y += 4.4;
      doc.setDrawColor(...RULE);
      doc.line(PAGE.margin, y - 2.2, PAGE.margin + CONTENT_W, y - 2.2);
    };

    drawHeader();
    for (const row of rows) {
      setFont(fontSize, 'normal', INK);
      const cells = row.map((v, i) => doc.splitTextToSize(String(v ?? '—'), cols[i] - pad * 2));
      const height = Math.max(...cells.map((c) => c.length)) * 3.2 + 1.8;
      if (y + height > PAGE.h - PAGE.margin - 8) { newPage(); drawHeader(); }

      const flagged = flagColumn !== undefined && String(row[flagColumn]) === flagValue;
      if (flagged) {
        doc.setFillColor(...FLAG_BG);
        doc.rect(PAGE.margin, y - 3, CONTENT_W, height, 'F');
      }
      let x = PAGE.margin;
      cells.forEach((lines, i) => {
        setFont(fontSize, flagged && i === flagColumn ? 'bold' : 'normal', flagged ? SEVERITY_RGB.critical : INK);
        lines.forEach((line, n) => doc.text(line, x + pad, y + n * 3.2));
        x += cols[i];
      });
      y += height;
      doc.setDrawColor(...RULE);
      doc.line(PAGE.margin, y - 2.6, PAGE.margin + CONTENT_W, y - 2.6);
    }
    y += 3;
  };

  /* ---- header -------------------------------------------------------- */
  text(report.title, { size: 19, style: 'bold', gap: 1 });
  text(report.subtitle, { size: 10, rgb: MUTED, gap: 0.5 });
  text(`Generated ${report.generatedAt.toLocaleString('en-AU')}`, { size: 8, rgb: FAINT, gap: 4 });

  /* ---- sections ------------------------------------------------------ */
  for (const section of report.sections) {
    room(16);
    y += 2;
    text(section.heading, { size: 12, style: 'bold', rgb: ACCENT, gap: 1.2 });
    doc.setDrawColor(...ACCENT);
    doc.setLineWidth(0.3);
    doc.line(PAGE.margin, y - 2.4, PAGE.margin + CONTENT_W, y - 2.4);
    doc.setLineWidth(0.2);
    y += 1.5;

    for (const block of section.blocks) {
      switch (block.type) {
        case 'para':
          text(block.text, {
            size: 8.6,
            rgb: block.tone === 'warn' ? SEVERITY_RGB.critical : block.tone === 'muted' ? MUTED : INK,
            style: block.tone === 'muted' ? 'italic' : 'normal',
          });
          break;
        case 'caption':
          text(block.text, { size: 7.6, rgb: FAINT, gap: 0.8 });
          break;
        case 'bullet':
          text(`•  ${block.text}`, { size: 8.6, x: PAGE.margin + 3, width: CONTENT_W - 3 });
          break;
        case 'subheading':
          y += 1.5;
          text(block.text, { size: 10, style: 'bold', gap: 1 });
          break;
        case 'finding': {
          room(9);
          y += 1.5;
          setFont(7.4, 'bold', SEVERITY_RGB[block.severity] || INK);
          const tag = block.severity.toUpperCase();
          doc.text(tag, PAGE.margin, y);
          const offset = doc.getTextWidth(tag) + 3;
          setFont(9.4, 'bold', INK);
          const titleLines = doc.splitTextToSize(block.title, CONTENT_W - offset - 26);
          titleLines.forEach((line, n) => doc.text(line, PAGE.margin + offset, y + n * 4));
          setFont(7.4, 'normal', FAINT);
          doc.text(`${block.weight > 0 ? '+' : ''}${block.weight} pts`,
            PAGE.margin + CONTENT_W, y, { align: 'right' });
          y += titleLines.length * 4 + 0.6;
          text(block.id, { size: 7.2, rgb: FAINT, gap: 0.8 });
          break;
        }
        case 'kv':
          table(['Field', 'Value'], block.rows.map(([k, v]) => [k, String(v ?? '—')]),
            { widths: [CONTENT_W * 0.32, CONTENT_W * 0.68] });
          break;
        case 'table': {
          if (block.caption) text(block.caption, { size: 9, style: 'bold', gap: 1 });
          const n = block.columns.length;
          const widths = n === 4
            ? [CONTENT_W * 0.14, CONTENT_W * 0.3, CONTENT_W * 0.22, CONTENT_W * 0.34]
            : block.columns.map(() => CONTENT_W / n);
          table(block.columns, block.rows, { ...block, widths });
          break;
        }
        default:
          break;
      }
    }
  }

  /* ---- footer -------------------------------------------------------- */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    setFont(7.2, 'normal', FAINT);
    doc.text('InvoiceGuard — the score is a triage aid; the reason codes are the assessment.',
      PAGE.margin, PAGE.h - 9);
    doc.text(`${i} of ${pages}`, PAGE.margin + CONTENT_W, PAGE.h - 9, { align: 'right' });
  }

  return new Uint8Array(doc.output('arraybuffer'));
}
