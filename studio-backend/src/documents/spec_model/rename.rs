//! A glossary rename carried into the documents: every use of the old name
//! as a whole word replaced by the name the project chose, for one pull
//! request.
//!
//! Only prose is touched. Front matter, fenced code, inline code spans, a
//! link's destination and an autolink stay as they are: they are names a
//! machine reads, not the project's words. The first letter keeps the case
//! it had, so a sentence that starts with the old name starts with the new.
//!
//! The last word of the old name is also found in its English plural
//! (`members`, `boxes`, `entities`) and becomes the same form of the new
//! name; a possessive (`member's`, `members'`) follows, since the apostrophe
//! ends the word. Irregular plurals are not guessed: the new name takes the
//! regular rule, and a new name already ending in `s` stays as it is.
//!
//! Pure: no I/O. The route in `rest.rs` reads and writes the files.

/// `text` with every whole-word use of `from` (any case) in its prose
/// replaced by `to`, and how many were replaced; `None` when there was none.
/// The plural of `from` becomes the plural of `to`.
pub fn rename(text: &str, from: &str, to: &str) -> Option<(String, usize)> {
    let from = from.trim();
    let to = to.trim();
    if from.is_empty() || to.is_empty() {
        return None;
    }
    // The longer form first, so it is tried before its stem.
    let forms: Vec<(Vec<char>, String)> = vec![
        (plural_of(from).chars().collect(), plural_of_target(to)),
        (from.chars().collect(), to.to_owned()),
    ];
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    for (segment, prose) in segments(text) {
        if prose {
            count += replace_words(segment, &forms, &mut out);
        } else {
            out.push_str(segment);
        }
    }
    (count > 0).then_some((out, count))
}

/// `text` cut into consecutive pieces, each marked prose or not.
fn segments(text: &str) -> Vec<(&str, bool)> {
    let mut out: Vec<(&str, bool)> = Vec::new();
    let lines: Vec<(usize, &str)> = line_spans(text);
    let skip = front_matter_lines(&lines);
    if skip > 0 {
        let (start, line) = lines[skip - 1];
        out.push((&text[..start + line.len()], false));
    }
    let mut fence: Option<String> = None;
    for &(start, line) in &lines[skip..] {
        let stop = start + line.len();
        let opener = fence_marker(line);
        if let Some(open) = &fence {
            let closes = opener
                .as_ref()
                .is_some_and(|m| m.starts_with(open.as_str()) && is_bare(line));
            if closes {
                fence = None;
            }
            out.push((&text[start..stop], false));
        } else if let Some(marker) = opener {
            fence = Some(marker);
            out.push((&text[start..stop], false));
        } else if let Some(cut) = reference_definition(line) {
            out.extend(inline_segments(&text[start..start + cut]));
            out.push((&text[start + cut..stop], false));
        } else {
            out.extend(inline_segments(&text[start..stop]));
        }
    }
    out
}

/// How many lines the front matter takes: a `---` first line up to the next
/// `---` line; 0 when there is none.
fn front_matter_lines(lines: &[(usize, &str)]) -> usize {
    let fence = |l: &str| l.trim_end() == "---";
    match lines.first() {
        Some((_, first)) if fence(first) => lines
            .iter()
            .skip(1)
            .position(|(_, l)| fence(l))
            .map_or(0, |end| end + 2),
        _ => 0,
    }
}

/// Each line with its byte offset, its line break kept.
fn line_spans(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        out.push((start, line));
        start += line.len();
    }
    out
}

/// The fence a line opens or closes (three or more backticks or tildes,
/// indented at most three spaces).
fn fence_marker(line: &str) -> Option<String> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let body = &line[indent..];
    let ch = body.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run: String = body.chars().take_while(|c| *c == ch).collect();
    (run.len() >= 3).then_some(run)
}

/// A closing fence carries nothing after its marker.
fn is_bare(line: &str) -> bool {
    let t = line.trim();
    let ch = t.chars().next().unwrap_or(' ');
    t.chars().all(|c| c == ch)
}

/// Where a reference definition's destination starts (`[label]: url`).
fn reference_definition(line: &str) -> Option<usize> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 || !line[indent..].starts_with('[') {
        return None;
    }
    let close = line[indent..].find("]:")? + indent;
    Some(close + 2)
}

/// One run of prose lines cut around inline code spans, link destinations
/// and autolinks.
fn inline_segments(text: &str) -> Vec<(&str, bool)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    let mut i = 0;
    while i < bytes.len() {
        // Where a kept run starts and ends.
        let kept = match bytes[i] {
            b'`' => {
                let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
                let ticks = &text[i..i + run];
                match text[i + run..].find(ticks) {
                    Some(at) => Some((i, i + run + at + run)),
                    None => {
                        // An unmatched run is literal text.
                        i += run;
                        continue;
                    }
                }
            }
            // The label stays prose; only `(destination)` is kept.
            b']' if bytes.get(i + 1) == Some(&b'(') => {
                text[i + 2..].find(')').map(|at| (i + 1, i + 2 + at + 1))
            }
            b'<' => text[i + 1..]
                .find('>')
                .map(|at| (i, i + 1 + at + 1))
                .filter(|(_, end)| {
                    let inner = &text[i + 1..end - 1];
                    !inner.contains(char::is_whitespace)
                        && (inner.contains(':') || inner.contains('@'))
                }),
            _ => None,
        };
        match kept {
            Some((start, end)) => {
                if from < start {
                    out.push((&text[from..start], true));
                }
                out.push((&text[start..end], false));
                from = end;
                i = end;
            }
            None => i += 1,
        }
    }
    if from < text.len() {
        out.push((&text[from..], true));
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The regular English plural of a name (its last word): `-ies` after a
/// consonant and `y`, `-es` after `s`, `x`, `z`, `ch` or `sh`, `-s`
/// otherwise.
fn plural_of(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut tail = lower.chars().rev();
    let last = tail.next();
    let before = tail.next();
    let consonant = |c: char| c.is_ascii_alphabetic() && !"aeiou".contains(c);
    if matches!(last, Some('y')) && before.is_some_and(consonant) {
        // `y` is one byte, so cutting it keeps a char boundary.
        return format!("{}ies", &name[..name.len() - 1]);
    }
    let hissing = ["s", "x", "z", "ch", "sh"]
        .iter()
        .any(|end| lower.ends_with(end));
    if hissing {
        format!("{name}es")
    } else {
        format!("{name}s")
    }
}

/// The plural the new name takes: the regular rule, except that a name
/// already ending in `s` is kept as it is.
fn plural_of_target(name: &str) -> String {
    if name.ends_with(['s', 'S']) {
        name.to_owned()
    } else {
        plural_of(name)
    }
}

/// Append `prose` with every whole-word, any-case use of a form replaced by
/// its counterpart; the count. At each place the forms are tried in order.
fn replace_words(prose: &str, forms: &[(Vec<char>, String)], out: &mut String) -> usize {
    let chars: Vec<(usize, char)> = prose.char_indices().collect();
    let matches_at = |i: usize, from: &[char]| {
        i + from.len() <= chars.len()
            && chars
                .get(i + from.len())
                .is_none_or(|(_, c)| !is_word_char(*c))
            && chars[i..i + from.len()]
                .iter()
                .zip(from)
                .all(|((_, a), b)| a.to_lowercase().eq(b.to_lowercase()))
    };
    let mut count = 0;
    let mut copied = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let before_ok = i == 0 || !is_word_char(chars[i - 1].1);
        let found = if before_ok {
            forms.iter().find(|(from, _)| matches_at(i, from))
        } else {
            None
        };
        if let Some((from, to)) = found {
            let start = chars[i].0;
            out.push_str(&prose[copied..start]);
            out.push_str(&cased(chars[i].1, to));
            copied = chars.get(i + from.len()).map_or(prose.len(), |(at, _)| *at);
            count += 1;
            i += from.len();
        } else {
            i += 1;
        }
    }
    out.push_str(&prose[copied..]);
    count
}

/// `to` with its first letter in the case of `first`: a capital stays a
/// capital, a lowercase start lowers it unless `to` is an acronym.
fn cased(first: char, to: &str) -> String {
    let mut chars = to.chars();
    let Some(head) = chars.next() else {
        return String::new();
    };
    let tail: String = chars.collect();
    let acronym = tail.chars().next().is_some_and(char::is_uppercase);
    if first.is_uppercase() {
        format!("{}{tail}", head.to_uppercase())
    } else if acronym {
        to.to_owned()
    } else {
        format!("{}{tail}", head.to_lowercase())
    }
}

#[cfg(test)]
#[path = "rename_tests.rs"]
mod tests;
