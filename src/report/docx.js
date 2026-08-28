// Word export: OOXML written by hand, zipped with fflate.
//
// A .docx is a zip of XML parts. Writing them directly keeps the dependency to
// one small zip library rather than a document toolkit, and the output is a
// real .docx - editable, not an HTML file wearing a .doc extension.

import { strToU8, zipSync } from 'fflate';

// Word rejects XML control characters outright, so they are stripped rather
// than escaped: a malformed producer string must not corrupt the report.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const esc = (s) => String(s ?? '')
  .replace(CONTROL_CHARS, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const SEVERITY_COLOUR = {
  critical: '9E1C31', high: '8A5210', medium: '756012', low: '4A6076', info: '17604A',
};

function run(text, { bold, colour, size, italic } = {}) {
  const props = [
    bold ? '<w:b/>' : '',
    italic ? '<w:i/>' : '',
    colour ? `<w:color w:val="${colour}"/>` : '',
    size ? `<w:sz w:val="${size * 2}"/>` : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}`
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

const para = (runs, { style, spacingAfter = 120, indent } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}`
  + `${indent ? `<w:ind w:left="${indent}"/>` : ''}`
  + `<w:spacing w:after="${spacingAfter}"/></w:pPr>${runs}</w:p>`;

function tableXml(columns, rows, { flagColumn, flagValue } = {}) {
  const width = Math.floor(9360 / columns.length);
  const cell = (text, opts = {}) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>`
    + (opts.shade ? `<w:shd w:val="clear" w:fill="${opts.shade}"/>` : '')
    + `</w:tcPr>${para(run(text, opts), { spacingAfter: 40 })}</w:tc>`;

  const header = '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
    + columns.map((c) => cell(c, { bold: true, shade: 'EEF1F6' })).join('') + '</w:tr>';

  const body = rows.map((r) => {
    const flagged = flagColumn !== undefined && String(r[flagColumn]) === flagValue;
    return '<w:tr>' + r.map((v, i) => cell(v, {
      shade: flagged ? 'FBE9EC' : undefined,
      bold: flagged && i === flagColumn,
    })).join('') + '</w:tr>';
  }).join('');

  return '<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/>'
    + '<w:tblW w:w="9360" w:type="dxa"/>'
    + '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D9DFE8"/>`).join('')
    + '</w:tblBorders></w:tblPr>'
    + header + body + '</w:tbl><w:p><w:pPr><w:spacing w:after="160"/></w:pPr></w:p>';
}

function blockXml(block) {
  switch (block.type) {
    case 'para':
      return para(run(block.text, {
        colour: block.tone === 'warn' ? '9E1C31' : block.tone === 'muted' ? '4F5D6E' : undefined,
        italic: block.tone === 'muted',
      }));
    case 'caption':
      return para(run(block.text, { colour: '7B8797' }), { spacingAfter: 60 });
    case 'bullet':
      return para(run(`•  ${block.text}`), { indent: 280 });
    case 'subheading':
      return para(run(block.text, { bold: true, size: 12 }), { spacingAfter: 80 });
    case 'finding':
      return para(
        run(`${block.severity.toUpperCase()}  `, { bold: true, colour: SEVERITY_COLOUR[block.severity] || '000000' })
        + run(block.title, { bold: true })
        + run(`   ${block.weight > 0 ? '+' : ''}${block.weight} pts · ${block.id}`, { colour: '7B8797' }),
        { spacingAfter: 60 },
      );
    case 'kv':
      return tableXml(['Field', 'Value'], block.rows.map(([k, v]) => [k, String(v ?? '—')]));
    case 'table':
      return (block.caption ? para(run(block.caption, { bold: true }), { spacingAfter: 60 }) : '')
        + tableXml(block.columns, block.rows.map((r) => r.map((v) => String(v ?? '—'))), block);
    default:
      return '';
  }
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="20"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="44"/><w:color w:val="131B26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="320" w:after="120"/><w:pBdr>
      <w:bottom w:val="single" w:sz="6" w:space="2" w:color="175A70"/></w:pBdr></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="175A70"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

export function buildDocx(report) {
  const body = report.sections.map((section) =>
    para(run(section.heading), { style: 'Heading1' })
    + section.blocks.map(blockXml).join(''),
  ).join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${para(run(report.title), { style: 'Title' })}
${para(run(report.subtitle, { colour: '4F5D6E' }) + run(`   ·   generated ${report.generatedAt.toLocaleString('en-AU')}`, { colour: '7B8797' }))}
${body}
${para(run('Generated by InvoiceGuard. The score is a triage aid; the reason codes are the assessment.', { colour: '7B8797', italic: true }))}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709"/></w:sectPr>
</w:body></w:document>`;

  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'word/styles.xml': strToU8(STYLES),
    'word/document.xml': strToU8(document),
  }, { level: 6 });
}
