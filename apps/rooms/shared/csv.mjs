/**
 * UTOPIA · Rooms — minimal RFC4180-style CSV parser.
 *
 * Scope: quoted fields, escaped quotes ("") , commas and newlines inside quotes,
 * CRLF or LF records. No Excel dialect, no streaming, no type coercion.
 */

/** Parse CSV text into an array of rows (each row an array of strings). */
export function parseCsv(text, { delimiter = ',', maxRows = 5000 } = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new Error(`CSV exceeds ${maxRows} rows`);
  };

  while (index < source.length) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      pushField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      pushRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (inQuotes) throw new Error('CSV ended inside a quoted field');
  if (field !== '' || row.length > 0) pushRow();

  // drop a single trailing empty record produced by a final newline
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') rows.pop();
  }
  return rows;
}

/**
 * Summarize CSV text: column names from the first record plus a row preview.
 * @returns {{columns: string[], rows: string[][], rowCount: number, columnCount: number, truncated: boolean}}
 */
export function summarizeCsv(text, { previewRows = 50 } = {}) {
  const rows = parseCsv(text);
  const columns = rows.length > 0 ? rows[0].map((name, index) => (name === '' ? `column_${index + 1}` : name)) : [];
  const body = rows.slice(1);
  return {
    columns,
    rows: body.slice(0, previewRows),
    rowCount: body.length,
    columnCount: columns.length,
    truncated: body.length > previewRows,
  };
}
