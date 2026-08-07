//! `SeaORM` entity for the `studio_projects` table.
//!
//! The source columns are deliberately loose here (three nullable fields) and
//! tight in the migration (CHECK constraints) and in the domain
//! ([`super::model::ProjectSource`]). `SeaORM` has no sum types, so the enum is
//! flattened for storage; the invariant that exactly one shape is populated is
//! enforced at the two ends that can actually enforce it.

use sea_orm::entity::prelude::*;
use time::OffsetDateTime;
use toolkit_db::secure::Scopable;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
#[sea_orm(table_name = "studio_projects")]
#[secure(tenant_col = "tenant_id", resource_col = "id", no_owner, no_type)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// Workspace tenant that owns the project.
    pub tenant_id: Uuid,
    pub name: String,
    /// 1 = greenfield, 2 = modernize.
    pub mode: i16,
    /// 1 = draft, 2 = active, 3 = archived.
    pub status: i16,
    /// Journey stage keys as a JSON array, in catalogue order.
    pub stages: String,
    /// Greenfield only: the pasted idea / PRD.
    pub brief: Option<String>,
    /// Modernize only: 1 = git, 2 = upload.
    pub source_kind: Option<i16>,
    pub source_git_url: Option<String>,
    /// file-storage file id. Only the reference — bytes never come here.
    pub source_file_id: Option<Uuid>,
    /// Resource Group group holding the members (ADR-0002 keeps membership
    /// there). `None` when RG was unreachable at creation.
    pub rg_group_id: Option<Uuid>,
    pub created_by: Uuid,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
