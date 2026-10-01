//! A small XLSX writer: exactly what the roadmap workbook needs, and nothing
//! a spreadsheet library would add on top.
//!
//! Cells hold numbers, text, dates or formulas, each with a style (font,
//! fill, borders, alignment, number format); a sheet has column widths,
//! hidden columns, row heights, merged ranges, a frozen pane, an autofilter,
//! cell hyperlinks, conditional formats (data bars and formula rules) and
//! floating shapes -- the text boxes the Roadmap and Gantt sheets draw their
//! bars with, which a cell cannot be because a bar spans columns and links
//! to its issue.
//!
//! Formulas are written without a cached value and the workbook asks for a
//! full recalculation on load, so Excel and LibreOffice show the numbers the
//! moment the file opens.

use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;

use time::Date;

// ── styles ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Font {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// Points, times ten (`110` is 11pt); 0 is the default 11pt.
    pub size10: u32,
    pub color: Option<String>,
}

impl Font {
    pub fn sized(mut self, points: f64) -> Self {
        self.size10 = (points * 10.0).round() as u32;
        self
    }
    pub fn bold(mut self) -> Self {
        self.bold = true;
        self
    }
    pub fn italic(mut self) -> Self {
        self.italic = true;
        self
    }
    pub fn underline(mut self) -> Self {
        self.underline = true;
        self
    }
    pub fn color(mut self, rgb: &str) -> Self {
        self.color = Some(rgb.to_string());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Line {
    Thin,
    Medium,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Side {
    pub line: Option<Line>,
    pub color: Option<String>,
}

impl Side {
    pub fn thin(color: Option<&str>) -> Self {
        Side {
            line: Some(Line::Thin),
            color: color.map(str::to_string),
        }
    }
    pub fn medium(color: &str) -> Self {
        Side {
            line: Some(Line::Medium),
            color: Some(color.to_string()),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Border {
    pub left: Side,
    pub right: Side,
    pub top: Side,
    pub bottom: Side,
}

impl Border {
    pub fn all(side: Side) -> Self {
        Border {
            left: side.clone(),
            right: side.clone(),
            top: side.clone(),
            bottom: side,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Align {
    pub horizontal: Option<&'static str>,
    pub vertical: Option<&'static str>,
    pub wrap: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Style {
    pub font: Font,
    /// A solid fill.
    pub fill: Option<String>,
    pub border: Border,
    pub align: Align,
    /// A number format code (`0%`, `yy.mm`); `None` is General.
    pub num_fmt: Option<&'static str>,
}

// ── cells and sheets ────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Number(f64),
    Text(String),
    /// A calendar date, written as Excel's day serial.
    Date(Date),
    /// A formula, without the leading `=`.
    Formula(String),
}

#[derive(Clone, Debug, Default)]
pub struct Cell {
    pub value: Option<Value>,
    pub style: Style,
}

/// A conditional format over a range.
#[derive(Clone, Debug)]
pub enum Rule {
    /// A data bar from 0 to 1 in one colour.
    DataBar { color: String },
    /// A formula rule: when it holds, the cell takes this fill and font colour.
    Formula {
        formula: String,
        fill: String,
        font: String,
        stop: bool,
    },
}

/// A floating text box anchored between two cells (zero-based column and row).
#[derive(Clone, Debug)]
pub struct Shape {
    pub from_col: u32,
    pub from_row: u32,
    pub to_col: u32,
    pub to_row: u32,
    /// The height of the row it sits in, points: the box ends just above it.
    pub row_height: f64,
    pub fill: Option<String>,
    pub border: Option<String>,
    pub text: String,
    pub text_color: String,
    pub link: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Sheet {
    pub name: String,
    /// `(row, col)`, both 1-based.
    cells: BTreeMap<(u32, u32), Cell>,
    widths: BTreeMap<u32, f64>,
    hidden: Vec<u32>,
    heights: BTreeMap<u32, f64>,
    merges: Vec<(u32, u32, u32, u32)>,
    /// `(first unfrozen row, first unfrozen col)`, 1-based.
    freeze: Option<(u32, u32)>,
    filter: Option<String>,
    links: Vec<(u32, u32, String)>,
    rules: Vec<(String, Rule)>,
    shapes: Vec<Shape>,
    pub hide_grid: bool,
}

impl Sheet {
    pub fn new(name: &str) -> Self {
        Sheet {
            name: name.to_string(),
            ..Sheet::default()
        }
    }

    /// The cell at `(row, col)`, created empty if it is not there yet.
    pub fn cell(&mut self, row: u32, col: u32) -> &mut Cell {
        self.cells.entry((row, col)).or_default()
    }

    pub fn set(&mut self, row: u32, col: u32, value: Option<Value>) -> &mut Cell {
        let c = self.cell(row, col);
        c.value = value;
        c
    }

    pub fn text(&mut self, row: u32, col: u32, text: impl Into<String>) -> &mut Cell {
        self.set(row, col, Some(Value::Text(text.into())))
    }

    #[cfg(test)]
    pub fn value(&self, row: u32, col: u32) -> Option<&Value> {
        self.cells.get(&(row, col)).and_then(|c| c.value.as_ref())
    }

    pub fn width(&mut self, col: u32, width: f64) {
        self.widths.insert(col, width);
    }
    pub fn hide(&mut self, col: u32) {
        self.hidden.push(col);
    }
    pub fn height(&mut self, row: u32, height: f64) {
        self.heights.insert(row, height);
    }
    pub fn merge(&mut self, r1: u32, c1: u32, r2: u32, c2: u32) {
        self.merges.push((r1, c1, r2, c2));
    }
    pub fn freeze(&mut self, row: u32, col: u32) {
        self.freeze = Some((row, col));
    }
    pub fn filter(&mut self, range: String) {
        self.filter = Some(range);
    }
    pub fn link(&mut self, row: u32, col: u32, url: &str) {
        self.links.push((row, col, url.to_string()));
    }
    pub fn rule(&mut self, range: String, rule: Rule) {
        self.rules.push((range, rule));
    }
    pub fn shape(&mut self, shape: Shape) {
        self.shapes.push(shape);
    }
    #[cfg(test)]
    pub fn shapes(&self) -> &[Shape] {
        &self.shapes
    }
}

/// `1` → `A`, `26` → `Z`, `27` → `AA`.
pub fn col_name(col: u32) -> String {
    let mut n = col;
    let mut out = Vec::new();
    while n > 0 {
        let r = (n - 1) % 26;
        out.push(b'A' + r as u8);
        n = (n - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub fn cell_ref(row: u32, col: u32) -> String {
    format!("{}{row}", col_name(col))
}

/// Excel's serial for a date: days since 1899-12-30.
fn serial(date: Date) -> i64 {
    let epoch = Date::from_calendar_date(1899, time::Month::December, 30).unwrap_or(date);
    (date - epoch).whole_days()
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(ch),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

fn num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{v:.0}")
    } else {
        format!("{v}")
    }
}

fn argb(rgb: &str) -> String {
    format!("FF{}", rgb.trim_start_matches('#').to_ascii_uppercase())
}

// ── the style table ─────────────────────────────────────────────────────────

#[derive(Default)]
struct Styles {
    fonts: Vec<Font>,
    fills: Vec<Option<String>>,
    borders: Vec<Border>,
    formats: Vec<&'static str>,
    xfs: Vec<(usize, usize, usize, u32, Align)>,
    index: HashMap<Style, usize>,
    dxfs: Vec<(String, String)>,
}

impl Styles {
    fn new() -> Self {
        let mut s = Styles {
            fonts: vec![Font::default()],
            // Excel reserves the first two fills.
            fills: vec![None, None],
            borders: vec![Border::default()],
            ..Styles::default()
        };
        s.xfs.push((0, 0, 0, 0, Align::default()));
        s.index.insert(Style::default(), 0);
        s
    }

    fn position<T: PartialEq + Clone>(list: &mut Vec<T>, item: &T) -> usize {
        match list.iter().position(|x| x == item) {
            Some(ix) => ix,
            None => {
                list.push(item.clone());
                list.len() - 1
            }
        }
    }

    fn id(&mut self, style: &Style) -> usize {
        if let Some(ix) = self.index.get(style) {
            return *ix;
        }
        let font = Self::position(&mut self.fonts, &style.font);
        let fill = match &style.fill {
            None => 0,
            Some(_) => {
                // Index 0 and 1 are the reserved `none` and `gray125`.
                match self.fills.iter().skip(2).position(|f| *f == style.fill) {
                    Some(ix) => ix + 2,
                    None => {
                        self.fills.push(style.fill.clone());
                        self.fills.len() - 1
                    }
                }
            }
        };
        let border = Self::position(&mut self.borders, &style.border);
        let fmt = match style.num_fmt {
            None => 0,
            Some(code) => 164 + Self::position(&mut self.formats, &code) as u32,
        };
        self.xfs
            .push((font, fill, border, fmt, style.align.clone()));
        let ix = self.xfs.len() - 1;
        self.index.insert(style.clone(), ix);
        ix
    }

    fn dxf(&mut self, fill: &str, font: &str) -> usize {
        Self::position(&mut self.dxfs, &(fill.to_string(), font.to_string()))
    }

    fn xml(&self) -> String {
        let mut x = String::from(HEAD);
        x.push_str(&format!("<styleSheet xmlns=\"{NS}\">"));
        if !self.formats.is_empty() {
            x.push_str(&format!("<numFmts count=\"{}\">", self.formats.len()));
            for (i, code) in self.formats.iter().enumerate() {
                x.push_str(&format!(
                    "<numFmt numFmtId=\"{}\" formatCode=\"{}\"/>",
                    164 + i,
                    esc(code)
                ));
            }
            x.push_str("</numFmts>");
        }
        x.push_str(&format!("<fonts count=\"{}\">", self.fonts.len()));
        for (i, f) in self.fonts.iter().enumerate() {
            x.push_str("<font>");
            if f.bold {
                x.push_str("<b/>");
            }
            if f.italic {
                x.push_str("<i/>");
            }
            if f.underline {
                x.push_str("<u/>");
            }
            // A font that names no size takes the workbook's (11pt); only
            // the default font itself spells it out.
            let size = if f.size10 == 0 && i == 0 {
                110
            } else {
                f.size10
            };
            if size != 0 {
                x.push_str(&format!("<sz val=\"{}\"/>", num(f64::from(size) / 10.0)));
            }
            if let Some(c) = &f.color {
                x.push_str(&format!("<color rgb=\"{}\"/>", argb(c)));
            }
            x.push_str("<name val=\"Calibri\"/><family val=\"2\"/></font>");
        }
        x.push_str("</fonts>");
        x.push_str(&format!("<fills count=\"{}\">", self.fills.len()));
        for (i, f) in self.fills.iter().enumerate() {
            match (i, f) {
                (0, _) => x.push_str("<fill><patternFill patternType=\"none\"/></fill>"),
                (1, _) => x.push_str("<fill><patternFill patternType=\"gray125\"/></fill>"),
                (_, Some(c)) => x.push_str(&format!(
                    "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"{}\"/><bgColor indexed=\"64\"/></patternFill></fill>",
                    argb(c)
                )),
                (_, None) => x.push_str("<fill><patternFill patternType=\"none\"/></fill>"),
            }
        }
        x.push_str("</fills>");
        x.push_str(&format!("<borders count=\"{}\">", self.borders.len()));
        for b in &self.borders {
            x.push_str("<border>");
            for (tag, side) in [
                ("left", &b.left),
                ("right", &b.right),
                ("top", &b.top),
                ("bottom", &b.bottom),
            ] {
                match &side.line {
                    None => x.push_str(&format!("<{tag}/>")),
                    Some(line) => {
                        let style = match line {
                            Line::Thin => "thin",
                            Line::Medium => "medium",
                        };
                        x.push_str(&format!("<{tag} style=\"{style}\">"));
                        match &side.color {
                            Some(c) => x.push_str(&format!("<color rgb=\"{}\"/>", argb(c))),
                            None => x.push_str("<color auto=\"1\"/>"),
                        }
                        x.push_str(&format!("</{tag}>"));
                    }
                }
            }
            x.push_str("<diagonal/></border>");
        }
        x.push_str("</borders>");
        x.push_str("<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>");
        x.push_str(&format!("<cellXfs count=\"{}\">", self.xfs.len()));
        for (font, fill, border, fmt, align) in &self.xfs {
            x.push_str(&format!(
                "<xf numFmtId=\"{fmt}\" fontId=\"{font}\" fillId=\"{fill}\" borderId=\"{border}\" xfId=\"0\""
            ));
            for (attr, on) in [
                ("applyNumberFormat", *fmt != 0),
                ("applyFont", *font != 0),
                ("applyFill", *fill != 0),
                ("applyBorder", *border != 0),
            ] {
                if on {
                    x.push_str(&format!(" {attr}=\"1\""));
                }
            }
            if *align == Align::default() {
                x.push_str("/>");
            } else {
                x.push_str(" applyAlignment=\"1\"><alignment");
                if let Some(h) = align.horizontal {
                    x.push_str(&format!(" horizontal=\"{h}\""));
                }
                if let Some(v) = align.vertical {
                    x.push_str(&format!(" vertical=\"{v}\""));
                }
                if align.wrap {
                    x.push_str(" wrapText=\"1\"");
                }
                x.push_str("/></xf>");
            }
        }
        x.push_str("</cellXfs>");
        x.push_str("<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>");
        x.push_str(&format!("<dxfs count=\"{}\">", self.dxfs.len()));
        for (fill, font) in &self.dxfs {
            x.push_str(&format!(
                "<dxf><font><color rgb=\"{}\"/></font><fill><patternFill patternType=\"solid\"><fgColor rgb=\"{}\"/><bgColor rgb=\"{}\"/></patternFill></fill></dxf>",
                argb(font),
                argb(fill),
                argb(fill)
            ));
        }
        x.push_str("</dxfs><tableStyles count=\"0\"/></styleSheet>");
        x
    }
}

// ── writing ─────────────────────────────────────────────────────────────────

const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const XDR: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";

fn sheet_xml(sheet: &Sheet, styles: &mut Styles, drawing: bool) -> (String, Vec<String>) {
    let mut x = String::from(HEAD);
    x.push_str(&format!("<worksheet xmlns=\"{NS}\" xmlns:r=\"{REL}\">"));
    let grid = if sheet.hide_grid {
        " showGridLines=\"0\""
    } else {
        ""
    };
    x.push_str(&format!(
        "<sheetViews><sheetView workbookViewId=\"0\"{grid}"
    ));
    match sheet.freeze {
        Some((row, col)) if row > 1 || col > 1 => {
            let (xs, ys) = (col - 1, row - 1);
            let pane = match (xs > 0, ys > 0) {
                (true, true) => "bottomRight",
                (true, false) => "topRight",
                _ => "bottomLeft",
            };
            x.push_str("><pane");
            if xs > 0 {
                x.push_str(&format!(" xSplit=\"{xs}\""));
            }
            if ys > 0 {
                x.push_str(&format!(" ySplit=\"{ys}\""));
            }
            x.push_str(&format!(
                " topLeftCell=\"{}\" activePane=\"{pane}\" state=\"frozen\"/><selection pane=\"{pane}\"/></sheetView></sheetViews>",
                cell_ref(row, col)
            ));
        }
        _ => x.push_str("/></sheetViews>"),
    }
    x.push_str("<sheetFormatPr defaultRowHeight=\"15\"/>");
    let mut cols: BTreeMap<u32, (Option<f64>, bool)> = BTreeMap::new();
    for (c, w) in &sheet.widths {
        cols.entry(*c).or_default().0 = Some(*w);
    }
    for c in &sheet.hidden {
        cols.entry(*c).or_default().1 = true;
    }
    if !cols.is_empty() {
        x.push_str("<cols>");
        for (c, (w, hidden)) in cols {
            x.push_str(&format!("<col min=\"{c}\" max=\"{c}\""));
            match w {
                Some(w) => x.push_str(&format!(" width=\"{}\" customWidth=\"1\"", num(w))),
                None => x.push_str(" width=\"13\" customWidth=\"1\""),
            }
            if hidden {
                x.push_str(" hidden=\"1\"");
            }
            x.push_str("/>");
        }
        x.push_str("</cols>");
    }
    x.push_str("<sheetData>");
    let mut rows: BTreeMap<u32, Vec<(u32, &Cell)>> = BTreeMap::new();
    for ((r, c), cell) in &sheet.cells {
        rows.entry(*r).or_default().push((*c, cell));
    }
    for r in sheet.heights.keys() {
        rows.entry(*r).or_default();
    }
    for (r, cells) in rows {
        x.push_str(&format!("<row r=\"{r}\""));
        if let Some(h) = sheet.heights.get(&r) {
            x.push_str(&format!(" ht=\"{}\" customHeight=\"1\"", num(*h)));
        }
        x.push('>');
        for (c, cell) in cells {
            let s = styles.id(&cell.style);
            let style = if s == 0 {
                String::new()
            } else {
                format!(" s=\"{s}\"")
            };
            let at = cell_ref(r, c);
            match &cell.value {
                None => {
                    if s != 0 {
                        x.push_str(&format!("<c r=\"{at}\"{style}/>"));
                    }
                }
                Some(Value::Number(n)) if n.is_finite() => {
                    x.push_str(&format!("<c r=\"{at}\"{style}><v>{}</v></c>", num(*n)));
                }
                Some(Value::Number(_)) => x.push_str(&format!("<c r=\"{at}\"{style}/>")),
                Some(Value::Date(d)) => {
                    x.push_str(&format!("<c r=\"{at}\"{style}><v>{}</v></c>", serial(*d)));
                }
                Some(Value::Formula(f)) => {
                    x.push_str(&format!("<c r=\"{at}\"{style}><f>{}</f></c>", esc(f)));
                }
                Some(Value::Text(t)) => {
                    x.push_str(&format!(
                        "<c r=\"{at}\"{style} t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                        esc(t)
                    ));
                }
            }
        }
        x.push_str("</row>");
    }
    x.push_str("</sheetData>");
    if let Some(f) = &sheet.filter {
        x.push_str(&format!("<autoFilter ref=\"{f}\"/>"));
    }
    if !sheet.merges.is_empty() {
        x.push_str(&format!("<mergeCells count=\"{}\">", sheet.merges.len()));
        for (r1, c1, r2, c2) in &sheet.merges {
            x.push_str(&format!(
                "<mergeCell ref=\"{}:{}\"/>",
                cell_ref(*r1, *c1),
                cell_ref(*r2, *c2)
            ));
        }
        x.push_str("</mergeCells>");
    }
    for (priority, (range, rule)) in (1..).zip(sheet.rules.iter()) {
        x.push_str(&format!("<conditionalFormatting sqref=\"{range}\">"));
        match rule {
            Rule::DataBar { color } => x.push_str(&format!(
                "<cfRule type=\"dataBar\" priority=\"{priority}\"><dataBar><cfvo type=\"num\" val=\"0\"/><cfvo type=\"num\" val=\"1\"/><color rgb=\"{}\"/></dataBar></cfRule>",
                argb(color)
            )),
            Rule::Formula {
                formula,
                fill,
                font,
                stop,
            } => {
                let dxf = styles.dxf(fill, font);
                let stop = if *stop { " stopIfTrue=\"1\"" } else { "" };
                x.push_str(&format!(
                    "<cfRule type=\"expression\" dxfId=\"{dxf}\" priority=\"{priority}\"{stop}><formula>{}</formula></cfRule>",
                    esc(formula)
                ));
            }
        }
        x.push_str("</conditionalFormatting>");
    }
    let mut rels: Vec<String> = Vec::new();
    if !sheet.links.is_empty() {
        x.push_str("<hyperlinks>");
        for (r, c, url) in &sheet.links {
            rels.push(url.clone());
            x.push_str(&format!(
                "<hyperlink ref=\"{}\" r:id=\"rId{}\"/>",
                cell_ref(*r, *c),
                rels.len()
            ));
        }
        x.push_str("</hyperlinks>");
    }
    x.push_str("<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>");
    if drawing {
        x.push_str("<drawing r:id=\"rIdDrw\"/>");
    }
    x.push_str("</worksheet>");
    (x, rels)
}

fn drawing_xml(shapes: &[Shape]) -> (String, String) {
    const PAD_X: u32 = 38100;
    const PAD_Y: u32 = 19050;
    let mut x = String::from(HEAD);
    let mut rels = format!("{HEAD}<Relationships xmlns=\"{PKG}\">");
    x.push_str(&format!(
        "<xdr:wsDr xmlns:xdr=\"{XDR}\" xmlns:a=\"{A}\" xmlns:r=\"{REL}\">"
    ));
    for (i, s) in shapes.iter().enumerate() {
        let id = i + 2;
        let row_emu = (s.row_height * 12700.0) as u32;
        x.push_str("<xdr:twoCellAnchor editAs=\"oneCell\">");
        x.push_str(&format!(
            "<xdr:from><xdr:col>{}</xdr:col><xdr:colOff>{PAD_X}</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{PAD_Y}</xdr:rowOff></xdr:from>",
            s.from_col, s.from_row
        ));
        x.push_str(&format!(
            "<xdr:to><xdr:col>{}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:to>",
            s.to_col,
            s.to_row,
            row_emu.saturating_sub(PAD_Y)
        ));
        x.push_str(&format!(
            "<xdr:sp><xdr:nvSpPr><xdr:cNvPr id=\"{id}\" name=\"Item {id}\""
        ));
        match &s.link {
            Some(url) => {
                x.push_str(&format!("><a:hlinkClick r:id=\"rId{id}\"/></xdr:cNvPr>"));
                rels.push_str(&format!(
                    "<Relationship Id=\"rId{id}\" Type=\"{REL}/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
                    esc(url)
                ));
            }
            None => x.push_str("/>"),
        }
        x.push_str("<xdr:cNvSpPr txBox=\"1\"/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst=\"roundRect\"><a:avLst/></a:prstGeom>");
        match &s.fill {
            Some(c) => x.push_str(&format!(
                "<a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill>"
            )),
            None => x.push_str("<a:noFill/>"),
        }
        match &s.border {
            Some(c) => x.push_str(&format!(
                "<a:ln w=\"12700\"><a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill></a:ln>"
            )),
            None => x.push_str("<a:ln><a:noFill/></a:ln>"),
        }
        x.push_str("</xdr:spPr><xdr:txBody><a:bodyPr wrap=\"square\" anchor=\"ctr\" anchorCtr=\"0\" lIns=\"36000\" tIns=\"9000\" rIns=\"36000\" bIns=\"9000\"/><a:lstStyle/>");
        x.push_str("<a:p><a:pPr><a:lnSpc><a:spcPts val=\"1050\"/></a:lnSpc><a:spcBef><a:spcPts val=\"0\"/></a:spcBef><a:spcAft><a:spcPts val=\"0\"/></a:spcAft></a:pPr>");
        x.push_str(&format!(
            "<a:r><a:rPr lang=\"en-US\" sz=\"1000\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:latin typeface=\"Calibri\"/></a:rPr><a:t>{}</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>",
            s.text_color,
            esc(&s.text)
        ));
    }
    x.push_str("</xdr:wsDr>");
    rels.push_str("</Relationships>");
    (x, rels)
}

/// The workbook, zipped: the bytes of an `.xlsx` file.
pub fn workbook(sheets: &[Sheet]) -> Vec<u8> {
    let mut styles = Styles::new();
    let mut files: Vec<(String, String)> = Vec::new();
    let mut types = format!(
        "{HEAD}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
    );
    let mut book = format!("{HEAD}<workbook xmlns=\"{NS}\" xmlns:r=\"{REL}\"><sheets>");
    let mut book_rels = format!("{HEAD}<Relationships xmlns=\"{PKG}\">");
    for (i, sheet) in sheets.iter().enumerate() {
        let n = i + 1;
        let drawing = !sheet.shapes.is_empty();
        let (xml, links) = sheet_xml(sheet, &mut styles, drawing);
        files.push((format!("xl/worksheets/sheet{n}.xml"), xml));
        types.push_str(&format!(
            "<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        ));
        book.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>",
            esc(&sheet.name)
        ));
        book_rels.push_str(&format!(
            "<Relationship Id=\"rId{n}\" Type=\"{REL}/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"
        ));
        if !links.is_empty() || drawing {
            let mut rels = format!("{HEAD}<Relationships xmlns=\"{PKG}\">");
            for (k, url) in links.iter().enumerate() {
                rels.push_str(&format!(
                    "<Relationship Id=\"rId{}\" Type=\"{REL}/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
                    k + 1,
                    esc(url)
                ));
            }
            if drawing {
                rels.push_str(&format!(
                    "<Relationship Id=\"rIdDrw\" Type=\"{REL}/drawing\" Target=\"../drawings/drawing{n}.xml\"/>"
                ));
                let (dx, drels) = drawing_xml(&sheet.shapes);
                files.push((format!("xl/drawings/drawing{n}.xml"), dx));
                files.push((format!("xl/drawings/_rels/drawing{n}.xml.rels"), drels));
                types.push_str(&format!(
                    "<Override PartName=\"/xl/drawings/drawing{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.drawing+xml\"/>"
                ));
            }
            rels.push_str("</Relationships>");
            files.push((format!("xl/worksheets/_rels/sheet{n}.xml.rels"), rels));
        }
    }
    book.push_str("</sheets><calcPr calcId=\"191029\" fullCalcOnLoad=\"1\"/></workbook>");
    book_rels.push_str(&format!(
        "<Relationship Id=\"rId{}\" Type=\"{REL}/styles\" Target=\"styles.xml\"/></Relationships>",
        sheets.len() + 1
    ));
    types.push_str("</Types>");
    files.push(("xl/workbook.xml".into(), book));
    files.push(("xl/_rels/workbook.xml.rels".into(), book_rels));
    files.push(("xl/styles.xml".into(), styles.xml()));
    files.push((
        "_rels/.rels".into(),
        format!(
            "{HEAD}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"
        ),
    ));
    files.insert(0, ("[Content_Types].xml".into(), types));
    zip(&files)
}

// ── zip ─────────────────────────────────────────────────────────────────────

/// A deflated zip of the named files.
fn zip(files: &[(String, String)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, content) in files {
        let data = content.as_bytes();
        let crc = crc32fast::hash(data);
        let mut enc =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        // Writing to a Vec cannot fail.
        let _ = enc.write_all(data);
        let packed = enc.finish().unwrap_or_default();
        let offset = out.len() as u32;
        let name_bytes = name.as_bytes();
        let header = |sig: u32, central: bool| {
            let mut h: Vec<u8> = Vec::new();
            h.extend(sig.to_le_bytes());
            if central {
                h.extend(20u16.to_le_bytes()); // made by
            }
            h.extend(20u16.to_le_bytes()); // needed
            h.extend(0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend(8u16.to_le_bytes()); // deflate
            h.extend(0u16.to_le_bytes()); // time
            h.extend(0x21u16.to_le_bytes()); // date: 1980-01-01
            h.extend(crc.to_le_bytes());
            h.extend((packed.len() as u32).to_le_bytes());
            h.extend((data.len() as u32).to_le_bytes());
            h.extend((name_bytes.len() as u16).to_le_bytes());
            h.extend(0u16.to_le_bytes()); // extra
            if central {
                h.extend(0u16.to_le_bytes()); // comment
                h.extend(0u16.to_le_bytes()); // disk
                h.extend(0u16.to_le_bytes()); // internal attrs
                h.extend(0u32.to_le_bytes()); // external attrs
                h.extend(offset.to_le_bytes());
            }
            h.extend(name_bytes);
            h
        };
        out.extend(header(0x0403_4b50, false));
        out.extend(&packed);
        central.extend(header(0x0201_4b50, true));
    }
    let start = out.len() as u32;
    let size = central.len() as u32;
    out.extend(central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out.extend((files.len() as u16).to_le_bytes());
    out.extend((files.len() as u16).to_le_bytes());
    out.extend(size.to_le_bytes());
    out.extend(start.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_are_named_like_excel_names_them() {
        assert_eq!(col_name(1), "A");
        assert_eq!(col_name(26), "Z");
        assert_eq!(col_name(27), "AA");
        assert_eq!(col_name(34), "AH");
        assert_eq!(cell_ref(2, 4), "D2");
    }

    #[test]
    fn a_date_is_the_excel_serial() {
        let d = Date::from_calendar_date(2026, time::Month::September, 1).expect("date");
        assert_eq!(serial(d), 46266);
    }

    #[test]
    fn a_workbook_is_a_zip_with_every_part() {
        let mut s = Sheet::new("Summary");
        s.text(1, 1, "a & b").style.font = Font::default().bold();
        s.set(2, 1, Some(Value::Formula("SUM(A1:A1)".into())));
        s.link(1, 1, "https://example.com/?a=1&b=2");
        s.shape(Shape {
            from_col: 1,
            from_row: 1,
            to_col: 2,
            to_row: 1,
            row_height: 22.0,
            fill: None,
            border: None,
            text: "◆ x".into(),
            text_color: "1F3864".into(),
            link: Some("https://example.com".into()),
        });
        let bytes = workbook(&[s]);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let text = String::from_utf8_lossy(&bytes);
        for part in [
            "[Content_Types].xml",
            "xl/workbook.xml",
            "xl/styles.xml",
            "xl/worksheets/sheet1.xml",
            "xl/worksheets/_rels/sheet1.xml.rels",
            "xl/drawings/drawing1.xml",
            "xl/drawings/_rels/drawing1.xml.rels",
        ] {
            assert!(text.contains(part), "{part} missing");
        }
    }
}
