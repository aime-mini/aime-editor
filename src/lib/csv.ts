/**
 * Reading a delimited text file as the table it is.
 *
 * RFC 4180 as far as real files follow it, plus what they actually do: a field
 * in double quotes may hold the delimiter, a line break and a doubled quote;
 * lines end in `\n` or `\r\n`; the delimiter is whichever of the usual four
 * the file is consistent about, because a spreadsheet saved in a Vietnamese or
 * European locale writes `;` and calls the file `.csv` all the same. A ragged
 * row is padded rather than refused - the table is for looking at the file,
 * not for validating it.
 */

/** The delimiters a "CSV" file is found to use, most common first. */
export const DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** How many leading records decide the delimiter. */
const SAMPLE_RECORDS = 20;

/** A column whose non-empty cells are this often numeric is shown as numbers. */
const NUMERIC_SHARE = 0.9;

export interface CsvTable {
  delimiter: Delimiter;
  /** The first record, which is the header in every file this view is for. */
  header: string[];
  /** Every record after the header, each padded to the header's width. */
  rows: string[][];
  /** Per column, whether it reads as numbers - right-aligned, like a spreadsheet. */
  numeric: boolean[];
}

/** The file as a table, on the delimiter it is found to use. */
export function parseCsv(text: string): CsvTable {
  const delimiter = detectDelimiter(text);
  const records = parseRecords(text, delimiter).filter((record) => !isBlank(record));
  const header = records[0] ?? [];
  const width = Math.max(header.length, ...records.map((record) => record.length));
  const paddedHeader = padTo(header, width);
  const rows = records.slice(1).map((record) => padTo(record, width));
  return { delimiter, header: paddedHeader, rows, numeric: numericColumns(rows, width) };
}

/**
 * The delimiter the file is consistent about: for each candidate, the field
 * count of the first records is taken, and the candidate that splits every
 * sampled record into the same number of fields - more than one - wins. Ties go
 * to the more common delimiter, which is the order of `DELIMITERS`.
 */
export function detectDelimiter(text: string): Delimiter {
  let best: { delimiter: Delimiter; fields: number } | null = null;
  for (const delimiter of DELIMITERS) {
    const sample = parseRecords(text, delimiter, SAMPLE_RECORDS).filter((record) => !isBlank(record));
    if (sample.length === 0) continue;
    const widths = new Set(sample.map((record) => record.length));
    const width = sample[0].length;
    if (widths.size !== 1 || width < 2) continue;
    if (best === null || width > best.fields) best = { delimiter, fields: width };
  }
  return best?.delimiter ?? ",";
}

/**
 * The records of the text, quotes honoured. `limit` stops the scan early for
 * the delimiter sample, so a large file is not read four times over.
 */
function parseRecords(text: string, delimiter: string, limit = Number.POSITIVE_INFINITY): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(field);
      records.push(record);
      if (records.length >= limit) return records;
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function isBlank(record: string[]): boolean {
  return record.every((cell) => cell.trim() === "");
}

function padTo(record: string[], width: number): string[] {
  return record.length >= width ? record : [...record, ...Array<string>(width - record.length).fill("")];
}

/** Per column, whether nine in ten of its filled cells are numbers. */
function numericColumns(rows: string[][], width: number): boolean[] {
  return Array.from({ length: width }, (_, column) => {
    let filled = 0;
    let numbers = 0;
    for (const row of rows) {
      const cell = (row[column] ?? "").trim();
      if (cell === "") continue;
      filled++;
      if (isNumber(cell)) numbers++;
    }
    return filled > 0 && numbers / filled >= NUMERIC_SHARE;
  });
}

/** `1`, `-2.5`, `1,234`, `1.234,56`, `12%`, `$3` - what a spreadsheet writes as a number. */
function isNumber(cell: string): boolean {
  return /^[-+]?[$€£]?\s?\d[\d.,\s]*%?$/.test(cell);
}

/** Whether a path is a file this view is for. */
export function isDelimitedFile(path: string): boolean {
  return /\.(csv|tsv)$/i.test(path);
}
