//! `SeaORM` entities for the artifact index (see [`super::index`]).

use sea_orm::entity::prelude::*;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

pub mod node {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_artifact_index")]
    // Keyed by tenant and nothing narrower, for the same reason the graph
    // projection it mirrors is: graph-storage authorizes a read once and then
    // scopes it to the tenant, so two authorized callers see the same rows.
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub instance_id: String,
        /// Our GTS type id (`gts.cf.studio.artifact.issue.v1~`), not the
        /// graph's derived one.
        pub type_id: String,
        /// The payload's `workspace_id`, or `''` when it names none.
        pub workspace_id: String,
        /// The payload's `project_id`, or `''`.
        pub project_id: String,
        /// The payload's `repo`, or `''`.
        pub repo: String,
        /// The payload's `path`, or `''` — what a file row is shown by.
        pub path: String,
        pub is_dir: bool,
        /// The payload's `updated_at` (ISO-8601), or `''`.
        pub updated_at: String,
        /// Lower-cased title, author, path and full path, then the number —
        /// what the listing's `q` matches against.
        pub search_text: String,
        #[sea_orm(column_type = "JsonBinary")]
        pub payload: Json,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_artifact_index has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod fill {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_artifact_index_fill")]
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        pub filled_at_ms: i64,
        /// How many nodes the fill wrote, for the log and for whoever wonders
        /// whether it ran against the graph they think it did.
        pub nodes: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_artifact_index_fill has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod clone_status {
    use super::{DeriveEntityModel, Scopable, Uuid};
    use sea_orm::entity::prelude::*;

    /// The last clone or fetch of one project source (see
    /// `artifact_ingest::clone_status`). One row per source, never a history.
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_source_clone_status")]
    // The tenant is the project: a project is a tenant, and whoever reaches
    // the project's config reaches its sources' rows.
    #[secure(tenant_col = "tenant_id", no_owner, no_type, no_resource)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub tenant_id: Uuid,
        /// `host/owner/repo`, lower case, from the clone URL with any
        /// credentials, the scheme and `.git` left out
        /// (`project_sources::repository_key`).
        #[sea_orm(primary_key, auto_increment = false)]
        pub repository: String,
        /// `cloned` or `failed`.
        pub state: String,
        pub at_ms: i64,
        /// Who cloned: `desktop` or `ide_session`.
        pub channel: String,
        /// Why it failed (`CloneCause`), `None` when it did not.
        pub cause: Option<String>,
        /// The source host's HTTP status, when it answered one.
        pub upstream_status: Option<i32>,
        /// What else is known, redacted of credentials.
        pub detail: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_source_clone_status has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}
