//! studio-spec-quality — a thin, authenticated wrapper over the external
//! spec-quality service (the detector API whose Swagger lives at the
//! configured `base_url`/docs).
//!
//! The service analyses specification documents with four async detectors —
//! `bloat` (cross-doc duplication), `purpose` (section roles + a purpose
//! gate), `leak` (foreign-content verdicts) and `traceability` (an ID graph
//! or LLM drift judging) — and authenticates with its OWN shared secret. This
//! gear exposes those endpoints under the Studio gateway
//! (`/cf/studio-spec-quality/v1/*`) and forwards a submission to the upstream
//! verbatim, attaching the server-held key. Callers authenticate with their normal Studio token —
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
//! A finished analysis is read as a verdict (`GET /verdicts`): the upstream
//! task interpreted once, here, rather than relayed and judged in every
//! client. The raw task passthrough that used to sit beside it (and a second
//! status vocabulary beside studio-tasks) is gone; the run's handler reads the
//! upstream directly.

pub mod analysis;
pub mod analyze_task;
pub mod batch_task;
pub mod config;
pub mod findings;
pub mod gear;
pub mod rest;
pub mod verdict;
