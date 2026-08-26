/**
 * Excel (`.xlsx`) → a grid of display strings, for the file preview.
 *
 * A *reading* view: values, shared strings, cached formula results, and dates
 * (Excel stores those as numbers, so the number format has to be consulted or
 * every date reads as "45678"). Not carried over: fonts, fills, merges,
 * charts, pivot tables, conditional formats, or the formulas themselves.
 *
 * Sheets are capped — a preview that renders 100k rows is not a preview — and
 * the caps are reported so the UI can say what it left out.
 */

import { attr, element, elements, parseXml, rootOf, type XmlNode } from "./xml";
import type { ZipArchive } from "./zip";

export const MAX_ROWS = 400;
export const MAX_COLS = 60;

export interface XlsxSheet {
  name: string;
  /** Row-major, rectangular, gaps filled with "". */
  rows: string[][];
  /** Total rows in the sheet, before the cap. */
  totalRows: number;
  /** Total columns in the sheet, before the cap. */
  totalCols: number;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

/** `A1` / `BC12` → zero-based column index. -1 when the ref is unusable. */
export function columnIndex(ref: string): number {
  let col = 0;
  let seen = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) col = col * 26 + (code - 64);
    else if (code >= 97 && code <= 122) col = col * 26 + (code - 96);
    else break;
    seen++;
  }
  return seen === 0 ? -1 : col - 1;
}

/**
 * Excel serial date → `YYYY-MM-DD`, plus a time part when there is a fraction.
 *
 * Excel treats 1900 as a leap year for Lotus compatibility, so its calendar
 * has a phantom 1900-02-29 at serial 60. That splits the conversion in two:
 * from serial 61 (1900-03-01) on, the epoch is 1899-12-30; below it, the
 * phantom day has not been passed yet and the epoch is 1899-12-31, which is
 * what makes serial 1 come out as 1900-01-01. Serial 60 itself names a day
 * that never existed and lands on 1900-02-28.
 */
export function excelDate(serial: number, withTime: boolean): string {
  const days = Math.floor(serial);
  const secondsOfDay = Math.round((serial - days) * 86400);
  const epochDay = days < 60 ? 31 : 30;
  const ms = Date.UTC(1899, 11, epochDay) + days * 86400000 + secondsOfDay * 1000;
  if (!Number.isFinite(ms)) return String(serial);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!withTime && secondsOfDay === 0) return date;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  // A serial below 1 is a bare time of day; showing a date would be noise.
  return days === 0 ? time : `${date} ${time}`;
}

/** Built-in number-format ids that mean date and/or time. */
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_TIME_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);

/** Does a custom format code render a date or time? */
export function formatIsDate(code: string): boolean {
  // Drop quoted literals, escaped chars and bracketed sections ([Red], [$-409])
  // so their letters cannot be mistaken for format tokens.
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare);
}

function formatIsTime(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[hs]/i.test(bare);
}

/** Per-style-index date flags, from `xl/styles.xml`. */
interface DateStyles {
  isDate: boolean[];
  isTime: boolean[];
}

async function readStyles(zip: ZipArchive): Promise<DateStyles> {
  const out: DateStyles = { isDate: [], isTime: [] };
  if (!zip.has("xl/styles.xml")) return out;
  let root: XmlNode | null;
  try {
    root = rootOf(parseXml(await zip.textOf("xl/styles.xml")));
  } catch {
    return out;
  }
  const custom = new Map<number, string>();
  for (const fmt of elements(element(root, "numFmts"), "numFmt")) {
    const id = Number(attr(fmt, "numFmtId"));
    const code = attr(fmt, "formatCode");
    if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
  }
  const xfs = elements(element(root, "cellXfs"), "xf");
  xfs.forEach((xf, i) => {
    const id = Number(attr(xf, "numFmtId") ?? "0");
    const code = custom.get(id);
    out.isDate[i] = code !== undefined ? formatIsDate(code) : BUILTIN_DATE_IDS.has(id);
    out.isTime[i] = code !== undefined ? formatIsTime(code) : BUILTIN_TIME_IDS.has(id);
  });
  return out;
}

/** Shared string table: one display string per `si`, rich-text runs joined. */
async function readSharedStrings(zip: ZipArchive): Promise<string[]> {
  if (!zip.has("xl/sharedStrings.xml")) return [];
  let root: XmlNode | null;
  try {
    root = rootOf(parseXml(await zip.textOf("xl/sharedStrings.xml")));
  } catch {
    return [];
  }
  return elements(root, "si").map(sharedStringText);
}

function sharedStringText(si: XmlNode): string {
  // `si` is either a single `t`, or `r` runs each with their own `t`.
  // `rPh` holds furigana for CJK text and would duplicate the reading.
  let out = element(si, "t")?.text ?? "";
  for (const r of elements(si, "r")) out += element(r, "t")?.text ?? "";
  return out;
}

/** Sheet order and names from the workbook part, resolved to zip paths. */
async function readSheetIndex(zip: ZipArchive): Promise<Array<{ name: string; part: string }>> {
  const root = rootOf(parseXml(await zip.textOf("xl/workbook.xml")));
  const rels = new Map<string, string>();
  if (zip.has("xl/_rels/workbook.xml.rels")) {
    try {
      const relRoot = rootOf(parseXml(await zip.textOf("xl/_rels/workbook.xml.rels")));
      for (const rel of elements(relRoot, "Relationship")) {
        const id = attr(rel, "Id");
        const target = attr(rel, "Target");
        if (id && target) rels.set(id, target);
      }
    } catch {
      // Fall back to positional sheet parts below.
    }
  }
  const out: Array<{ name: string; part: string }> = [];
  elements(element(root, "sheets"), "sheet").forEach((sheet, i) => {
    const name = attr(sheet, "name") ?? `Sheet${i + 1}`;
    const relId = attr(sheet, "id");
    const target = relId !== undefined ? rels.get(relId) : undefined;
    // Targets are relative to xl/, except absolute ones which are package-rooted.
    let part = target
      ? target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, "")}`
      : `xl/worksheets/sheet${i + 1}.xml`;
    if (!zip.has(part)) {
      const guess = zip.find((n) => n.endsWith(`/${part.split("/").pop()}`));
      if (guess) part = guess;
    }
    out.push({ name, part });
  });
  return out;
}

/** Display string for one `c` element. */
function cellText(c: XmlNode, shared: string[], styles: DateStyles): string {
  const type = attr(c, "t") ?? "n";
  if (type === "inlineStr") {
    const is = element(c, "is");
    return is ? sharedStringText(is) : "";
  }
  const v = element(c, "v");
  const raw = v?.text ?? "";
  if (type === "s") {
    const i = Number(raw);
    return Number.isInteger(i) && i >= 0 && i < shared.length ? shared[i] : "";
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  // "e" (error) and "str" (cached formula string) are already display text.
  if (type === "e" || type === "str") return raw;
  if (raw === "") return "";
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  const styleIndex = Number(attr(c, "s") ?? "0");
  if (styles.isDate[styleIndex]) return excelDate(num, styles.isTime[styleIndex] === true);
  return String(num);
}

async function readSheet(
  zip: ZipArchive,
  entry: { name: string; part: string },
  shared: string[],
  styles: DateStyles,
): Promise<XlsxSheet> {
  const root = rootOf(parseXml(await zip.textOf(entry.part)));
  const rowEls = elements(element(root, "sheetData"), "row");
  const rows: string[][] = [];
  let totalCols = 0;
  let rowIndex = 0;
  for (const rowEl of rowEls) {
    const cells: string[] = [];
    let colCursor = 0;
    for (const c of elements(rowEl, "c")) {
      const ref = attr(c, "r");
      // Excel omits `r` on dense rows; then cells are simply consecutive.
      const col = ref ? columnIndex(ref) : colCursor;
      const at = col < 0 ? colCursor : col;
      while (cells.length < at) cells.push("");
      cells[at] = cellText(c, shared, styles);
      colCursor = at + 1;
    }
    totalCols = Math.max(totalCols, cells.length);
    if (rowIndex < MAX_ROWS) rows.push(cells.slice(0, MAX_COLS));
    rowIndex++;
  }
  // Trailing all-empty rows and columns are padding, not data.
  while (rows.length > 0 && rows[rows.length - 1].every((v) => v === "")) rows.pop();
  const width = Math.min(totalCols, MAX_COLS);
  for (const row of rows) while (row.length < width) row.push("");
  return { name: entry.name, rows, totalRows: rowIndex, totalCols };
}

export async function readXlsx(zip: ZipArchive): Promise<XlsxWorkbook> {
  if (!zip.has("xl/workbook.xml")) throw new Error("不是有效的 xlsx（缺少 xl/workbook.xml）");
  const [shared, styles, index] = await Promise.all([
    readSharedStrings(zip),
    readStyles(zip),
    readSheetIndex(zip),
  ]);
  const sheets: XlsxSheet[] = [];
  for (const entry of index) {
    if (!zip.has(entry.part)) continue;
    try {
      sheets.push(await readSheet(zip, entry, shared, styles));
    } catch {
      // One unreadable sheet must not lose the rest of the workbook.
      sheets.push({ name: entry.name, rows: [], totalRows: 0, totalCols: 0 });
    }
  }
  if (sheets.length === 0) throw new Error("表格里没有可读取的工作表");
  return { sheets };
}
