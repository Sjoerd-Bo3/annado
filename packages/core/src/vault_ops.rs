//! Pure file-content surgery for task mutations.
//!
//! These functions reproduce the markdown-editing logic of `Vault::update_task`,
//! `toggle_checklist_item`, `rename_checklist_item`, `delete_checklist_item`,
//! and `delete_task` in `src-tauri/src/vault.rs` — with the file I/O and cache
//! bookkeeping stripped out. The host reads a file's contents, calls one of
//! these to get the new contents, and writes them back (native `std::fs` for
//! the Tauri shell, the Vault API for the Obsidian plugin). The string output
//! is byte-identical to the original in-place edits.

use crate::parser::{self, Task};
use chrono::NaiveDate;
use std::collections::HashSet;

/// Convert a moment.js date format string to a chrono format string.
/// Tokens are replaced longest-first to avoid partial matches (e.g. MMMM before MM).
///
/// Ported verbatim from `vault.rs::moment_to_chrono`. Used to render the
/// daily-note path stem from the Obsidian "Daily notes" format setting.
pub fn moment_to_chrono(fmt: &str) -> String {
    let replacements: &[(&str, &str)] = &[
        ("YYYY", "%Y"),
        ("YY", "%y"),
        ("MMMM", "%B"),
        ("MMM", "%b"),
        ("MM", "%m"),
        ("M", "%m"),
        ("DD", "%d"),
        ("D", "%d"),
        ("dddd", "%A"),
        ("ddd", "%a"),
    ];
    let mut result = fmt.to_string();
    for (token, chrono) in replacements {
        result = result.replace(token, chrono);
    }
    result
}

/// Render the date portion of a daily-note path for `date` given a moment.js
/// `format` string (e.g. `YYYY/MM-MMMM/YYYY-MM-DD`). The host joins this with
/// the daily-notes folder and a `.md` extension.
pub fn daily_note_date_path(date: NaiveDate, format: &str) -> String {
    let chrono_fmt = moment_to_chrono(format);
    date.format(&chrono_fmt).to_string()
}

/// Result of a task mutation that also reports the task line's index, so callers
/// that need it for diagnostics can use it; most just take `contents`.
pub type Result<T> = std::result::Result<T, String>;

/// Apply an updated task to `contents`, returning the new file contents.
///
/// Mirrors `Vault::update_task`: rewrites the task's own line via
/// [`parser::format_task_line`] and replaces the block of indented *notes*
/// below it (checklist lines — those starting with `- [`) are left untouched).
pub fn apply_task_update(
    contents: &str,
    updated_task: &Task,
    today: NaiveDate,
    file_project: Option<&str>,
    project_names: &HashSet<String>,
) -> Result<String> {
    let lines: Vec<&str> = contents.lines().collect();

    let line_index = updated_task
        .line_number
        .checked_sub(1)
        .ok_or_else(|| "Line number out of bounds".to_string())?;
    if line_index >= lines.len() {
        return Err("Line number out of bounds".to_string());
    }

    let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    new_lines[line_index] =
        parser::format_task_line(updated_task, today, file_project, project_names);

    // Handle notes: find and replace existing notes below the task
    let task_indent = updated_task.indent_level;
    let notes_indent = task_indent + 4; // Notes are indented 4 spaces more than the task

    // Find the range of existing indented content (notes/checklist) below the task
    let mut end_of_content = line_index + 1;
    while end_of_content < new_lines.len() {
        let line = &new_lines[end_of_content];
        let trimmed = line.trim_start();
        let line_indent = line.len() - trimmed.len();

        // Stop if we hit a line that's not indented more than the task
        // (unless it's an empty line, which we skip)
        if trimmed.is_empty() {
            end_of_content += 1;
            continue;
        }

        // If this is a task line at same or less indent, stop
        if line_indent <= task_indent && trimmed.starts_with("- [") {
            break;
        }

        // If line is not indented enough, stop
        if line_indent <= task_indent && !trimmed.is_empty() {
            break;
        }

        // This is indented content (notes or checklist), continue
        end_of_content += 1;
    }

    // Remove trailing empty lines from the range
    while end_of_content > line_index + 1 && new_lines[end_of_content - 1].trim().is_empty() {
        end_of_content -= 1;
    }

    // Remove old notes/indented content (but keep checklist items - lines starting with "- [")
    let mut lines_to_remove: Vec<usize> = Vec::new();
    for i in (line_index + 1)..end_of_content {
        let trimmed = new_lines[i].trim_start();
        // Only remove non-checklist lines (notes)
        if !trimmed.starts_with("- [") {
            lines_to_remove.push(i);
        }
    }
    // Remove in reverse order to maintain indices
    for i in lines_to_remove.into_iter().rev() {
        new_lines.remove(i);
    }

    // Insert new notes if present
    if !updated_task.notes.is_empty() {
        let indent_str = " ".repeat(notes_indent);
        let note_lines: Vec<String> = updated_task
            .notes
            .lines()
            .map(|line| format!("{}{}", indent_str, line))
            .collect();

        // Find where to insert (right after the task line)
        let insert_pos = line_index + 1;
        for (i, note_line) in note_lines.into_iter().enumerate() {
            new_lines.insert(insert_pos + i, note_line);
        }
    }

    Ok(new_lines.join("\n"))
}

/// Locate the file line index of the `item_index`-th checklist item belonging to
/// the task at `task_line_number` (1-based). Shared by the toggle/rename/delete
/// checklist operations. Splits on `'\n'` (matching the original, which used
/// `split('\n')`, preserving a possible trailing empty line).
fn find_checklist_line(
    lines: &[String],
    task_line_number: usize,
    item_index: usize,
) -> Result<usize> {
    let task_line_index = task_line_number.saturating_sub(1);
    let task_indent = lines
        .get(task_line_index)
        .map(|l| l.len() - l.trim_start().len())
        .unwrap_or(0);

    let mut checklist_count = 0usize;
    for i in (task_line_index + 1)..lines.len() {
        let line = &lines[i];
        let trimmed = line.trim_start();
        let line_indent = line.len() - trimmed.len();

        // Stop if we hit a line at the same or lesser indent (and it's not blank)
        if line_indent <= task_indent && !trimmed.is_empty() {
            break;
        }

        if trimmed.starts_with("- [x] ") || trimmed.starts_with("- [ ] ") || trimmed.starts_with("- [X] ") {
            if checklist_count == item_index {
                return Ok(i);
            }
            checklist_count += 1;
        }
    }
    Err(format!("Could not find checklist item {} in file", item_index))
}

/// Toggle the `item_index`-th checklist item of the task at `task_line_number`.
/// Mirrors `Vault::toggle_checklist_item`'s string surgery.
pub fn toggle_checklist_item(
    contents: &str,
    task_line_number: usize,
    item_index: usize,
) -> Result<String> {
    let mut lines: Vec<String> = contents.split('\n').map(String::from).collect();
    let target = find_checklist_line(&lines, task_line_number, item_index)?;

    let line = &lines[target];
    let new_line = if line.contains("- [ ] ") {
        line.replacen("- [ ] ", "- [x] ", 1)
    } else {
        line.replacen("- [x] ", "- [ ] ", 1)
            .replacen("- [X] ", "- [ ] ", 1)
    };
    lines[target] = new_line;
    Ok(lines.join("\n"))
}

/// Rename the `item_index`-th checklist item of the task at `task_line_number`.
/// Mirrors `Vault::rename_checklist_item`'s string surgery.
pub fn rename_checklist_item(
    contents: &str,
    task_line_number: usize,
    item_index: usize,
    new_title: &str,
) -> Result<String> {
    let mut lines: Vec<String> = contents.split('\n').map(String::from).collect();
    let target = find_checklist_line(&lines, task_line_number, item_index)?;

    let line = &lines[target];
    let indent = &line[..line.len() - line.trim_start().len()];
    let prefix = if line.contains("- [ ] ") { "- [ ] " } else { "- [x] " };
    lines[target] = format!("{}{}{}", indent, prefix, new_title);
    Ok(lines.join("\n"))
}

/// Delete the `item_index`-th checklist item of the task at `task_line_number`.
/// Mirrors `Vault::delete_checklist_item`'s string surgery.
pub fn delete_checklist_item(
    contents: &str,
    task_line_number: usize,
    item_index: usize,
) -> Result<String> {
    let mut lines: Vec<String> = contents.split('\n').map(String::from).collect();
    let target = find_checklist_line(&lines, task_line_number, item_index)?;
    lines.remove(target);
    Ok(lines.join("\n"))
}

/// Delete the task at `task_line_number` (1-based) and all of its indented
/// content (notes + checklist). Mirrors `Vault::delete_task`'s string surgery.
pub fn delete_task(contents: &str, task_line_number: usize, task_indent: usize) -> Result<String> {
    let lines: Vec<&str> = contents.lines().collect();
    let line_index = task_line_number
        .checked_sub(1)
        .ok_or_else(|| "Line number out of bounds".to_string())?;
    if line_index >= lines.len() {
        return Err("Line number out of bounds".to_string());
    }

    let mut end_of_content = line_index + 1;
    while end_of_content < lines.len() {
        let line = lines[end_of_content];
        let trimmed = line.trim_start();
        let line_indent = line.len() - trimmed.len();

        // Empty lines - continue checking
        if trimmed.is_empty() {
            end_of_content += 1;
            continue;
        }

        // If this is a task line at same or less indent, stop
        if line_indent <= task_indent && trimmed.starts_with("- [") {
            break;
        }

        // If line is not indented more than the task, stop
        if line_indent <= task_indent {
            break;
        }

        // This is indented content (notes or checklist), include it
        end_of_content += 1;
    }

    // Remove trailing empty lines from the range
    while end_of_content > line_index + 1 && lines[end_of_content - 1].trim().is_empty() {
        end_of_content -= 1;
    }

    // Create new content without the task and its associated content
    let mut new_lines: Vec<&str> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i < line_index || i >= end_of_content {
            new_lines.push(line);
        }
    }
    Ok(new_lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{parse_file, WhenValue};

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 2, 14).unwrap()
    }

    #[test]
    fn moment_to_chrono_replaces_longest_first() {
        assert_eq!(moment_to_chrono("YYYY-MM-DD"), "%Y-%m-%d");
        assert_eq!(moment_to_chrono("YYYY/MM-MMMM/YYYY-MM-DD"), "%Y/%m-%B/%Y-%m-%d");
        assert_eq!(moment_to_chrono("dddd, MMMM D"), "%A, %B %d");
    }

    #[test]
    fn daily_note_path_renders() {
        assert_eq!(
            daily_note_date_path(today(), "YYYY/MM-MMMM/YYYY-MM-DD"),
            "2026/02-February/2026-02-14"
        );
    }

    #[test]
    fn update_task_rewrites_line_and_notes() {
        let contents = "- [ ] Old title @when(2026-02-14)\n    old note\n";
        let mut task = parse_file(contents, "test.md", today()).remove(0);
        task.title = "New title".into();
        task.notes = "new note line 1\nnew note line 2".into();
        let names = HashSet::new();
        let out = apply_task_update(contents, &task, today(), None, &names).unwrap();
        let expected = "- [ ] New title @when(2026-02-14)\n    new note line 1\n    new note line 2";
        assert_eq!(out, expected);
    }

    #[test]
    fn update_task_preserves_checklist_items() {
        let contents = "- [ ] Parent @when(anytime)\n    - [ ] sub a\n    - [x] sub b\n";
        let task = parse_file(contents, "test.md", today()).remove(0);
        assert_eq!(task.checklist.len(), 2);
        let names = HashSet::new();
        let out = apply_task_update(contents, &task, today(), None, &names).unwrap();
        assert!(out.contains("- [ ] sub a"));
        assert!(out.contains("- [x] sub b"));
    }

    #[test]
    fn toggle_checklist_flips_checkbox() {
        let contents = "- [ ] Parent\n    - [ ] first\n    - [ ] second\n";
        let out = toggle_checklist_item(contents, 1, 1).unwrap();
        assert_eq!(out, "- [ ] Parent\n    - [ ] first\n    - [x] second\n");
        // toggling back
        let back = toggle_checklist_item(&out, 1, 1).unwrap();
        assert_eq!(back, contents);
    }

    #[test]
    fn rename_checklist_keeps_indent_and_state() {
        let contents = "- [ ] Parent\n    - [x] done item\n";
        let out = rename_checklist_item(contents, 1, 0, "renamed item").unwrap();
        assert_eq!(out, "- [ ] Parent\n    - [x] renamed item\n");
    }

    #[test]
    fn delete_checklist_removes_line() {
        let contents = "- [ ] Parent\n    - [ ] a\n    - [ ] b\n";
        let out = delete_checklist_item(contents, 1, 0).unwrap();
        assert_eq!(out, "- [ ] Parent\n    - [ ] b\n");
    }

    #[test]
    fn delete_task_removes_task_and_indented_block() {
        let contents = "- [ ] keep me\n- [ ] delete me\n    a note\n    - [ ] sub\n- [ ] also keep\n";
        let out = delete_task(contents, 2, 0).unwrap();
        assert_eq!(out, "- [ ] keep me\n- [ ] also keep");
    }

    #[test]
    fn out_of_bounds_line_errors() {
        let names = HashSet::new();
        let mut task = Task {
            id: "x".into(),
            title: "t".into(),
            notes: String::new(),
            when: WhenValue::Inbox,
            deadline: None,
            tags: Vec::new(),
            checklist: Vec::new(),
            completed: false,
            completed_date: None,
            created_date: None,
            file_path: "f.md".into(),
            line_number: 99,
            projects: Vec::new(),
            indent_level: 0,
            priority: None,
            persons: Vec::new(),
            recurring_template_id: None,
            duration_minutes: None,
            scheduled_time: None,
        };
        task.line_number = 99;
        assert!(apply_task_update("- [ ] only line", &task, today(), None, &names).is_err());
        assert!(delete_task("- [ ] only line", 99, 0).is_err());
    }
}
