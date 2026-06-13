use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod eventkit;

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
}

/// Whether this platform has a native system calendar integration
/// (EventKit on macOS). The frontend hides calendar settings when false.
pub fn system_calendar_supported() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "System calendar integration is not available on this platform";

pub fn fetch_calendars() -> Result<Vec<CalendarInfo>, String> {
    #[cfg(target_os = "macos")]
    return eventkit::fetch_calendars();
    #[cfg(not(target_os = "macos"))]
    Err(UNSUPPORTED.to_string())
}

pub fn fetch_events(
    calendar_names: Vec<String>,
    start_date: String,
    end_date: String,
) -> Result<Vec<CalendarEvent>, String> {
    #[cfg(target_os = "macos")]
    return eventkit::fetch_events(calendar_names, start_date, end_date);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (calendar_names, start_date, end_date);
        Err(UNSUPPORTED.to_string())
    }
}

pub fn check_calendar_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return eventkit::check_calendar_permission();
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

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
    #[cfg(target_os = "macos")]
    return eventkit::delete_event(event_id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event_id;
        Err(UNSUPPORTED.to_string())
    }
}
