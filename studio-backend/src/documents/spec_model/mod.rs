//! A project's domain model, read from its documents, and the places they
//! disagree about it (`docs/spec-domain-model.md`).
//!
//! Built in stages. This module holds the ones that need no model: the
//! reference index and its rules (`index.rs`), and the finding every stage
//! answers with (`finding.rs`).

pub(crate) mod finding;
pub(crate) mod index;
