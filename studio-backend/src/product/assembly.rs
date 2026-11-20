//! How a project's product is assembled: its **strategy** (ADR-0072,
//! `docs/design/product-gear-match.md` §8).
//!
//! Two ways to say which gears a product is made of, before the Gearbox
//! engine's completion fills in what they need and a person confirms:
//!
//! - `spec_mapping` — the gears studio-spec-mapping's plan offers
//!   for the capabilities the project's Functional Requirements name: instant,
//!   free, deterministic. Provided by the Spec mapping kit (a base kit by
//!   default, ADR-0074).
//! - `gears_matcher` — the gears the project's latest gear match
//!   proposes (the gears-matcher service, `gear_match`): minutes, paid, varies
//!   between runs. Provided by the Gears matcher kit, and usable only where
//!   the service is configured.
//! - an organization's kit's own service strategy (amendment to ADR-0074):
//!   run by the service the organization connected for it, through the same
//!   gear-match pipeline as `gears_matcher`; `STRATEGY_NOT_CONNECTED` until
//!   it is.
//!
//! The strategies a project may use are the ones the kits that apply there
//! declare (`assembly_strategy` in their manifests, ADR-0074), not a list
//! here. Which one it uses is a setting: the organization's default (set by
//! an administrator on Organization › Gears matcher), and a project's own
//! choice over it; nobody's choice is the only strategy kit installed, else
//! `spec_mapping`. Where the chosen strategy cannot be used, the product falls
//! back to one that can and says why ([`Effective::fallback`]); with none, it
//! is assembled by hand in the configurator. Nothing is applied silently
//! either way: a strategy only proposes picks.
//!
//! The settings are kept in the gear's database (`m0004`), one row per
//! organization default and per project choice, keyed by the organization the
//! project hangs under, as the gear matches are.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, EntityTrait};
use toolkit_db::Db;
use toolkit_db::secure::{SecureDeleteExt, SecureEntityExt, SecureInsertExt, SecureUpdateExt};
use toolkit_security::AccessScope;
use uuid::Uuid;

/// The kits that bring the shipped strategies.
pub use crate::kit_registry::port::{GEARS_MATCHER_KIT, SPEC_MAPPING_KIT};

/// The privilege that sets the organization's default: the one that installs
/// kits, since the default is the Gears matcher kit's setting.
pub const DEFAULT_PRIVILEGE: &str = "kit.manage";

/// A way of assembling a product, by its id as a kit's manifest declares it
/// (`assembly_strategy.id`, ADR-0074). `spec_mapping` is run by this gear's
/// own code; every other strategy by a service through the gear-match
/// pipeline (`gears_matcher`, Studio's; an organization's kit's own). Which
/// ones a project may use is what the kits that apply there provide.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Strategy(String);

impl Strategy {
    pub const SPEC_MAPPING: &'static str = "spec_mapping";
    pub const GEARS_MATCHER: &'static str = "gears_matcher";

    pub fn spec_mapping() -> Self {
        Self(Self::SPEC_MAPPING.to_owned())
    }

    pub fn gears_matcher() -> Self {
        Self(Self::GEARS_MATCHER.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// A strategy id as a kit writes one: `snake_case`, at most 40.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let ok = !s.is_empty()
            && s.len() <= 40
            && s.starts_with(|c: char| c.is_ascii_lowercase())
            && s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        ok.then(|| Self(s.to_owned()))
    }

    pub fn is_spec_mapping(&self) -> bool {
        self.0 == Self::SPEC_MAPPING
    }

    /// The order strategies are offered in: Studio's two first, then the
    /// organizations' by id.
    fn rank(&self) -> (u8, &str) {
        match self.as_str() {
            Self::SPEC_MAPPING => (0, ""),
            Self::GEARS_MATCHER => (1, ""),
            other => (2, other),
        }
    }

    /// The built-in kit that provides it, for the shipped ones.
    pub fn builtin_kit(&self) -> Option<(&'static str, &'static str)> {
        match self.as_str() {
            Self::SPEC_MAPPING => Some((SPEC_MAPPING_KIT, "Spec mapping")),
            Self::GEARS_MATCHER => Some((GEARS_MATCHER_KIT, "Gears matcher")),
            _ => None,
        }
    }
}

/// What `strategy` reads as on the wire where a product is assembled by
/// hand: no strategy kit applies, or none of them can be used.
pub const MANUAL: &str = "manual";

/// The wire name of a strategy, or [`MANUAL`].
pub fn wire(s: Option<&Strategy>) -> &str {
    s.map_or(MANUAL, Strategy::as_str)
}

/// Where the chosen strategy comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The project chose it.
    Project,
    /// The organization's default.
    Organization,
    /// Nobody chose: what the installed strategy kits make the default (the
    /// only one, else `spec_mapping`).
    Studio,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Organization => "organization",
            Self::Studio => "studio",
        }
    }
}

/// A strategy a kit that applies provides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub strategy: Strategy,
    /// The kit that provides it.
    pub kit: String,
    /// A service runs it (the gear-match pipeline); `false` for
    /// `spec_mapping`.
    pub service: bool,
}

/// Which strategies can be used where the product is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Available {
    /// The strategies the kits that apply here provide. `None`: the
    /// installed kits could not be read.
    pub kits: Option<Vec<Offer>>,
    /// Why a service strategy's service cannot be called, by strategy id: a
    /// code (`MATCHER_NOT_CONFIGURED`, `STRATEGY_NOT_CONNECTED`) and a
    /// sentence. Absent: it can.
    pub services: std::collections::BTreeMap<String, (&'static str, String)>,
}

impl Available {
    /// Whether a kit providing `id` applies here; `None` when unknown.
    pub fn installed(&self, id: &str) -> Option<bool> {
        self.kits
            .as_ref()
            .map(|k| k.iter().any(|o| o.strategy.as_str() == id))
    }

    /// The offer of `id`, when a kit here provides it.
    pub fn offer(&self, id: &str) -> Option<&Offer> {
        self.kits
            .as_ref()?
            .iter()
            .find(|o| o.strategy.as_str() == id)
    }

    /// The strategies the installed kits provide, in the order offered;
    /// while they cannot be read, `spec_mapping` (a base kit by default, free
    /// and harmless), never a paid one.
    pub fn provided(&self) -> Vec<Strategy> {
        let mut out: Vec<Strategy> = match &self.kits {
            Some(k) => k.iter().map(|o| o.strategy.clone()).collect(),
            None => vec![Strategy::spec_mapping()],
        };
        out.sort_by(|a, b| a.rank().cmp(&b.rank()));
        out.dedup();
        out
    }

    /// Why `s` cannot be used here, as a code and a sentence; `None` when it
    /// can.
    pub fn refusal(&self, s: &Strategy) -> Option<(&'static str, String)> {
        match self.installed(s.as_str()) {
            Some(false) => {
                return Some((
                    "KIT_NOT_INSTALLED",
                    match s.builtin_kit() {
                        Some((slug, name)) => format!(
                            "the {name} kit (`{slug}`) is not installed here: an administrator \
                             installs it under Organization › Kits, or for one project under \
                             Project › Kits"
                        ),
                        None => format!(
                            "no kit installed here provides the `{}` strategy: an administrator \
                             installs the organization's kit that does under Organization › Kits",
                            s.as_str()
                        ),
                    },
                ));
            }
            None if !s.is_spec_mapping() => {
                return Some((
                    "KIT_UNKNOWN",
                    format!(
                        "whether the kit that provides the `{}` strategy is installed could not \
                         be read",
                        s.as_str()
                    ),
                ));
            }
            _ => {}
        }
        self.services.get(s.as_str()).cloned()
    }

    /// The strategies that can be used here.
    pub fn usable(&self) -> Vec<Strategy> {
        self.provided()
            .into_iter()
            .filter(|s| self.refusal(s).is_none())
            .collect()
    }
}

/// The offers of the strategies `provided` declares that studio-product
/// can run: `spec_mapping` (its own code) and every service strategy whose
/// contract it speaks.
pub fn offers(provided: &[crate::kit_registry::port::ProvidedStrategy]) -> Vec<Offer> {
    provided
        .iter()
        .filter_map(|p| {
            let strategy = Strategy::parse(&p.id)?;
            let runs = match p.service.as_deref() {
                None => strategy.is_spec_mapping(),
                Some(contract) => crate::kit_registry::port::STRATEGY_CONTRACTS.contains(&contract),
            };
            runs.then(|| Offer {
                strategy,
                kit: p.kit.clone(),
                service: p.service.is_some(),
            })
        })
        .collect()
}

/// What nobody chose: `spec_mapping` when it is one of `provided`, else the
/// first (so the only one, where one strategy kit is installed); none without
/// a strategy kit.
pub fn default_of(provided: &[Strategy]) -> Option<Strategy> {
    provided
        .iter()
        .find(|s| s.is_spec_mapping())
        .or_else(|| provided.first())
        .cloned()
}

/// The strategy a product is assembled by, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effective {
    /// What is used; `None`: the product is assembled by hand.
    pub strategy: Option<Strategy>,
    /// What the settings ask for; `None` where nothing was chosen and no
    /// strategy kit applies.
    pub chosen: Option<Strategy>,
    pub source: Source,
    /// The project's own choice; `None`: the organization's default.
    pub project: Option<Strategy>,
    /// The organization's default; `None`: what the kits make it.
    pub organization_default: Option<Strategy>,
    /// Why `chosen` is not used: a code and a sentence.
    pub fallback: Option<(&'static str, String)>,
    pub available: Available,
}

/// The strategy used, from the settings and what can be used here. Pure: the
/// rule the REST reads, the usage statistics and the tests share.
pub fn resolve(
    project: Option<Strategy>,
    organization_default: Option<Strategy>,
    available: Available,
) -> Effective {
    let (chosen, source) = match (&project, &organization_default) {
        (Some(p), _) => (Some(p.clone()), Source::Project),
        (None, Some(o)) => (Some(o.clone()), Source::Organization),
        (None, None) => (default_of(&available.provided()), Source::Studio),
    };
    let fallback = chosen.as_ref().and_then(|c| available.refusal(c));
    let strategy = match (&chosen, &fallback) {
        (Some(c), None) => Some(c.clone()),
        // Falls back to what can be used, `spec_mapping` first; by hand when
        // nothing can.
        _ => default_of(&available.usable()),
    };
    Effective {
        strategy,
        chosen,
        source,
        project,
        organization_default,
        fallback,
        available,
    }
}

pub mod settings {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_product_assembly_strategies")]
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        /// The organization.
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        /// The project a choice is for; the organization itself for its
        /// default.
        #[sea_orm(primary_key, auto_increment = false)]
        pub scope_id: Uuid,
        /// `spec_mapping` or `gears_matcher`.
        pub strategy: String,
        /// The person's subject id.
        pub set_by: String,
        pub updated_at_ms: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_product_assembly_strategies has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

/// The organization's default and its projects' choices.
pub struct StrategyStore {
    db: Db,
}

impl StrategyStore {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The strategy kept for `scope` (a project, or `org` itself for its
    /// default). A value this version does not know reads as none.
    pub async fn get(&self, org: Uuid, scope: Uuid) -> anyhow::Result<Option<Strategy>> {
        let conn = self.db.conn()?;
        let row = settings::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(Condition::all().add(settings::Column::ScopeId.eq(scope)))
            .one(&conn)
            .await?;
        Ok(row.and_then(|r| Strategy::parse(&r.strategy)))
    }

    /// Every strategy kept in the organization `org`: its default (`scope`
    /// = `org`) and its projects' choices, by scope. A value this version
    /// does not know is left out.
    pub async fn all(&self, org: Uuid) -> anyhow::Result<Vec<(Uuid, Strategy)>> {
        let conn = self.db.conn()?;
        let rows = settings::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .all(&conn)
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| Strategy::parse(&r.strategy).map(|s| (r.scope_id, s)))
            .collect())
    }

    /// Keep `strategy` for `scope`; `None` forgets it.
    pub async fn put(
        &self,
        org: Uuid,
        scope: Uuid,
        strategy: Option<Strategy>,
        set_by: &str,
    ) -> anyhow::Result<()> {
        use sea_orm::ActiveValue::Set;
        let conn = self.db.conn()?;
        let key = Condition::all().add(settings::Column::ScopeId.eq(scope));
        let Some(strategy) = strategy else {
            settings::Entity::delete_many()
                .secure()
                .scope_with(&AccessScope::for_tenant(org))
                .filter(key)
                .exec(&conn)
                .await?;
            return Ok(());
        };
        let now = super::gear_match::store::now_ms();
        let updated = settings::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(key)
            .col_expr(
                settings::Column::Strategy,
                Expr::value(strategy.as_str().to_owned()),
            )
            .col_expr(settings::Column::SetBy, Expr::value(set_by.to_owned()))
            .col_expr(settings::Column::UpdatedAtMs, Expr::value(now))
            .exec(&conn)
            .await?;
        if updated.rows_affected > 0 {
            return Ok(());
        }
        let active = settings::ActiveModel {
            tenant_id: Set(org),
            scope_id: Set(scope),
            strategy: Set(strategy.as_str().to_owned()),
            set_by: Set(set_by.to_owned()),
            updated_at_ms: Set(now),
        };
        settings::Entity::insert(active)
            .secure()
            // The organization the caller was shown to reach (or the
            // project's, resolved as the caller reads the tree).
            .scope_unchecked(&AccessScope::for_tenant(org))?
            .exec(&conn)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "assembly_tests.rs"]
mod tests;
