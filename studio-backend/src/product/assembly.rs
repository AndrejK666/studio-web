//! How a project's product is assembled: its **strategy** (ADR-0072,
//! `docs/design/product-gear-match.md` §8).
//!
//! Two ways to say which gears a product is made of, before the Gearbox
//! engine's completion fills in what they need and a person confirms:
//!
//! - [`Strategy::SpecMapping`] — the gears studio-spec-mapping's plan offers
//!   for the capabilities the project's Functional Requirements name: instant,
//!   free, deterministic. Provided by the Spec mapping kit (a base kit by
//!   default, ADR-0074).
//! - [`Strategy::GearsMatcher`] — the gears the project's latest gear match
//!   proposes (the gears-matcher service, `gear_match`): minutes, paid, varies
//!   between runs. Provided by the Gears matcher kit, and usable only where
//!   the service is configured.
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

/// The kits that bring the two strategies.
pub use crate::kit_registry::port::{GEARS_MATCHER_KIT, SPEC_MAPPING_KIT};

/// The privilege that sets the organization's default: the one that installs
/// kits, since the default is the Gears matcher kit's setting.
pub const DEFAULT_PRIVILEGE: &str = "kit.manage";

/// A way of assembling a product this gear knows how to run. Which of them a
/// project may use is not this list: it is what the kits that apply there
/// provide (their manifests' `assembly_strategy`, ADR-0074).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Strategy {
    SpecMapping,
    GearsMatcher,
}

impl Strategy {
    pub const ALL: [Strategy; 2] = [Strategy::SpecMapping, Strategy::GearsMatcher];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SpecMapping => "spec_mapping",
            Self::GearsMatcher => "gears_matcher",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|v| v.as_str() == s.trim())
    }

    /// The built-in kit that provides it.
    pub fn kit(self) -> &'static str {
        match self {
            Self::SpecMapping => SPEC_MAPPING_KIT,
            Self::GearsMatcher => GEARS_MATCHER_KIT,
        }
    }
}

/// What `strategy` reads as on the wire where a product is assembled by
/// hand: no strategy kit applies, or none of them can be used.
pub const MANUAL: &str = "manual";

/// The wire name of a strategy, or [`MANUAL`].
pub fn wire(s: Option<Strategy>) -> &'static str {
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

/// Which strategies can be used where the product is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Available {
    /// The strategies the kits that apply here provide, in [`Strategy::ALL`]
    /// order. `None`: the installed kits could not be read.
    pub kits: Option<Vec<Strategy>>,
    /// What is missing for the gears-matcher service to be called (the
    /// gear-match routes' 503); `None` when it can be.
    pub matcher_missing: Option<String>,
}

impl Available {
    /// Whether the kit providing `s` applies here; `None` when unknown.
    pub fn installed(&self, s: Strategy) -> Option<bool> {
        self.kits.as_ref().map(|k| k.contains(&s))
    }

    /// The strategies the installed kits provide; while they cannot be read,
    /// `spec_mapping` (a base kit by default, free and harmless), never the
    /// paid one.
    pub fn provided(&self) -> Vec<Strategy> {
        match &self.kits {
            Some(k) => k.clone(),
            None => vec![Strategy::SpecMapping],
        }
    }

    /// Why `s` cannot be used here, as a code and a sentence; `None` when it
    /// can.
    pub fn refusal(&self, s: Strategy) -> Option<(&'static str, String)> {
        match self.installed(s) {
            Some(false) => {
                let name = match s {
                    Strategy::SpecMapping => "Spec mapping",
                    Strategy::GearsMatcher => "Gears matcher",
                };
                return Some((
                    "KIT_NOT_INSTALLED",
                    format!(
                        "the {name} kit (`{}`) is not installed here: an administrator installs \
                         it under Organization › Kits, or for one project under Project › Kits",
                        s.kit()
                    ),
                ));
            }
            None if s == Strategy::GearsMatcher => {
                return Some((
                    "KIT_UNKNOWN",
                    "whether the Gears matcher kit is installed could not be read".to_owned(),
                ));
            }
            _ => {}
        }
        match s {
            Strategy::GearsMatcher => self
                .matcher_missing
                .as_ref()
                .map(|why| ("MATCHER_NOT_CONFIGURED", why.clone())),
            Strategy::SpecMapping => None,
        }
    }

    /// The strategies that can be used here.
    pub fn usable(&self) -> Vec<Strategy> {
        self.provided()
            .into_iter()
            .filter(|s| self.refusal(*s).is_none())
            .collect()
    }
}

/// What nobody chose: `spec_mapping` when it is one of `provided`, else the
/// first (so the only one, where one strategy kit is installed); none without
/// a strategy kit.
pub fn default_of(provided: &[Strategy]) -> Option<Strategy> {
    if provided.contains(&Strategy::SpecMapping) {
        Some(Strategy::SpecMapping)
    } else {
        provided.first().copied()
    }
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
    let (chosen, source) = match (project, organization_default) {
        (Some(p), _) => (Some(p), Source::Project),
        (None, Some(o)) => (Some(o), Source::Organization),
        (None, None) => (default_of(&available.provided()), Source::Studio),
    };
    let fallback = chosen.and_then(|c| available.refusal(c));
    let strategy = match (chosen, &fallback) {
        (Some(c), None) => Some(c),
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
            .col_expr(settings::Column::Strategy, Expr::value(strategy.as_str()))
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
