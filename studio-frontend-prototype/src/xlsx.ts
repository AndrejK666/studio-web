// Minimal XLSX writer: sheets of strings and numbers, a bold frozen header
// row, nothing else. Built on the stored-zip writer in ./zip so a download
// does not pull in a spreadsheet library. Not a general-purpose one: no
// formulas, dates or merged cells — a date goes in as its ISO text.

import { makeZip } from "./zip";

export type Cell = string | number | null | undefined;

export interface Sheet {
  /** Excel allows 31 characters and none of `[]:*?/\`; longer is cut. */
  name: string;
  /** The first row is the header. */
  rows: Cell[][];
  /** Column widths in characters, by position; the rest are Excel's default. */
  widths?: number[];
  /** Rows set in bold, by index; the header row when not given. */
  bold?: number[];
  /** Keep the first row in view while scrolling. On unless false. */
  freeze?: boolean;
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters other than tab and newlines are not valid XML.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** `0` → `A`, `25` → `Z`, `26` → `AA`. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet";
}

function cellXml(value: Cell, ref: string, header: boolean): string {
  if (value === null || value === undefined || value === "") return "";
  const style = header ? ' s="1"' : "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
}

export function sheetXml(sheet: Sheet): string {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("")}</cols>`
    : "";
  const bold = new Set(sheet.bold ?? [0]);
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row.map((v, c) => cellXml(v, `${columnName(c)}${r + 1}`, bold.has(r))).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const freeze =
    sheet.freeze !== false && sheet.rows.length > 1
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `${freeze}${cols}<sheetData>${rows}</sheetData></worksheet>`
  );
}

/** The workbook's files, by path — what `makeXlsx` zips. */
export function xlsxFiles(sheets: Sheet[]): { name: string; content: string }[] {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const pkg = "http://schemas.openxmlformats.org/package/2006/relationships";
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const used = new Set<string>();
  const names = sheets.map((s) => {
    const base = sheetName(s.name);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
  return [
    {
      name: "[Content_Types].xml",
      content:
        head +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      content:
        head +
        `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content:
        head +
        `<workbook ${ns} xmlns:r="${rel}"><sheets>` +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets></workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content:
        head +
        `<Relationships xmlns="${pkg}">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/>` +
        "</Relationships>",
    },
    {
      name: "xl/styles.xml",
      content:
        head +
        `<styleSheet ${ns}>` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>",
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) })),
  ];
}

export function makeXlsx(sheets: Sheet[]): Blob {
  return new Blob([makeZip(xlsxFiles(sheets))], { type: XLSX_MIME });
}
