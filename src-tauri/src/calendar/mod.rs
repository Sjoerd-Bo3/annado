use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod eventkit;
pub mod ics;

pub use ics::IcsSubscription;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub account_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub calendar_name: String,
    pub calendar_color: String,
    pub start_date: String,
    pub end_date: String,
    pub is_all_day: bool,
    pub location: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
    /// True for events from read-only sources (ICS subscriptions)
    #[serde(default)]
    pub read_only: bool,
}

/// Whether this platform has a native system calendar integration
/// (EventKit on macOS). ICS subscriptions work on every platform.
pub fn system_calendar_supported() -> bool {
    cfg!(target_os = "macos")
}

/// All calendars: system calendars (macOS) plus ICS subscriptions.
/// A system-calendar error (e.g. permission denied) only propagates when
/// there are no subscriptions to show instead.
pub fn fetch_calendars(subs: &[IcsSubscription]) -> Result<Vec<CalendarInfo>, String> {
    let mut calendars = Vec::new();
    let mut system_error: Option<String> = None;

    #[cfg(target_os = "macos")]
    match eventkit::fetch_calendars() {
        Ok(cals) => calendars.extend(cals),
        Err(e) => system_error = Some(e),
    }

    calendars.extend(ics::subscription_calendars(subs));

    match system_error {
        Some(e) if calendars.is_empty() => Err(e),
        _ => Ok(calendars),
    }
}

/// Events in [start_date, end_date] (ISO 8601) from every enabled source.
pub fn fetch_events(
    calendar_names: Vec<String>,
    start_date: String,
    end_date: String,
    subs: &[IcsSubscription],
) -> Result<Vec<CalendarEvent>, String> {
    let window_start: DateTime<Utc> = start_date
        .parse()
        .map_err(|e| format!("Invalid start date: {}", e))?;
    let window_end: DateTime<Utc> = end_date
        .parse()
        .map_err(|e| format!("Invalid end date: {}", e))?;

    let mut events = Vec::new();
    let mut errors = Vec::new();

    let selected_subs: Vec<&IcsSubscription> = subs
        .iter()
        .filter(|s| calendar_names.contains(&s.name))
        .collect();

    #[cfg(target_os = "macos")]
    {
        let system_names: Vec<String> = calendar_names
            .iter()
            .filter(|n| !selected_subs.iter().any(|s| &&s.name == n))
            .cloned()
            .collect();
        if !system_names.is_empty() {
            match eventkit::fetch_events(system_names, start_date.clone(), end_date.clone()) {
                Ok(evts) => events.extend(evts),
                Err(e) => errors.push(e),
            }
        }
    }

    for sub in selected_subs {
        match ics::fetch_subscription_events(sub, window_start, window_end) {
            Ok(evts) => events.extend(evts),
            Err(e) => errors.push(format!("{}: {}", sub.name, e)),
        }
    }

    if events.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(events)
}

pub fn check_calendar_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return eventkit::check_calendar_permission();
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "System calendar integration is not available on this platform";

pub fn open_calendar_at_date(date: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return eventkit::open_calendar_at_date(date);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = date;
        Err(UNSUPPORTED.to_string())
    }
}

pub fn delete_event(event_id: String) -> Result<(), String> {
    if event_id.starts_with("ics:") {
        return Err("Subscribed calendars are read-only".to_string());
    }
    #[cfg(target_os = "macos")]
    return eventkit::delete_event(event_id);
    #[cfg(not(target_os = "macos"))]
    Err(UNSUPPORTED.to_string())
}
