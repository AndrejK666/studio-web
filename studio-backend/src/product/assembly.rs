//! How a project's product is assembled: its **strategy** (ADR-0072,
//! `docs/design/product-gear-match.md` §8).
//!
//! Two ways to say which gears a product is made of, before the Gearbox
//! engine's completion fills in what they need and a person confirms:
//!
//! - [`Strategy::SpecMapping`] — the gears studio-spec-mapping's plan offers
//!   for the capabilities the project's Functional Requirements name: instant,
//!   free, deterministic. Studio's default, and what every project did before.
//! - [`Strategy::GearsMatcher`] — the gears the project's latest gear match
//!   proposes (the gears-matcher service, `gear_match`): minutes, paid, varies
//!   between runs. Offered only where the Gears matcher kit applies and the
//!   service is configured.
//!
//! Which one a project uses is a setting: the organization's default (set by
//! an administrator on Organization › Gears matcher), and a project's own
//! choice over it. Where the chosen strategy cannot be used, the product falls
//! back to `spec_mapping` and says why ([`Effective::fallback`]). Nothing is
//! applied silently either way: a strategy only proposes picks.
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

/// The kit that brings the `gears_matcher` strategy.
pub use crate::kit_registry::port::GEARS_MATCHER_KIT;

/// The privilege that sets the organization's default: the one that installs
/// kits, since the default is the Gears matcher kit's setting.
pub const DEFAULT_PRIVILEGE: &str = "kit.manage";

/// A way of assembling a product.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
}

/// What Studio uses where nobody chose.
pub const STUDIO_DEFAULT: Strategy = Strategy::SpecMapping;

/// Where the chosen strategy comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The project chose it.
    Project,
    /// The organization's default.
    Organization,
    /// Nobody chose: Studio's default.
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

/// Whether the gears-matcher strategy can be used where the product is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatcherState {
    /// The Gears matcher kit applies (the project's effective kits, or the
    /// organization's). `None`: it could not be read.
    pub kit: Option<bool>,
    /// What is missing for the service to be called (the gear-match routes'
    /// 503); `None` when it can be.
    pub missing: Option<String>,
}

impl MatcherState {
    /// Why `gears_matcher` cannot be used, as a code and a sentence; `None`
    /// when it can.
    pub fn refusal(&self) -> Option<(&'static str, String)> {
        match self.kit {
            Some(false) => {
                return Some((
                    "KIT_NOT_INSTALLED",
                    "the Gears matcher kit is not installed here: an administrator installs it \
                     under Organization › Kits, or for one project under Project › Kits"
                        .to_owned(),
                ));
            }
            None => {
                return Some((
                    "KIT_UNKNOWN",
                    "whether the Gears matcher kit is installed could not be read".to_owned(),
                ));
            }
            Some(true) => {}
        }
        self.missing
            .as_ref()
            .map(|why| ("MATCHER_NOT_CONFIGURED", why.clone()))
    }
}

/// The strategy a product is assembled by, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effective {
    /// What is used.
    pub strategy: Strategy,
    /// What the settings ask for.
    pub chosen: Strategy,
    pub source: Source,
    /// The project's own choice; `None`: the organization's default.
    pub project: Option<Strategy>,
    /// The organization's default; `None`: Studio's.
    pub organization_default: Option<Strategy>,
    /// Why `chosen` is not used: a code and a sentence.
    pub fallback: Option<(&'static str, String)>,
    pub matcher: MatcherState,
}

/// The strategy used, from the settings and whether the matcher can be used.
/// Pure: the rule the REST read and the tests share.
pub fn resolve(
    project: Option<Strategy>,
    organization_default: Option<Strategy>,
    matcher: MatcherState,
) -> Effective {
    let (chosen, source) = match (project, organization_default) {
        (Some(p), _) => (p, Source::Project),
        (None, Some(o)) => (o, Source::Organization),
        (None, None) => (STUDIO_DEFAULT, Source::Studio),
    };
    let fallback = match chosen {
        Strategy::SpecMapping => None,
        Strategy::GearsMatcher => matcher.refusal(),
    };
    Effective {
        strategy: if fallback.is_some() {
            Strategy::SpecMapping
        } else {
            chosen
        },
        chosen,
        source,
        project,
        organization_default,
        fallback,
        matcher,
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
