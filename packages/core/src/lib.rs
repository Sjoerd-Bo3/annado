//! `annado-core` — the pure markdown task engine shared by the Tauri desktop
//! shell and the Obsidian plugin.
//!
//! Everything here is deterministic and free of platform glue (no `std::fs`,
//! no `notify` watcher, no `WalkDir`, no Tauri, no network). The host reads and
//! writes files and passes their contents in and out, so the *exact same* code
//! produces byte-identical output on native (`cargo test`) and on
//! `wasm32-unknown-unknown` (via the [`wasm`] wrappers under the `wasm` feature).
//!
//! Modules:
//! - [`parser`]   — task-line grammar parsing and `format_task_line` (verbatim
//!   from the Tauri backend; the parity oracle lives in its `#[cfg(test)]`).
//! - [`vault_ops`] — pure file-content surgery for update/toggle/rename/delete
//!   plus daily-note path formatting (`moment_to_chrono`).
//! - [`recurrence`] — recurring-template date math.
//! - [`calendar`] — ICS (RFC 5545) parsing and recurrence expansion (no fetch).

pub mod calendar;
pub mod parser;
pub mod recurrence;
pub mod vault_ops;

#[cfg(feature = "wasm")]
pub mod wasm;
