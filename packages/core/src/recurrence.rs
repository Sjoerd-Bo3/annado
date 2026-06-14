//! Pure recurrence date math for recurring-task templates.
//!
//! Ported from `Vault::calculate_next_date` / `Vault::should_generate_instance`
//! in `src-tauri/src/vault.rs`. These methods never touched `self`, so they
//! become free functions here; the Tauri/Obsidian host still owns reading the
//! template files and writing the generated instances.

use crate::parser::{IntervalUnit, RecurrenceType, RecurringTemplate};
use chrono::{Months, NaiveDate};

/// Calculate the next date based on interval and unit.
pub fn calculate_next_date(from_date: NaiveDate, interval: u32, unit: &IntervalUnit) -> NaiveDate {
    match unit {
        IntervalUnit::Days => from_date + chrono::Duration::days(interval as i64),
        IntervalUnit::Weeks => from_date + chrono::Duration::weeks(interval as i64),
        IntervalUnit::Months => from_date
            .checked_add_months(Months::new(interval))
            .unwrap_or(from_date),
        IntervalUnit::Years => from_date
            .checked_add_months(Months::new(interval * 12))
            .unwrap_or(from_date),
    }
}

/// Whether a new instance of `template` should be generated as of `today`.
pub fn should_generate_instance(template: &RecurringTemplate, today: NaiveDate) -> bool {
    // For first generation (never generated before), always create the instance immediately
    // The instance will use start_date as its when date (handled in generate_recurring_instances)
    // so it appears in Upcoming view if start_date is in the future
    if template.last_generated.is_none() {
        return true;
    }

    // For subsequent generations, follow normal recurrence logic
    // (start_date only affects the first instance, not subsequent ones)
    match template.recurrence_type {
        RecurrenceType::Fixed => {
            // Generate if enough time has passed since last generation
            if let Some(ref last_gen) = template.last_generated {
                if let Ok(last_date) = NaiveDate::parse_from_str(last_gen, "%Y-%m-%d") {
                    let next_date =
                        calculate_next_date(last_date, template.interval, &template.interval_unit);
                    today >= next_date
                } else {
                    true
                }
            } else {
                true // Should not reach here due to early return above
            }
        }
        RecurrenceType::AfterCompletion => {
            // Only generate if the previous instance was completed
            match &template.last_completed {
                None => {
                    // If never completed, don't generate another instance
                    false
                }
                Some(last_comp) => {
                    if let Ok(last_date) = NaiveDate::parse_from_str(last_comp, "%Y-%m-%d") {
                        let next_date = calculate_next_date(
                            last_date,
                            template.interval,
                            &template.interval_unit,
                        );
                        today >= next_date
                    } else {
                        false
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn next_date_days_weeks() {
        assert_eq!(calculate_next_date(date(2026, 1, 1), 3, &IntervalUnit::Days), date(2026, 1, 4));
        assert_eq!(
            calculate_next_date(date(2026, 1, 1), 2, &IntervalUnit::Weeks),
            date(2026, 1, 15)
        );
    }

    #[test]
    fn next_date_months_years() {
        assert_eq!(
            calculate_next_date(date(2026, 1, 31), 1, &IntervalUnit::Months),
            date(2026, 2, 28)
        );
        assert_eq!(
            calculate_next_date(date(2024, 2, 29), 1, &IntervalUnit::Years),
            date(2025, 2, 28)
        );
    }

    fn template(rt: RecurrenceType) -> RecurringTemplate {
        RecurringTemplate {
            template_id: "t1".into(),
            title: "Test".into(),
            notes: String::new(),
            recurrence_type: rt,
            interval: 1,
            interval_unit: IntervalUnit::Days,
            start_date: None,
            last_generated: None,
            last_completed: None,
            file_path: "x.md".into(),
            projects: Vec::new(),
            priority: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn first_generation_always_runs() {
        let t = template(RecurrenceType::Fixed);
        assert!(should_generate_instance(&t, date(2026, 1, 1)));
    }

    #[test]
    fn fixed_waits_for_interval() {
        let mut t = template(RecurrenceType::Fixed);
        t.last_generated = Some("2026-01-01".into());
        assert!(!should_generate_instance(&t, date(2026, 1, 1)));
        assert!(should_generate_instance(&t, date(2026, 1, 2)));
    }

    #[test]
    fn after_completion_requires_completion() {
        let mut t = template(RecurrenceType::AfterCompletion);
        t.last_generated = Some("2026-01-01".into());
        // Never completed: must not generate again.
        assert!(!should_generate_instance(&t, date(2026, 2, 1)));
        t.last_completed = Some("2026-01-05".into());
        assert!(should_generate_instance(&t, date(2026, 1, 6)));
        assert!(!should_generate_instance(&t, date(2026, 1, 5)));
    }
}
