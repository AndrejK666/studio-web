//! A count with its noun, for the sentences a person reads: "1 document",
//! "2 documents" — never "document(s)".

use std::fmt::Display;

/// `n` and `one` when `n` is 1, else `n` and `many`.
pub fn plural<N: Copy + Display + PartialEq + From<u8>>(n: N, one: &str, many: &str) -> String {
    format!("{n} {}", if n == N::from(1) { one } else { many })
}

#[cfg(test)]
mod tests {
    use super::plural;

    #[test]
    fn one_takes_the_singular_and_every_other_count_the_plural() {
        assert_eq!(plural(1usize, "file", "files"), "1 file");
        assert_eq!(plural(0u32, "file", "files"), "0 files");
        assert_eq!(plural(21u64, "entry", "entries"), "21 entries");
    }
}
