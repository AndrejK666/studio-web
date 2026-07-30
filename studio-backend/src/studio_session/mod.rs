//! studio-session — Studio's first own gear.
//!
//! Launches, tracks and reaps per-workspace Theia IDE containers
//! (fabric-poc/poc/theia image) through the Docker API. See
//! docs/adr/0003-theia-sessions.md for the architecture and the k8s path.

pub mod config;
pub mod gear;
pub mod rest;
pub mod service;
