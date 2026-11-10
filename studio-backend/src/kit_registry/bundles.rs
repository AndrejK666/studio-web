//! A kit's micro-frontends, served to the shell at run time (ADR-0068 §8,
//! phase 5): a new kit's screens need no portal rebuild.
//!
//! # The bundle format
//!
//! A kit with screens carries them built. Its `kit.gdl` (GDL 1.7) names each
//! bundle, a directory beside it:
//!
//! ```text
//! <kit>/kit.gdl           kit(name = "hello-kit", version = "0.1.0",
//!                             levels = ["project"], mfe = [path("mfe/hello")])
//! <kit>/mfe/hello/        what `vite build` with Module Federation and the
//!   mfe-manifest.json       FrontX plugin (`frontxMfGts`) writes: the package's
//!   remoteEntry.js          manifest, entries and extensions, its remote entry,
//!   assets/…  shared/…      its chunks and the shared dependencies it externalizes
//! ```
//!
//! `mfe-manifest.json` is the same file the portal's build-time generator reads
//! (`scripts/lib/manifest-generator.ts`); the shell treats a runtime package
//! exactly like a built-in one once it knows where the files are.
//!
//! # Where the bytes come from
//!
//! A [`BundleSource`]. Today one: [`DirSource`], a directory named by
//! `STUDIO_KIT_BUNDLES_DIR` whose every subdirectory holding a `kit.gdl` is a
//! kit, added to the library on the organization shelf at the version its
//! passport states (development and the demo, `examples/kits/`). An
//! organization's kit read from its connected repository at a pinned commit
//! (ADR-0068 phase 7) is another source behind the same trait: it answers
//! `packages` and `read` for the kits it knows, and nothing here changes.
//!
//! # Who may read the files
//!
//! The shell's module loader fetches a bundle's files itself and sends no
//! token, so the file route is anonymous, like a photo (`studio-user`). What
//! guards it is the `grant` in the path: an HMAC of the kit and the version,
//! keyed by the deployment (`STUDIO_KIT_BUNDLE_KEY`, else a key drawn at start).
//! It is learned only from `GET /mfe-manifests`, which answers only for kits
//! effective where the caller is a member. Uninstalling a kit takes it out of
//! that answer; a grant once learned stays valid for that version until the key
//! changes, the same as a cached bundle would.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use sha2::{Digest, Sha256};

use super::service::{KitDescriptor, SHELF_ORGANIZATION, normalize_slug};
use crate::components_catalog::{KIT_GDL_FILE, read_kit_gdl};

/// A directory of kits, each a subdirectory with a `kit.gdl` (development).
pub const BUNDLES_DIR_ENV: &str = "STUDIO_KIT_BUNDLES_DIR";
/// The key grants are signed with. Unset, one is drawn at start, so grants
/// change with every restart and differ between replicas.
pub const BUNDLE_KEY_ENV: &str = "STUDIO_KIT_BUNDLE_KEY";
/// The `source` of a kit a [`DirSource`] brings into the library.
pub const SOURCE_BUNDLE_DIR: &str = "bundle-dir";
/// A package's manifest, as the FrontX build plugin writes it.
pub const MFE_MANIFEST: &str = "mfe-manifest.json";
/// Where the gateway serves this backend's routes.
const GATEWAY_PREFIX: &str = "/cf";
/// The largest file served; a bundle's chunks are far smaller.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// The largest `mfe-manifest.json` read.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// Where a kit's bundle files come from.
#[async_trait]
pub trait BundleSource: Send + Sync {
    /// Kits this source adds to the library; empty for a source that only
    /// carries files for kits the library lists already.
    fn kits(&self) -> Vec<KitDescriptor>;
    /// The packages `slug` has at `version`; empty when this source has none.
    fn packages(&self, slug: &str, version: &str) -> Vec<String>;
    /// One file of a package, `None` when there is no such file.
    async fn read(
        &self,
        slug: &str,
        version: &str,
        package: &str,
        file: &BundleFile,
    ) -> Result<Option<Vec<u8>>>;
}

/// A file path inside a package, checked: relative, no `..`, no hidden part,
/// and of a type a bundle carries. An HTML page is never served, so a
/// bundle's own `index.html` cannot be opened as a page of Studio's origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleFile {
    segments: Vec<String>,
    content_type: &'static str,
}

impl BundleFile {
    pub fn parse(path: &str) -> Option<Self> {
        if path.is_empty() || path.len() > 512 {
            return None;
        }
        let mut segments = Vec::new();
        for seg in path.split('/') {
            let ok = !seg.is_empty()
                && !seg.starts_with('.')
                && seg.chars().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@' | '+' | '~')
                });
            if !ok {
                return None;
            }
            segments.push(seg.to_owned());
        }
        let name = segments.last()?;
        let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
        Some(Self {
            content_type: content_type(&ext)?,
            segments,
        })
    }

    pub fn content_type(&self) -> &'static str {
        self.content_type
    }

    /// Hashed by the build (Vite's `assets/`), so it may be cached forever.
    pub fn is_immutable(&self) -> bool {
        self.segments.len() > 1 && self.segments[0] == "assets"
    }

    fn relative(&self) -> PathBuf {
        self.segments.iter().collect()
    }
}

/// The types a bundle is made of. Anything else is not served.
fn content_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => return None,
    })
}

/// A package name: the `<package>` of `mfe/<package>`.
fn package_name(path: &str) -> Option<&str> {
    let name = path.strip_prefix("mfe/")?;
    let ok = name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    ok.then_some(name)
}

/// A version that can stand in a URL path segment.
fn url_safe_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version.starts_with(|c: char| c.is_ascii_alphanumeric())
        && !version.contains("..")
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}

/// One package of one kit, as the shell registers it.
#[derive(Debug, Clone, PartialEq)]
pub struct KitMfeManifest {
    pub kit_slug: String,
    pub version: String,
    pub package: String,
    /// Where the package's files are served, through the gateway, ending in `/`.
    pub base_path: String,
    /// The package's `mfe-manifest.json`; `None` when it does not read.
    pub config: Option<serde_json::Value>,
    /// Why `config` is `None`.
    pub error: Option<String>,
}

/// Every source, and the key grants are signed with.
pub struct KitBundles {
    sources: Vec<Arc<dyn BundleSource>>,
    key: Vec<u8>,
}

impl KitBundles {
    pub fn new(sources: Vec<Arc<dyn BundleSource>>, key: Vec<u8>) -> Self {
        Self { sources, key }
    }

    /// `STUDIO_KIT_BUNDLES_DIR` and `STUDIO_KIT_BUNDLE_KEY`. A directory that
    /// is named and cannot be read stops the gear at start.
    pub fn from_env() -> Result<Self> {
        let mut sources: Vec<Arc<dyn BundleSource>> = Vec::new();
        if let Some(dir) = std::env::var(BUNDLES_DIR_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
        {
            let source = DirSource::open(Path::new(dir.trim())).context(BUNDLES_DIR_ENV)?;
            tracing::info!(
                dir = %dir.trim(),
                kits = source.kits.len(),
                "studio-kits: serving kit bundles from a directory"
            );
            sources.push(Arc::new(source));
        }
        let key = match std::env::var(BUNDLE_KEY_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
        {
            Some(key) if key.trim().len() >= 16 => key.trim().as_bytes().to_vec(),
            Some(_) => bail!("{BUNDLE_KEY_ENV} must be at least 16 characters"),
            None => {
                let mut key = uuid::Uuid::new_v4().as_bytes().to_vec();
                key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
                key
            }
        };
        Ok(Self::new(sources, key))
    }

    /// Kits the sources add to the library.
    pub fn kits(&self) -> Vec<KitDescriptor> {
        self.sources.iter().flat_map(|s| s.kits()).collect()
    }

    fn source_for(
        &self,
        slug: &str,
        version: &str,
    ) -> Option<(&Arc<dyn BundleSource>, Vec<String>)> {
        self.sources.iter().find_map(|source| {
            let packages = source.packages(slug, version);
            (!packages.is_empty()).then_some((source, packages))
        })
    }

    /// What proves a caller was shown `slug` at `version`.
    pub fn grant(&self, slug: &str, version: &str) -> String {
        let mac = hmac_sha256(
            &self.key,
            format!("studio-kits/mfe\n{slug}\n{version}").as_bytes(),
        );
        hex::encode(&mac[..16])
    }

    fn grant_holds(&self, slug: &str, version: &str, grant: &str) -> bool {
        let expected = self.grant(slug, version);
        expected.len() == grant.len()
            && expected
                .bytes()
                .zip(grant.bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
    }

    /// The packages of each kit in `kits` (slug, version) that has bundles,
    /// with where their files are served.
    pub async fn manifests(&self, kits: &[(String, String)]) -> Vec<KitMfeManifest> {
        let mut out = Vec::new();
        for (slug, version) in kits {
            let Some((source, packages)) = self.source_for(slug, version) else {
                continue;
            };
            let grant = self.grant(slug, version);
            for package in packages {
                let base_path = format!(
                    "{GATEWAY_PREFIX}/studio-kits/v1/kits/{slug}/{version}/mfe/{grant}/{package}/"
                );
                let (config, error) = match read_config(source.as_ref(), slug, version, &package)
                    .await
                {
                    Ok(config) => (Some(config), None),
                    Err(error) => {
                        tracing::warn!(kit = %slug, %version, %package, "studio-kits: a bundle does not read: {error:#}");
                        (None, Some(format!("{error:#}")))
                    }
                };
                out.push(KitMfeManifest {
                    kit_slug: slug.clone(),
                    version: version.clone(),
                    package,
                    base_path,
                    config,
                    error,
                });
            }
        }
        out
    }

    /// One file of a bundle, for a holder of the kit's grant. `None` for
    /// anything else: a wrong grant reads the same as a missing file.
    pub async fn file(
        &self,
        slug: &str,
        version: &str,
        grant: &str,
        package: &str,
        path: &str,
    ) -> Result<Option<(BundleFile, Vec<u8>)>> {
        if !self.grant_holds(slug, version, grant) {
            return Ok(None);
        }
        let Some(file) = BundleFile::parse(path) else {
            return Ok(None);
        };
        let Some((source, packages)) = self.source_for(slug, version) else {
            return Ok(None);
        };
        if !packages.iter().any(|p| p == package) {
            return Ok(None);
        }
        Ok(source
            .read(slug, version, package, &file)
            .await?
            .map(|bytes| (file, bytes)))
    }
}

async fn read_config(
    source: &dyn BundleSource,
    slug: &str,
    version: &str,
    package: &str,
) -> Result<serde_json::Value> {
    let file = BundleFile::parse(MFE_MANIFEST).context("the manifest's name")?;
    let bytes = source
        .read(slug, version, package, &file)
        .await?
        .with_context(|| format!("no {MFE_MANIFEST}: build the bundle first"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        bail!("{MFE_MANIFEST} is larger than {MAX_MANIFEST_BYTES} bytes");
    }
    let config: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("{MFE_MANIFEST} is not JSON"))?;
    if !config
        .get("manifest")
        .is_some_and(serde_json::Value::is_object)
    {
        bail!("{MFE_MANIFEST} has no `manifest`: was it built with the frontxMfGts plugin?");
    }
    if !config
        .get("entries")
        .is_some_and(serde_json::Value::is_array)
    {
        bail!("{MFE_MANIFEST} has no `entries`");
    }
    Ok(config)
}

/// HMAC-SHA-256 (RFC 2104).
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| -> [u8; 64] {
        let mut out = [byte; 64];
        for (o, k) in out.iter_mut().zip(block.iter()) {
            *o ^= k;
        }
        out
    };
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}

/// One kit of a [`DirSource`].
#[derive(Debug, Clone)]
struct DirKit {
    kit: KitDescriptor,
    root: PathBuf,
    packages: Vec<String>,
}

/// A directory of kits: each subdirectory with a `kit.gdl` that names its
/// bundles (`mfe = [path("mfe/<package>")]`) is one, at the version it states.
/// Read once at start; a kit whose passport does not read is left out with a
/// warning, so one half-written kit does not hide the others.
pub struct DirSource {
    kits: Vec<DirKit>,
}

impl DirSource {
    pub fn open(dir: &Path) -> Result<Self> {
        let entries = std::fs::read_dir(dir)
            .with_context(|| format!("cannot read the directory {}", dir.display()))?;
        let mut kits: Vec<DirKit> = Vec::new();
        let mut roots: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.join(KIT_GDL_FILE).is_file())
            .collect();
        roots.sort();
        for root in roots {
            match read_kit(&root) {
                Ok(kit) if kits.iter().any(|k| k.kit.slug == kit.kit.slug) => tracing::warn!(
                    kit = %kit.kit.slug,
                    "studio-kits: two kits in {} share a slug; the second is left out",
                    dir.display()
                ),
                Ok(kit) => kits.push(kit),
                Err(error) => tracing::warn!(
                    path = %root.display(),
                    "studio-kits: a kit is left out: {error:#}"
                ),
            }
        }
        Ok(Self { kits })
    }

    fn kit(&self, slug: &str, version: &str) -> Option<&DirKit> {
        self.kits
            .iter()
            .find(|k| k.kit.slug == slug && k.kit.default_version == version)
    }
}

/// A kit of a [`DirSource`] from its `kit.gdl`.
fn read_kit(root: &Path) -> Result<DirKit> {
    let src = std::fs::read_to_string(root.join(KIT_GDL_FILE))
        .with_context(|| format!("cannot read {KIT_GDL_FILE}"))?;
    let passport = read_kit_gdl(&src).map_err(|e| anyhow::anyhow!("{KIT_GDL_FILE}: {e}"))?;
    let slug = normalize_slug(&passport.name)?;
    let Some(version) = passport.version.clone() else {
        bail!("`{slug}` states no version: a bundle is served at the version it was built as");
    };
    if !url_safe_version(&version) {
        bail!(
            "`{slug}`: version \"{version}\" cannot stand in a URL (letters, digits, `.`, `-`, `_`, `+`)"
        );
    }
    if passport.mfe.is_empty() {
        bail!("`{slug}` names no bundle (`mfe = [path(\"mfe/<package>\")]`)");
    }
    let mut packages = Vec::new();
    for path in &passport.mfe {
        let Some(name) = package_name(path) else {
            bail!(
                "`{slug}`: mfe \"{path}\" is not `mfe/<package>` (lowercase letters, digits, `-`, `_`)"
            );
        };
        packages.push(name.to_owned());
    }
    Ok(DirKit {
        kit: KitDescriptor {
            name: passport.title.clone().unwrap_or_else(|| slug.clone()),
            description: passport.description.clone().unwrap_or_default(),
            publisher: passport.publisher.clone().unwrap_or_default(),
            visibility: passport
                .visibility
                .clone()
                .unwrap_or_else(|| "public".into()),
            source: SOURCE_BUNDLE_DIR.to_owned(),
            repository_url: String::new(),
            default_version: version,
            manifest_path: KIT_GDL_FILE.to_owned(),
            shelf: SHELF_ORGANIZATION.to_owned(),
            levels: passport.levels.clone(),
            slug,
        },
        root: root.to_path_buf(),
        packages,
    })
}

#[async_trait]
impl BundleSource for DirSource {
    fn kits(&self) -> Vec<KitDescriptor> {
        self.kits.iter().map(|k| k.kit.clone()).collect()
    }

    fn packages(&self, slug: &str, version: &str) -> Vec<String> {
        self.kit(slug, version)
            .map(|k| k.packages.clone())
            .unwrap_or_default()
    }

    async fn read(
        &self,
        slug: &str,
        version: &str,
        package: &str,
        file: &BundleFile,
    ) -> Result<Option<Vec<u8>>> {
        let Some(kit) = self.kit(slug, version) else {
            return Ok(None);
        };
        if !kit.packages.iter().any(|p| p == package) {
            return Ok(None);
        }
        let dir = kit.root.join("mfe").join(package);
        let path = dir.join(file.relative());
        // `BundleFile` admits no `..`; a link inside the bundle that points out
        // of it is refused here, by where it really leads.
        let (Ok(dir), Ok(path)) = (
            tokio::fs::canonicalize(&dir).await,
            tokio::fs::canonicalize(&path).await,
        ) else {
            return Ok(None);
        };
        if !path.starts_with(&dir) || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Ok(None);
        }
        let meta = match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_file() => meta,
            _ => return Ok(None),
        };
        if meta.len() > MAX_FILE_BYTES {
            bail!("{} is larger than {MAX_FILE_BYTES} bytes", path.display());
        }
        Ok(Some(tokio::fs::read(&path).await.with_context(|| {
            format!("cannot read {}", path.display())
        })?))
    }
}

#[cfg(test)]
#[path = "bundles_tests.rs"]
mod tests;
