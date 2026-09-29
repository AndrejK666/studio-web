/*
 * A minimal XLSX writer: sheets of strings and numbers, bold rows, a frozen
 * header, nothing else. No formulas, dates or merged cells -- a date goes in
 * as its ISO text. The package is a stored (uncompressed) zip, written here so
 * a workbook does not pull a spreadsheet library into the IDE bundle.
 *
 * The portal prototype has the same writer (`studio-frontend-prototype/src/
 * xlsx.ts`); the two share nothing at build time, so a fix goes into both.
 */

export type Cell = string | number | null | undefined;

export interface Sheet {
    /** Excel allows 31 characters and none of `[]:*?/\`; longer is cut. */
    readonly name: string;
    /** The first row is the header. */
    readonly rows: readonly (readonly Cell[])[];
    /** Column widths in characters, by position; the rest are Excel's default. */
    readonly widths?: readonly number[];
    /** Rows set in bold, by index; the header row when not given. */
    readonly bold?: readonly number[];
    /** Keep the first row in view while scrolling. On unless false. */
    readonly freeze?: boolean;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

/** A stored zip of in-memory text files. */
export function zipStored(files: readonly { name: string; content: string }[]): Uint8Array {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const data = enc.encode(f.content);
        const crc = crc32(data);
        const local = new Uint8Array([
            ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
        ]);
        parts.push(local, name, data);
        central.push(new Uint8Array([
            ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length),
            ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
        ]), name);
        offset += local.length + name.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array([
        ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
        ...u32(cdSize), ...u32(offset), ...u16(0),
    ]);
    const all = [...parts, ...central, eocd];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

const esc = (s: string) =>
    s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        // Control characters other than tab and newlines are not valid XML.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** `0` -> `A`, `25` -> `Z`, `26` -> `AA`. */
export function columnName(index: number): string {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        out = String.fromCharCode(65 + r) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

export function sheetName(name: string): string {
    return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
}

function cellXml(value: Cell, ref: string, bold: boolean): string {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    const style = bold ? ' s="1"' : '';
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
}

export function sheetXml(sheet: Sheet): string {
    const cols = sheet.widths?.length
        ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
        : '';
    const bold = new Set(sheet.bold ?? [0]);
    const rows = sheet.rows
        .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cellXml(v, `${columnName(c)}${r + 1}`, bold.has(r))).join('')}</row>`)
        .join('');
    const freeze = sheet.freeze !== false && sheet.rows.length > 1
        ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `${freeze}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

/** The workbook's files, by path -- what `makeXlsx` zips. */
export function xlsxFiles(sheets: readonly Sheet[]): { name: string; content: string }[] {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const used = new Set<string>();
    const names = sheets.map(s => {
        const base = sheetName(s.name);
        let name = base;
        for (let i = 2; used.has(name.toLowerCase()); i++) {
            name = `${base.slice(0, 28)} ${i}`;
        }
        used.add(name.toLowerCase());
        return name;
    });
    return [
        {
            name: '[Content_Types].xml',
            content: head
                + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                + '<Default Extension="xml" ContentType="application/xml"/>'
                + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                + sheets.map((_, i) =>
                    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
                + '</Types>',
        },
        {
            name: '_rels/.rels',
            content: head + `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        },
        {
            name: 'xl/workbook.xml',
            content: head + `<workbook ${ns} xmlns:r="${rel}"><sheets>`
                + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
                + '</sheets></workbook>',
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            content: head + `<Relationships xmlns="${pkg}">`
                + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
                + `<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/>`
                + '</Relationships>',
        },
        {
            name: 'xl/styles.xml',
            content: head + `<styleSheet ${ns}>`
                + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
                + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
                + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
                + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
                + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
                + '</styleSheet>',
        },
        ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) })),
    ];
}

/** The workbook's bytes. */
export function makeXlsx(sheets: readonly Sheet[]): Uint8Array {
    return zipStored(xlsxFiles(sheets));
}
