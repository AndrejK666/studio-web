//! What a Research image is made of, as a short key: a later build whose
//! image has the same key reuses the image an earlier build made instead of
//! uploading and building it again.
//!
//! The key is what Research would build from: the Research project, the
//! Dockerfile Studio laid out (with what the chart mounts baked in), the
//! ignore file Research reads beside it, and every file of its context that
//! ignore file lets through. Studio's own files for the other images of the
//! same build (their Dockerfiles and overlays share the context) are left
//! out, so a change to one image's inputs rebuilds that image alone.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

/// One image as `lay_out` left it: its build's key, its context folder and
/// its Dockerfile.
#[derive(Debug, Clone)]
pub struct Laid {
    pub key: String,
    pub context: PathBuf,
    pub dockerfile: PathBuf,
}

/// How many hex characters a key keeps: enough to tell images apart, short
/// enough for a dozen of them in one record field.
const KEY_CHARS: usize = 12;

/// The key of each laid-out image, by its build's key. `salt` (the Research
/// project) is part of every key: an image is reused only where it is.
pub fn image_keys(laid: &[Laid], salt: &str) -> anyhow::Result<BTreeMap<String, String>> {
    let mut files: BTreeMap<PathBuf, Vec<(String, String)>> = BTreeMap::new();
    let mut keys = BTreeMap::new();
    for l in laid {
        if !files.contains_key(&l.context) {
            files.insert(l.context.clone(), hashed_files(&l.context)?);
        }
        let all = &files[&l.context];
        let dockerfile = std::fs::read(&l.dockerfile)?;
        let ignore_beside = l.dockerfile.file_name().map(|n| {
            l.dockerfile
                .with_file_name(format!("{}.dockerignore", n.to_string_lossy()))
        });
        let ignore = ignore_beside
            .as_deref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .or_else(|| std::fs::read_to_string(l.context.join(".dockerignore")).ok())
            .unwrap_or_default();
        let rules = rules(&ignore);
        let own_dockerfile = l
            .dockerfile
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut h = Sha256::new();
        h.update(b"salt\0");
        h.update(salt.as_bytes());
        h.update(b"\0dockerfile\0");
        h.update(&dockerfile);
        h.update(b"\0ignore\0");
        h.update(ignore.as_bytes());
        for (rel, digest) in all {
            if ignored(&rules, rel) || another_images(rel, &l.key, &own_dockerfile) {
                continue;
            }
            h.update(b"\0file\0");
            h.update(rel.as_bytes());
            h.update(b"\0");
            h.update(digest.as_bytes());
        }
        let key = hex::encode(h.finalize());
        keys.insert(l.key.clone(), key[..KEY_CHARS].to_owned());
    }
    Ok(keys)
}

/// `app=key` comma separated, as a build record keeps them; `None` when
/// there are none or they do not fit the record's field.
pub fn keys_field(keys: &BTreeMap<String, String>) -> Option<String> {
    let text = keys
        .iter()
        .map(|(app, key)| format!("{app}={key}"))
        .collect::<Vec<_>>()
        .join(",");
    (!text.is_empty() && text.chars().count() <= 300).then_some(text)
}

/// A record's `image_keys` read back.
pub fn keys_of(field: Option<&str>) -> BTreeMap<String, String> {
    field
        .unwrap_or_default()
        .split(',')
        .filter_map(|pair| pair.split_once('='))
        .map(|(app, key)| (app.trim().to_owned(), key.trim().to_owned()))
        .filter(|(app, key)| !app.is_empty() && !key.is_empty())
        .collect()
}

/// Studio's files for another image of the same build, which share the
/// context: its Dockerfile (and ignore file) and its overlay folder.
fn another_images(rel: &str, own_key: &str, own_dockerfile: &str) -> bool {
    let first = rel.split('/').next().unwrap_or(rel);
    if rel.contains('/') && first == format!("{}-db", super::research::OVERLAY_DIR) {
        return true;
    }
    if let Some(app) = rel
        .strip_prefix(super::research::OVERLAY_DIR)
        .and_then(|r| r.strip_prefix('/'))
        .and_then(|r| r.split('/').next())
    {
        return app != own_key;
    }
    !rel.contains('/')
        && first.starts_with("studio-")
        && first.contains(".dockerfile")
        && !first.starts_with(own_dockerfile)
}

/// Every file under `root`, relative and `/`-separated, with the digest of
/// its content, in order; `.git` and `target` folders left out (the upload
/// leaves them out too).
fn hashed_files(root: &Path) -> anyhow::Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut todo = vec![PathBuf::new()];
    while let Some(rel) = todo.pop() {
        for entry in std::fs::read_dir(root.join(&rel))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = rel.join(&name);
            let kind = entry.file_type()?;
            if kind.is_dir() {
                if name != ".git" && name != "target" {
                    todo.push(path);
                }
            } else if kind.is_file() {
                let bytes = std::fs::read(entry.path())?;
                out.push((
                    path.to_string_lossy().replace('\\', "/"),
                    hex::encode(Sha256::digest(&bytes)),
                ));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// An ignore file's rules, in order: `(excludes, pattern)`.
fn rules(text: &str) -> Vec<(bool, String)> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| match l.strip_prefix('!') {
            Some(p) => (false, clean(p)),
            None => (true, clean(l)),
        })
        .filter(|(_, p)| !p.is_empty())
        .collect()
}

fn clean(p: &str) -> String {
    p.trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_owned()
}

/// Whether the ignore rules leave `rel` out, as Docker reads them: the last
/// rule that matches the path or one of its folders decides.
fn ignored(rules: &[(bool, String)], rel: &str) -> bool {
    let mut out = false;
    for (excludes, pattern) in rules {
        let mut at = rel;
        let mut hit = glob(pattern, at);
        while !hit {
            match at.rsplit_once('/') {
                Some((parent, _)) => {
                    at = parent;
                    hit = glob(pattern, at);
                }
                None => break,
            }
        }
        if hit {
            out = *excludes;
        }
    }
    out
}

/// `*` (within a folder), `?` and `**` (across folders).
fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some(b'*') if p.get(1) == Some(&b'*') => {
                let rest = p[2..].strip_prefix(b"/").unwrap_or(&p[2..]);
                (0..=t.len()).any(|i| go(rest, &t[i..]))
            }
            Some(b'*') => (0..=t.len())
                .take_while(|i| *i == 0 || t[i - 1] != b'/')
                .any(|i| go(&p[1..], &t[i..])),
            Some(b'?') => t.first().is_some_and(|c| *c != b'/') && go(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ignore_rules_read_as_docker_reads_them() {
        let r = rules("*\n!src\n!studio-research/**\n# a comment\nsrc/tmp\n");
        assert!(ignored(&r, "README.md"));
        assert!(!ignored(&r, "src/main.rs"));
        assert!(ignored(&r, "src/tmp/x"));
        assert!(!ignored(&r, "studio-research/api/files/a"));
        assert!(glob("a/**/b", "a/x/y/b"));
        assert!(glob("*.md", "x.md") && !glob("*.md", "d/x.md"));
    }

    fn laid_out() -> (PathBuf, Vec<Laid>) {
        let work = std::env::temp_dir().join(format!("research-keys-{}", uuid::Uuid::new_v4()));
        let w = |p: &str, s: &str| {
            let at = work.join(p);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, s).unwrap();
        };
        w("api/main.rs", "fn main() {}");
        w("ui/index.html", "<p>hi</p>");
        w("studio-api.dockerfile", "FROM rust\nCOPY api /api\n");
        w(
            "studio-api.dockerfile.dockerignore",
            "*\n!api\n!studio-research/**\n",
        );
        w("studio-ui.dockerfile", "FROM nginx\nCOPY ui /ui\n");
        w(
            "studio-ui.dockerfile.dockerignore",
            "*\n!ui\n!studio-research/**\n",
        );
        w("studio-research/ui/files/etc/ui.conf", "listen 80");
        let laid = ["api", "ui"]
            .map(|k| Laid {
                key: k.into(),
                context: work.clone(),
                dockerfile: work.join(format!("studio-{k}.dockerfile")),
            })
            .to_vec();
        (work, laid)
    }

    #[test]
    fn a_change_to_one_image_s_inputs_changes_that_image_s_key_alone() {
        let (work, laid) = laid_out();
        let before = image_keys(&laid, "p1").unwrap();
        assert_eq!(before, image_keys(&laid, "p1").unwrap(), "a key is stable");
        assert_ne!(
            before,
            image_keys(&laid, "p2").unwrap(),
            "and the project's own"
        );

        std::fs::write(work.join("ui/index.html"), "<p>hello</p>").unwrap();
        let after = image_keys(&laid, "p1").unwrap();
        assert_eq!(before["api"], after["api"], "api does not read ui/");
        assert_ne!(before["ui"], after["ui"]);

        // The ui's overlay is not the api's input either.
        std::fs::write(
            work.join("studio-research/ui/files/etc/ui.conf"),
            "listen 81",
        )
        .unwrap();
        let again = image_keys(&laid, "p1").unwrap();
        assert_eq!(after["api"], again["api"]);
        assert_ne!(after["ui"], again["ui"]);
        let _ = std::fs::remove_dir_all(&work);

        let field = keys_field(&again).unwrap();
        assert_eq!(keys_of(Some(&field)), again);
    }
}
