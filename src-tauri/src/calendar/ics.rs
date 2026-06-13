//! ICS calendar subscriptions: a cross-platform, read-only calendar source.
//!
//! Fetches `.ics` feeds (Google "secret address", Outlook published calendars,
//! iCloud public calendars, …), expands recurrences, and maps occurrences to
//! the same `CalendarEvent` shape the EventKit integration produces.

use super::{CalendarEvent, CalendarInfo};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IcsSubscription {
    pub id: String,
    pub name: String,
    pub url: String,
    pub color: String,
}

pub fn subscription_calendars(subs: &[IcsSubscription]) -> Vec<CalendarInfo> {
    subs.iter()
        .map(|s| CalendarInfo {
            id: format!("ics:{}", s.id),
            name: s.name.clone(),
            color: s.color.clone(),
            account_name: "Subscription".to_string(),
        })
        .collect()
}

pub fn fetch_subscription_events(
    sub: &IcsSubscription,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Result<Vec<CalendarEvent>, String> {
    let body = fetch_with_cache(sub)?;
    Ok(events_in_window(&body, sub, window_start, window_end))
}

// ── Fetching & caching ────────────────────────────────────────────────────────

const CACHE_TTL_SECS: u64 = 240; // frontend refreshes every 5 min; refetch just under that
const MAX_FEED_BYTES: u64 = 10 * 1024 * 1024;

static FEED_CACHE: Lazy<Mutex<HashMap<String, (Instant, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn fetch_with_cache(sub: &IcsSubscription) -> Result<String, String> {
    if let Some((at, body)) = FEED_CACHE.lock().get(&sub.id) {
        if at.elapsed().as_secs() < CACHE_TTL_SECS {
            return Ok(body.clone());
        }
    }

    match fetch_feed(&sub.url) {
        Ok(body) => {
            FEED_CACHE.lock().insert(sub.id.clone(), (Instant::now(), body.clone()));
            Ok(body)
        }
        // Serve the last good copy when the network is down
        Err(e) => match FEED_CACHE.lock().get(&sub.id) {
            Some((_, body)) => Ok(body.clone()),
            None => Err(e),
        },
    }
}

fn fetch_feed(url: &str) -> Result<String, String> {
    // Apple publishes subscription links as webcal:// — same thing over https
    let url = url
        .strip_prefix("webcal://")
        .map(|rest| format!("https://{}", rest))
        .unwrap_or_else(|| url.to_string());

    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Subscription URL must start with https://, http:// or webcal://".to_string());
    }

    let mut response = ureq::get(&url)
        .call()
        .map_err(|e| format!("Failed to fetch calendar feed: {}", e))?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_FEED_BYTES)
        .read_to_string()
        .map_err(|e| format!("Failed to read calendar feed: {}", e))
}

/// Drop a subscription's cached feed (used when it is removed or edited).
pub fn invalidate_cache(sub_id: &str) {
    FEED_CACHE.lock().remove(sub_id);
}

// ── Minimal ICS parsing ───────────────────────────────────────────────────────
// ICS is line-oriented (RFC 5545): NAME;PARAM=VALUE;…:value with long lines
// "folded" by a CRLF + leading whitespace. The rrule crate consumes raw
// DTSTART/RRULE/EXDATE lines, so we keep properties close to their raw form.

#[derive(Debug, Clone)]
struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Default, Clone)]
struct RawEvent {
    props: Vec<Prop>,
}

impl RawEvent {
    fn get(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.name.eq_ignore_ascii_case(name))
    }
    fn get_all(&self, name: &str) -> impl Iterator<Item = &Prop> {
        let name = name.to_ascii_uppercase();
        self.props.iter().filter(move |p| p.name == name)
    }
    fn value(&self, name: &str) -> Option<&str> {
        self.get(name).map(|p| p.value.as_str())
    }
}

fn unfold_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(continuation) = raw.strip_prefix(' ').or_else(|| raw.strip_prefix('\t')) {
            if let Some(last) = lines.last_mut() {
                last.push_str(continuation);
                continue;
            }
        }
        lines.push(raw.to_string());
    }
    lines
}

fn parse_prop(line: &str) -> Option<Prop> {
    // Find the first ':' that is not inside a double-quoted parameter value
    let mut in_quotes = false;
    let mut colon = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);

    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((k.trim().to_ascii_uppercase(), v.trim_matches('"').to_string()))
        })
        .collect();

    Some(Prop { name, params, value: value.to_string() })
}

fn parse_events(text: &str) -> Vec<RawEvent> {
    let mut events = Vec::new();
    let mut current: Option<RawEvent> = None;
    for line in unfold_lines(text) {
        let upper = line.to_ascii_uppercase();
        if upper == "BEGIN:VEVENT" {
            current = Some(RawEvent::default());
        } else if upper == "END:VEVENT" {
            if let Some(ev) = current.take() {
                events.push(ev);
            }
        } else if let Some(ev) = current.as_mut() {
            if let Some(prop) = parse_prop(&line) {
                ev.props.push(prop);
            }
        }
    }
    events
}

/// Unescape RFC 5545 TEXT values (\n, \, \; \\)
fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ── Date/time handling ────────────────────────────────────────────────────────

/// Common Microsoft/Exchange time zone names → IANA. Google and iCloud feeds
/// use IANA names directly; Outlook feeds use these.
const WINDOWS_TZ_MAP: &[(&str, &str)] = &[
    ("UTC", "UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("Romance Standard Time", "Europe/Paris"),
    ("FLE Standard Time", "Europe/Kyiv"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("Eastern Standard Time", "America/New_York"),
    ("US Eastern Standard Time", "America/Indiana/Indianapolis"),
    ("Central Standard Time", "America/Chicago"),
    ("Mountain Standard Time", "America/Denver"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
];

fn resolve_tzid(tzid: &str) -> Option<chrono_tz::Tz> {
    let tzid = tzid.trim_matches('"');
    if let Ok(tz) = tzid.parse::<chrono_tz::Tz>() {
        return Some(tz);
    }
    if let Some((_, iana)) = WINDOWS_TZ_MAP.iter().find(|(win, _)| win.eq_ignore_ascii_case(tzid)) {
        return iana.parse().ok();
    }
    // Some clients prefix TZIDs with a path, e.g. "/mozilla.org/20070129_1/Europe/Amsterdam"
    if let Some(idx) = tzid.rfind('/') {
        let (head, _) = tzid.split_at(idx);
        if let Some(idx2) = head.rfind('/') {
            if let Ok(tz) = tzid[idx2 + 1..].parse::<chrono_tz::Tz>() {
                return Some(tz);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum IcsTime {
    /// A date-only value (all-day events)
    Date(NaiveDate),
    /// An exact moment, normalized to UTC
    Moment(DateTime<Utc>),
}

fn parse_ics_datetime(prop: &Prop) -> Option<IcsTime> {
    let value = prop.value.trim();
    if prop.param("VALUE") == Some("DATE") || (value.len() == 8 && !value.contains('T')) {
        return NaiveDate::parse_from_str(value, "%Y%m%d").ok().map(IcsTime::Date);
    }

    if let Some(utc_part) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(utc_part, "%Y%m%dT%H%M%S").ok()?;
        return Some(IcsTime::Moment(Utc.from_utc_datetime(&naive)));
    }

    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
    if let Some(tz) = prop.param("TZID").and_then(resolve_tzid) {
        let local = tz.from_local_datetime(&naive).earliest()?;
        return Some(IcsTime::Moment(local.with_timezone(&Utc)));
    }
    // Floating time (no TZID): interpret in the device's local time zone
    let local = chrono::Local.from_local_datetime(&naive).earliest()?;
    Some(IcsTime::Moment(local.with_timezone(&Utc)))
}

/// Parse an ISO-8601 duration like "PT1H30M" / "P1D" (subset used by DURATION)
fn parse_ics_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let s = s.strip_prefix('P')?;
    let mut secs: i64 = 0;
    let mut num = String::new();
    let mut in_time = false;
    for c in s.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                secs += n * match c {
                    'W' => 7 * 86_400,
                    'D' => 86_400,
                    'H' => 3_600,
                    'M' if in_time => 60,
                    'S' => 1,
                    _ => return None, // 'M' outside T-part would be months: unsupported
                };
            }
            _ => return None,
        }
    }
    Some(if neg { -Duration::seconds(secs) } else { Duration::seconds(secs) })
}

// ── Occurrence expansion ──────────────────────────────────────────────────────

const MAX_OCCURRENCES: u16 = 1000;

fn expand_recurrences(
    ev: &RawEvent,
    dtstart: &Prop,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Option<Vec<IcsTime>> {
    let rrule_prop = ev.get("RRULE")?;

    // Reassemble the raw lines the rrule crate expects. Non-IANA TZIDs are
    // rewritten to a mapped IANA zone so recurrence math stays DST-correct.
    let mut dtstart_line = String::from("DTSTART");
    let is_date = dtstart.param("VALUE") == Some("DATE")
        || (dtstart.value.len() == 8 && !dtstart.value.contains('T'));
    if is_date {
        dtstart_line.push_str(";VALUE=DATE");
    } else if let Some(tzid) = dtstart.param("TZID") {
        let tz = resolve_tzid(tzid)?;
        dtstart_line.push_str(&format!(";TZID={}", tz.name()));
    }
    dtstart_line.push(':');
    dtstart_line.push_str(dtstart.value.trim());

    let mut set_str = format!("{}\nRRULE:{}", dtstart_line, rrule_prop.value.trim());
    for name in ["EXDATE", "RDATE"] {
        for prop in ev.get_all(name) {
            let mut line = name.to_string();
            if let Some(tzid) = prop.param("TZID") {
                let tz = resolve_tzid(tzid)?;
                line.push_str(&format!(";TZID={}", tz.name()));
            } else if let Some(value) = prop.param("VALUE") {
                line.push_str(&format!(";VALUE={}", value));
            }
            line.push(':');
            line.push_str(prop.value.trim());
            set_str.push('\n');
            set_str.push_str(&line);
        }
    }

    let set: rrule::RRuleSet = set_str.parse().ok()?;
    let result = set
        .after(window_start.with_timezone(&rrule::Tz::UTC))
        .before(window_end.with_timezone(&rrule::Tz::UTC))
        .all(MAX_OCCURRENCES);

    Some(
        result
            .dates
            .into_iter()
            .map(|d| {
                if is_date {
                    IcsTime::Date(d.date_naive())
                } else {
                    IcsTime::Moment(d.with_timezone(&Utc))
                }
            })
            .collect(),
    )
}

fn format_time(t: IcsTime) -> String {
    match t {
        IcsTime::Date(d) => d.format("%Y-%m-%d").to_string(),
        IcsTime::Moment(m) => m.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    }
}

fn add_duration(t: IcsTime, d: Duration) -> IcsTime {
    match t {
        IcsTime::Date(date) => IcsTime::Date(date + Duration::days(d.num_days().max(0))),
        IcsTime::Moment(m) => IcsTime::Moment(m + d),
    }
}

fn event_duration(ev: &RawEvent, start: IcsTime) -> Duration {
    if let Some(end_prop) = ev.get("DTEND") {
        if let (Some(end), IcsTime::Moment(s)) = (parse_ics_datetime(end_prop), start) {
            if let IcsTime::Moment(e) = end {
                return e - s;
            }
        }
        if let (Some(IcsTime::Date(e)), IcsTime::Date(s)) = (parse_ics_datetime(end_prop), start) {
            return Duration::days((e - s).num_days());
        }
    }
    if let Some(d) = ev.value("DURATION").and_then(parse_ics_duration) {
        return d;
    }
    match start {
        // An all-day DTSTART without DTEND covers exactly that day (exclusive end)
        IcsTime::Date(_) => Duration::days(1),
        IcsTime::Moment(_) => Duration::zero(),
    }
}

fn in_window(start: IcsTime, end: IcsTime, ws: DateTime<Utc>, we: DateTime<Utc>) -> bool {
    let (s, e) = match (start, end) {
        (IcsTime::Moment(s), IcsTime::Moment(e)) => (s, e.max(s)),
        (IcsTime::Date(s), IcsTime::Date(e)) => {
            let s = Utc.from_utc_datetime(&s.and_hms_opt(0, 0, 0).unwrap());
            let e = Utc.from_utc_datetime(&e.and_hms_opt(0, 0, 0).unwrap());
            (s, e.max(s + Duration::days(1)))
        }
        _ => return false,
    };
    s < we && e > ws
}

fn events_in_window(
    ics_text: &str,
    sub: &IcsSubscription,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Vec<CalendarEvent> {
    let raw_events = parse_events(ics_text);

    // RECURRENCE-ID events override single instances of their series; index
    // them so the master expansion can skip the original occurrence.
    let mut overridden: HashMap<(String, String), ()> = HashMap::new();
    for ev in &raw_events {
        if let (Some(uid), Some(rid)) = (ev.value("UID"), ev.get("RECURRENCE-ID")) {
            if let Some(t) = parse_ics_datetime(rid) {
                overridden.insert((uid.to_string(), format_time(t)), ());
            }
        }
    }

    let mut out = Vec::new();
    for ev in &raw_events {
        if ev.value("STATUS").is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED")) {
            continue;
        }
        let Some(dtstart) = ev.get("DTSTART") else { continue };
        let Some(start) = parse_ics_datetime(dtstart) else { continue };
        let uid = ev.value("UID").unwrap_or("no-uid").to_string();
        let duration = event_duration(ev, start);
        let is_override = ev.get("RECURRENCE-ID").is_some();

        let occurrence_starts: Vec<IcsTime> = if is_override {
            vec![start]
        } else if let Some(occurrences) =
            expand_recurrences(ev, dtstart, window_start, window_end)
        {
            occurrences
                .into_iter()
                .filter(|t| !overridden.contains_key(&(uid.clone(), format_time(*t))))
                .collect()
        } else {
            vec![start]
        };

        for occ_start in occurrence_starts {
            let occ_end = add_duration(occ_start, duration);
            if !in_window(occ_start, occ_end, window_start, window_end) {
                continue;
            }
            out.push(CalendarEvent {
                id: format!("ics:{}:{}:{}", sub.id, uid, format_time(occ_start)),
                title: ev.value("SUMMARY").map(unescape_text).unwrap_or_else(|| "Untitled".into()),
                calendar_name: sub.name.clone(),
                calendar_color: sub.color.clone(),
                start_date: format_time(occ_start),
                end_date: format_time(occ_end),
                is_all_day: matches!(occ_start, IcsTime::Date(_)),
                location: ev.value("LOCATION").map(unescape_text).filter(|s| !s.is_empty()),
                url: ev.value("URL").map(str::to_string).filter(|s| !s.is_empty()),
                notes: ev.value("DESCRIPTION").map(unescape_text).filter(|s| !s.is_empty()),
                read_only: true,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(start: &str, end: &str) -> (DateTime<Utc>, DateTime<Utc>) {
        (
            start.parse().expect("valid window start"),
            end.parse().expect("valid window end"),
        )
    }

    fn sub() -> IcsSubscription {
        IcsSubscription {
            id: "test".into(),
            name: "Team".into(),
            url: "https://example.com/cal.ics".into(),
            color: "#5C6BC0".into(),
        }
    }

    #[test]
    fn parses_simple_utc_event() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Standup\r\nDTSTART:20260615T090000Z\r\nDTEND:20260615T093000Z\r\nLOCATION:Room 1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        let events = events_in_window(ics, &sub(), ws, we);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Standup");
        assert_eq!(events[0].start_date, "2026-06-15T09:00:00Z");
        assert_eq!(events[0].end_date, "2026-06-15T09:30:00Z");
        assert_eq!(events[0].location.as_deref(), Some("Room 1"));
        assert!(!events[0].is_all_day);
        assert!(events[0].read_only);
    }

    #[test]
    fn respects_window_bounds() {
        let ics = "BEGIN:VEVENT\nUID:1\nSUMMARY:Old\nDTSTART:20200101T090000Z\nDTEND:20200101T100000Z\nEND:VEVENT";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        assert!(events_in_window(ics, &sub(), ws, we).is_empty());
    }

    #[test]
    fn parses_all_day_event_with_exclusive_end() {
        let ics = "BEGIN:VEVENT\nUID:2\nSUMMARY:Conference\nDTSTART;VALUE=DATE:20260616\nDTEND;VALUE=DATE:20260618\nEND:VEVENT";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        let events = events_in_window(ics, &sub(), ws, we);
        assert_eq!(events.len(), 1);
        assert!(events[0].is_all_day);
        assert_eq!(events[0].start_date, "2026-06-16");
        assert_eq!(events[0].end_date, "2026-06-18");
    }

    #[test]
    fn all_day_without_dtend_spans_one_day() {
        let ics = "BEGIN:VEVENT\nUID:3\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20260616\nEND:VEVENT";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        let events = events_in_window(ics, &sub(), ws, we);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].end_date, "2026-06-17");
    }

    #[test]
    fn converts_tzid_to_utc() {
        let ics = "BEGIN:VEVENT\nUID:4\nSUMMARY:Lunch\nDTSTART;TZID=Europe/Amsterdam:20260615T120000\nDTEND;TZID=Europe/Amsterdam:20260615T130000\nEND:VEVENT";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        let events = events_in_window(ics, &sub(), ws, we);
        // June = CEST = UTC+2
        assert_eq!(events[0].start_date, "2026-06-15T10:00:00Z");
    }

    #[test]
    fn maps_windows_timezone_names() {
        let ics = "BEGIN:VEVENT\nUID:5\nSUMMARY:Outlook mtg\nDTSTART;TZID=W. Europe Standard Time:20260615T140000\nDTEND;TZID=W. Europe Standard Time:20260615T150000\nEND:VEVENT";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        let events = events_in_window(ics, &sub(), ws, we);
        assert_eq!(events[0].start_date, "2026-06-15T12:00:00Z");
    }

    #[test]
    fn expands_weekly_rrule_with_exdate() {
        // Weekly Monday standup, June 15 skipped via EXDATE
        let ics = "BEGIN:VEVENT\nUID:6\nSUMMARY:Weekly\nDTSTART:20260601T090000Z\nDTEND:20260601T100000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO\nEXDATE:20260615T090000Z\nEND:VEVENT";
        let (ws, we) = window("2026-06-07T00:00:00Z", "2026-06-28T00:00:00Z");
        let events = events_in_window(ics, &sub(), ws, we);
        let starts: Vec<&str> = events.iter().map(|e| e.start_date.as_str()).collect();
        assert_eq!(
            starts,
            vec!["2026-06-08T09:00:00Z", "2026-06-22T09:00:00Z"],
            "June 15 must be excluded"
        );
    }

    #[test]
    fn recurrence_id_overrides_instance() {
        // The June 8 instance is moved to 14:00 via a RECURRENCE-ID event
        let ics = "BEGIN:VEVENT\nUID:7\nSUMMARY:Weekly\nDTSTART:20260601T090000Z\nDTEND:20260601T100000Z\nRRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT\nBEGIN:VEVENT\nUID:7\nSUMMARY:Weekly (moved)\nRECURRENCE-ID:20260608T090000Z\nDTSTART:20260608T140000Z\nDTEND:20260608T150000Z\nEND:VEVENT";
        let (ws, we) = window("2026-06-01T00:00:00Z", "2026-06-30T00:00:00Z");
        let mut starts: Vec<String> = events_in_window(ics, &sub(), ws, we)
            .iter()
            .map(|e| e.start_date.clone())
            .collect();
        starts.sort();
        assert_eq!(
            starts,
            vec![
                "2026-06-01T09:00:00Z",
                "2026-06-08T14:00:00Z",
                "2026-06-15T09:00:00Z"
            ]
        );
    }

    #[test]
    fn skips_cancelled_events() {
        let ics = "BEGIN:VEVENT\nUID:8\nSUMMARY:Cancelled\nSTATUS:CANCELLED\nDTSTART:20260615T090000Z\nEND:VEVENT";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        assert!(events_in_window(ics, &sub(), ws, we).is_empty());
    }

    #[test]
    fn unfolds_long_lines_and_unescapes_text() {
        let ics = "BEGIN:VEVENT\r\nUID:9\r\nSUMMARY:Planning\\, Q3\r\n  session\r\nDTSTART:20260615T090000Z\r\nEND:VEVENT";
        let (ws, we) = window("2026-06-14T00:00:00Z", "2026-06-20T00:00:00Z");
        let events = events_in_window(ics, &sub(), ws, we);
        assert_eq!(events[0].title, "Planning, Q3 session");
    }

    #[test]
    fn parses_duration_property() {
        assert_eq!(parse_ics_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_ics_duration("P1D"), Some(Duration::days(1)));
        assert_eq!(parse_ics_duration("P2W"), Some(Duration::weeks(2)));
    }

    #[test]
    fn handles_colon_in_quoted_param() {
        let prop = parse_prop("ORGANIZER;CN=\"X: Y\":mailto:a@b.c").expect("parses");
        assert_eq!(prop.name, "ORGANIZER");
        assert_eq!(prop.value, "mailto:a@b.c");
    }
}
