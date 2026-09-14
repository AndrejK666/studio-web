//! studio-spec-quality — a thin, authenticated wrapper over the external
//! spec-quality service (the detector API whose Swagger lives at the
//! configured `base_url`/docs).
//!
//! The service analyses specification documents with four async detectors —
//! `bloat` (cross-doc duplication), `purpose` (section roles + a purpose
//! gate), `leak` (foreign-content verdicts) and `traceability` (an ID graph
//! or LLM drift judging) — and authenticates with its OWN shared secret. This
//! gear exposes those endpoints under the Studio gateway
//! (`/cf/spec-quality/v1/*`) and forwards to the upstream verbatim, attaching
//! the server-held key. Callers authenticate with their normal Studio token —
//! the spec-quality key never leaves the backend (it lives in this gear's
//! config, same pattern as `studio-llm-proxy`).
//!
//! The upstream is asynchronous — submit → 202 `TaskCreated`, then read
//! `GET /v1/tasks/{id}` until it is done — and that second half used to be the
//! caller's. It is not any more: a submit records a `spec_quality.analyze` run
//! ([`analyze_task`]) that watches the upstream task to its verdict, so a
//! minutes-long analysis is a background run like every other one in the
//! assembly and the portal is told about it on `studio-events` rather than
//! polling for it.
//!
//! The verbatim passthrough remains for the upstream's own task reads
//! (`GET /spec-quality/v1/tasks/{id}`), which is what the run's handler and
//! anyone debugging the upstream use.

pub mod analyze_task;
pub mod config;
pub mod gear;
pub mod rest;
