import { describe, expect, it } from "vitest";
import { buildZip } from "./zip-fixture";
import { columnIndex, excelDate, formatIsDate, MAX_COLS, MAX_ROWS, readXlsx } from "./xlsx";
import { openZip } from "./zip";

const WORKBOOK =
  '<?xml version="1.0"?><workbook xmlns:r="x"><sheets>' +
  '<sheet name="财报" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS =
  '<?xml version="1.0"?><Relationships xmlns="x">' +
  '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';

/** Build a workbook around one sheet's `sheetData` rows. */
function xlsx(rows: string, extra: Record<string, string> = {}) {
  return openZip(
    buildZip({
      "xl/workbook.xml": WORKBOOK,
      "xl/_rels/workbook.xml.rels": RELS,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`,
      ...extra,
    }),
  );
}

const sharedStrings = (...values: string[]) =>
  `<?xml version="1.0"?><sst count="${values.length}">${values.map((v) => `<si><t>${v}</t></si>`).join("")}</sst>`;

/** A styles part whose cellXfs entry `i` uses numFmtId `ids[i]`. */
const styles = (ids: number[], custom: Array<[number, string]> = []) =>
  '<?xml version="1.0"?><styleSheet><numFmts>' +
  custom.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`).join("") +
  "</numFmts><cellXfs>" +
  ids.map((id) => `<xf numFmtId="${id}"/>`).join("") +
  "</cellXfs></styleSheet>";

describe("columnIndex", () => {
  it("decodes base-26 column letters", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA1")).toBe(26);
    expect(columnIndex("BC12")).toBe(54);
  });

  it("returns -1 for a ref with no column letters", () => {
    expect(columnIndex("12")).toBe(-1);
    expect(columnIndex("")).toBe(-1);
  });
});

describe("excelDate", () => {
  it("lines serials up with real dates on both sides of the 1900 leap bug", () => {
    // 45000 is 2023-03-15 in Excel; the two-day Lotus offset is what makes it so.
    expect(excelDate(45000, false)).toBe("2023-03-15");
    expect(excelDate(61, false)).toBe("1900-03-01");
    // Below the phantom 1900-02-29 the offset is one day, not two.
    expect(excelDate(1, false)).toBe("1900-01-01");
    expect(excelDate(59, false)).toBe("1900-02-28");
  });

  it("adds a time part when the serial has a fraction", () => {
    expect(excelDate(45000.5, false)).toBe("2023-03-15 12:00:00");
  });

  it("renders a bare time-of-day without a date", () => {
    expect(excelDate(0.25, true)).toBe("06:00:00");
  });
});

describe("formatIsDate", () => {
  it("accepts date and time codes", () => {
    expect(formatIsDate("yyyy-mm-dd")).toBe(true);
    expect(formatIsDate("h:mm:ss")).toBe(true);
  });

  it("ignores letters inside literals, escapes and brackets", () => {
    expect(formatIsDate('#,##0.00" USD"')).toBe(false);
    expect(formatIsDate("[Red]#,##0")).toBe(false);
    expect(formatIsDate("0.00\\%")).toBe(false);
  });
});

describe("readXlsx", () => {
  it("resolves shared strings, numbers, booleans and errors", async () => {
    const rows =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>332.8</v></c><c r="B2" t="b"><v>1</v></c>' +
      '<c r="C2" t="e"><v>#DIV/0!</v></c></row>';
    const { sheets } = await readXlsx(xlsx(rows, { "xl/sharedStrings.xml": sharedStrings("指标", "2025A") }));
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("财报");
    expect(sheets[0].rows).toEqual([
      ["指标", "2025A", ""],
      ["332.8", "TRUE", "#DIV/0!"],
    ]);
  });

  it("reads inline strings and cached formula strings", async () => {
    const rows =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>内联</t></is></c>' +
      '<c r="B1" t="str"><f>A1</f><v>公式结果</v></c></row>';
    const { sheets } = await readXlsx(xlsx(rows));
    expect(sheets[0].rows).toEqual([["内联", "公式结果"]]);
  });

  it("joins rich-text runs in a shared string", async () => {
    const sst = '<?xml version="1.0"?><sst><si><r><t>迈</t></r><r><t>瑞</t></r></si></sst>';
    const { sheets } = await readXlsx(
      xlsx('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', { "xl/sharedStrings.xml": sst }),
    );
    expect(sheets[0].rows).toEqual([["迈瑞"]]);
  });

  it("fills gaps from cell refs and pads short rows", async () => {
    const rows = '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row><row r="2"><c r="A2"><v>4</v></c></row>';
    const { sheets } = await readXlsx(xlsx(rows));
    expect(sheets[0].rows).toEqual([
      ["1", "", "3"],
      ["4", "", ""],
    ]);
    expect(sheets[0].totalCols).toBe(3);
  });

  it("treats cells without a ref as consecutive", async () => {
    const { sheets } = await readXlsx(xlsx("<row><c><v>1</v></c><c><v>2</v></c></row>"));
    expect(sheets[0].rows).toEqual([["1", "2"]]);
  });

  it("formats date-styled numbers instead of showing the serial", async () => {
    const rows = '<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="0"><v>45000</v></c></row>';
    // Style 0 is General, style 1 is built-in numFmtId 14 (a date).
    const { sheets } = await readXlsx(xlsx(rows, { "xl/styles.xml": styles([0, 14]) }));
    expect(sheets[0].rows).toEqual([["2023-03-15", "45000"]]);
  });

  it("honours a custom date format code", async () => {
    const rows = '<row r="1"><c r="A1" s="0"><v>45000</v></c></row>';
    const { sheets } = await readXlsx(
      xlsx(rows, { "xl/styles.xml": styles([176], [[176, "yyyy&quot;年&quot;m&quot;月&quot;"]]) }),
    );
    expect(sheets[0].rows).toEqual([["2023-03-15"]]);
  });

  it("caps rows and columns but reports the real size", async () => {
    const wide = Array.from({ length: MAX_COLS + 5 }, (_, i) => `<c><v>${i}</v></c>`).join("");
    const rows = Array.from({ length: MAX_ROWS + 3 }, () => `<row>${wide}</row>`).join("");
    const { sheets } = await readXlsx(xlsx(rows));
    expect(sheets[0].rows).toHaveLength(MAX_ROWS);
    expect(sheets[0].rows[0]).toHaveLength(MAX_COLS);
    expect(sheets[0].totalRows).toBe(MAX_ROWS + 3);
    expect(sheets[0].totalCols).toBe(MAX_COLS + 5);
  });

  it("drops trailing empty rows", async () => {
    const rows = '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v></v></c></row>';
    const { sheets } = await readXlsx(xlsx(rows));
    expect(sheets[0].rows).toEqual([["1"]]);
    // The empty row still counted towards the sheet's real height.
    expect(sheets[0].totalRows).toBe(2);
  });

  it("falls back to positional sheet parts when rels are missing", async () => {
    const zip = openZip(
      buildZip({
        "xl/workbook.xml": WORKBOOK,
        "xl/worksheets/sheet1.xml": '<?xml version="1.0"?><worksheet><sheetData><row><c><v>9</v></c></row></sheetData></worksheet>',
      }),
    );
    expect((await readXlsx(zip)).sheets[0].rows).toEqual([["9"]]);
  });

  it("keeps every sheet, in workbook order", async () => {
    const wb =
      '<?xml version="1.0"?><workbook xmlns:r="x"><sheets>' +
      '<sheet name="一" r:id="rId1"/><sheet name="二" r:id="rId2"/></sheets></workbook>';
    const rels =
      '<?xml version="1.0"?><Relationships xmlns="x">' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="/xl/worksheets/other.xml"/></Relationships>';
    const sheet = (v: string) =>
      `<?xml version="1.0"?><worksheet><sheetData><row><c><v>${v}</v></c></row></sheetData></worksheet>`;
    const zip = openZip(
      buildZip({
        "xl/workbook.xml": wb,
        "xl/_rels/workbook.xml.rels": rels,
        "xl/worksheets/sheet1.xml": sheet("1"),
        "xl/worksheets/other.xml": sheet("2"),
      }),
    );
    const { sheets } = await readXlsx(zip);
    expect(sheets.map((s) => s.name)).toEqual(["一", "二"]);
    expect(sheets[1].rows).toEqual([["2"]]);
  });

  it("fails with a readable message when the workbook part is missing", async () => {
    await expect(readXlsx(openZip(buildZip({ "docProps/app.xml": "<x/>" })))).rejects.toThrow(/xl\/workbook\.xml/);
  });
});
