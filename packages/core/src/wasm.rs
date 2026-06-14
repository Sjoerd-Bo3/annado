//! `wasm-bindgen` wrappers around the pure core, for the Obsidian plugin.
//!
//! Every function here takes and returns strings or `serde_wasm_bindgen`
//! values and performs **no** file I/O: the plugin reads/writes the vault via
//! the Obsidian Vault API and passes file contents in and results out. The
//! engine stays synchronous; the host orchestrates the async I/O around it.

use crate::calendar::{self, IcsSubscription};
use crate::parser::{self, Task};
use crate::recurrence;
use crate::vault_ops;
use chrono::{DateTime, NaiveDate, Utc};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

/// Parse a "today" string (`YYYY-MM-DD`) into a `NaiveDate`, falling back to a
/// fixed epoch-ish date only if malformed (callers always pass a valid date).
fn parse_today(today: &str) -> NaiveDate {
    NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .unwrap_or_else(|_| NaiveDate::from_ymd_opt(1970, 1, 1).unwrap())
}

fn to_js<T: serde::Serialize>(value: &T) -> std::result::Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> std::result::Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Parse a markdown file's `contents` into the task list. `today` is
/// `YYYY-MM-DD`. Returns `Task[]`.
#[wasm_bindgen]
pub fn parse_file(path: &str, contents: &str, today: &str) -> std::result::Result<JsValue, JsValue> {
    let tasks = parser::parse_file(contents, path, parse_today(today));
    to_js(&tasks)
}

/// Format a single `Task` (JS object) back to its markdown line.
/// `file_project` may be `null`; `project_names` is `string[]`.
#[wasm_bindgen]
pub fn format_task_line(
    task: JsValue,
    today: &str,
    file_project: Option<String>,
    project_names: JsValue,
) -> std::result::Result<String, JsValue> {
    let task: Task = from_js(task)?;
    let names: HashSet<String> = from_js(project_names)?;
    Ok(parser::format_task_line(
        &task,
        parse_today(today),
        file_project.as_deref(),
        &names,
    ))
}

/// Apply an updated `Task` (JS object) to `contents`, returning the new file
/// contents. `file_project` may be `null`; `project_names` is `string[]`.
#[wasm_bindgen]
pub fn apply_task_update(
    contents: &str,
    task: JsValue,
    today: &str,
    file_project: Option<String>,
    project_names: JsValue,
) -> std::result::Result<String, JsValue> {
    let task: Task = from_js(task)?;
    let names: HashSet<String> = from_js(project_names)?;
    vault_ops::apply_task_update(contents, &task, parse_today(today), file_project.as_deref(), &names)
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn toggle_checklist_item(
    contents: &str,
    task_line_number: usize,
    item_index: usize,
) -> std::result::Result<String, JsValue> {
    vault_ops::toggle_checklist_item(contents, task_line_number, item_index)
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn rename_checklist_item(
    contents: &str,
    task_line_number: usize,
    item_index: usize,
    new_title: &str,
) -> std::result::Result<String, JsValue> {
    vault_ops::rename_checklist_item(contents, task_line_number, item_index, new_title)
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn delete_checklist_item(
    contents: &str,
    task_line_number: usize,
    item_index: usize,
) -> std::result::Result<String, JsValue> {
    vault_ops::delete_checklist_item(contents, task_line_number, item_index)
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn delete_task(
    contents: &str,
    task_line_number: usize,
    task_indent: usize,
) -> std::result::Result<String, JsValue> {
    vault_ops::delete_task(contents, task_line_number, task_indent)
        .map_err(|e| JsValue::from_str(&e))
}

/// Render the date portion of a daily-note path (moment.js `format`).
#[wasm_bindgen]
pub fn daily_note_date_path(today: &str, format: &str) -> String {
    vault_ops::daily_note_date_path(parse_today(today), format)
}

/// Whether a recurring template (JS object) should generate a new instance as of
/// `today` (`YYYY-MM-DD`).
#[wasm_bindgen]
pub fn should_generate_instance(template: JsValue, today: &str) -> std::result::Result<bool, JsValue> {
    let template = from_js(template)?;
    Ok(recurrence::should_generate_instance(&template, parse_today(today)))
}

/// Expand an ICS feed body into `CalendarEvent[]` for `sub` (JS object) within
/// `[window_start, window_end]` (RFC 3339 / ISO-8601 strings, e.g.
/// `2026-06-14T00:00:00Z`). No network access happens here — the host fetches
/// the feed and passes the text in.
#[wasm_bindgen]
pub fn expand_ics(
    ics_text: &str,
    sub: JsValue,
    window_start: &str,
    window_end: &str,
) -> std::result::Result<JsValue, JsValue> {
    let sub: IcsSubscription = from_js(sub)?;
    let ws: DateTime<Utc> = window_start
        .parse()
        .map_err(|e| JsValue::from_str(&format!("Invalid window_start: {}", e)))?;
    let we: DateTime<Utc> = window_end
        .parse()
        .map_err(|e| JsValue::from_str(&format!("Invalid window_end: {}", e)))?;
    let events = calendar::events_in_window(ics_text, &sub, ws, we);
    to_js(&events)
}

/// The list of `CalendarInfo` produced by a set of ICS subscriptions
/// (`IcsSubscription[]`). Mirrors `calendar::subscription_calendars`.
#[wasm_bindgen]
pub fn subscription_calendars(subs: JsValue) -> std::result::Result<JsValue, JsValue> {
    let subs: Vec<IcsSubscription> = from_js(subs)?;
    to_js(&calendar::subscription_calendars(&subs))
}
