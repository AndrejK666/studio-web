//! What another gear needs to run its work here, and nothing else.
//!
//! A producer registers a [`TaskHandler`] for its task type at `init` and
//! enqueues a [`NewRun`] through the [`TaskQueue`](super::TaskQueue) client on
//! the ClientHub. The handler gets a [`TaskContext`], may report progress with
//! a [`SyncReporter`], and ends with a [`TaskOutcome`]. `studio-scheduler`
//! also asks which task types exist ([`known_task_types`], [`handler`]) to
//! refuse a schedule for one that does not.
//!
//! The background-work port (ADR-0079 §4): a gear that wants a schedule the
//! deployment always has submits a [`ScheduleSet`] (`inventory`) in its own
//! module; `studio-scheduler` ensures every submitted one, naming no gear.
//!
//! The registry, the service and the dispatcher behind these stay private to
//! the gear.

pub use super::registry::{
    EndedByQueue, SyncReporter, TaskContext, TaskHandler, TaskOutcome, handler, known_task_types,
    register,
};
pub use super::service::NewRun;
pub use super::{PlatformSchedule, ScheduleSet, contributed_schedules};
