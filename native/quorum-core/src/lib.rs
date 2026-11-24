//! Framework-independent native services. No file access belongs in a render callback.
pub mod archive;
pub mod jobs;
pub mod journal;
pub mod profile;
pub mod providers;
pub mod worker;
pub mod workspace;

pub mod desktop_profile;
pub mod plan;
pub mod service;
