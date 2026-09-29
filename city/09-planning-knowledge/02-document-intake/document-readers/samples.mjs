/**
 * UTOPIA · City · Document Intake — synthetic sample documents.
 *
 * Shipping three binary documents into the repository would be the wrong trade: the
 * bytes would be unreadable in review and stale the moment a reader changes. Instead
 * every sample is assembled in memory from its own specification:
 *
 *   xlsx   a real OOXML package (fflate deflates the parts)
 *   docx   a real OOXML package (fflate deflates the parts)
 *   pdf    a real PDF 1.4 document (hand-assembled, with a correct xref table)
 *
 * Nothing here is written to disk and nothing is fetched: `buildSample()` returns
 * bytes, and a reader decodes them with its real engine, so a product surface and a
 * test can both run against real bytes without a committed fixture.
 */

import { loadFflate } from './engines.mjs';

/** Sample kinds this module can build. */
export const SAMPLE_KINDS = Object.freeze(['xlsx', 'docx', 'pdf']);

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function zip(entries) {
  const { zipSync, strToU8 } = await loadFflate();
  const input = {};
  for (const [name, content] of Object.entries(entries)) {
    input[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(input);
}

/* ------------------------------------------------------------------ xlsx */

/** A two-sheet workbook: shared strings, a formula without a cached value, numbers. */
export async function buildXlsx({ sheetName = 'Inventory', rows = [['id', 'item', 'qty'], ['a1', 'trust anchor', '3'], ['b2', 'memory shelf', '4']] } = {}) {
  const shared = [];
  const sharedIndex = new Map();
  const inline = (value) => {
    if (typeof value === 'number') return `<c r="A1" t="n"><v>${value}</v></c>`;
    if (!sharedIndex.has(value)) {
      sharedIndex.set(value, shared.length);
      shared.push(value);
    }
    return { index: sharedIndex.get(value) };
  };
  // Build the sheet body with per-cell references, so the reader sees a real grid.
  const body = [];
  rows.forEach((row, rowIndex) => {
    const cells = [];
    row.forEach((value, columnIndex) => {
      const reference = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
      if (typeof value === 'number') {
        cells.push(`<c r="${reference}" t="n"><v>${value}</v></c>`);
        return;
      }
      if (String(value).startsWith('=')) {
        // a formula with no cached value: the reader must warn, never invent one
        cells.push(`<c r="${reference}"><f>${xmlEscape(String(value).slice(1))}</f></c>`);
        return;
      }
      inline(value);
      cells.push(`<c r="${reference}" t="s"><v>${sharedIndex.get(value)}</v></c>`);
    });
    body.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`);
  });
  body.push('<row r="99"><c r="A99"><f>SUM(C2:C3)</f></c></row>');

  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((value) => `<si><t>${xmlEscape(value)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C4"/><sheetData>${body.join('')}</sheetData></worksheet>`,
  });
}

/* ------------------------------------------------------------------ docx */

/** A three-paragraph document with a heading and a bullet list. */
export async function buildDocx({ heading = 'Intake Note', paragraphs = ['The lab reads real OOXML.', 'Nothing is written to disk.'] } = {}) {
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlEscape(heading)}</w:t></w:r></w:p>`,
    ...paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`),
    '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>first bullet</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>second bullet</w:t></w:r></w:p>',
  ].join('');
  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/* ------------------------------------------------------------------- pdf */

/**
 * A minimal but genuinely valid PDF 1.4 document: one page, one text object drawn
 * with a standard font, and a correct cross-reference table.
 */
export function buildPdf({ lines = ['Intake note', 'The lab reads real PDF bytes.'], pageWidth = 612, pageHeight = 792 } = {}) {
  const content = [
    'BT',
    '/F1 18 Tf',
    '72 720 Td',
    ...lines.flatMap((line, index) => (index === 0 ? [`(${escapePdfText(line)}) Tj`] : ['0 -24 Td', `(${escapePdfText(line)}) Tj`])),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function escapePdfText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build one sample document.
 *
 * @param {'xlsx'|'docx'|'pdf'} kind
 * @returns {Promise<{kind: string, fileName: string, bytes: Buffer, bytesLength: number}>}
 */
export async function buildSample(kind) {
  const name = String(kind || '').toLowerCase();
  if (!SAMPLE_KINDS.includes(name)) throw new Error(`unknown sample kind "${kind}" (known: ${SAMPLE_KINDS.join(', ')})`);
  if (name === 'xlsx') {
    const bytes = Buffer.from(await buildXlsx());
    return { kind: name, fileName: 'sample-inventory.xlsx', bytes, bytesLength: bytes.length };
  }
  if (name === 'docx') {
    const bytes = Buffer.from(await buildDocx());
    return { kind: name, fileName: 'sample-intake-note.docx', bytes, bytesLength: bytes.length };
  }
  const bytes = buildPdf();
  return { kind: name, fileName: 'sample-intake-note.pdf', bytes, bytesLength: bytes.length };
}
