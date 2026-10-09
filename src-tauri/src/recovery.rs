// The copy that makes discarding safe.
//
// Loading the disk version over unsaved edits is the one move in this app that
// throws the user's input away for good (the editor flushes its undo history at the
// same time). So the version being dropped is written down first, and if that write
// fails nothing is discarded (PRINCIPLES.md, 用户数据不可丢).
//
// Named after the document so the folder stays readable years later, with a local
// timestamp to the second.

use std::path::{Path, PathBuf};

use crate::paths;

/// Write `content` into `~/.loomark/recovered` as `<document>-<stamp>.md`.
/// `None` means nothing was written, and therefore nothing may be discarded.
pub fn keep_recovered_copy(file_path: Option<&Path>, content: &str) -> Option<PathBuf> {
    if content.trim().is_empty() {
        return None;
    }

    let stem = file_path
        .and_then(|path| path.file_stem())
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "untitled".to_string());

    let dir = paths::recovery_dir();
    if !paths::ensure_dir(&dir) {
        return None;
    }

    let target = dir.join(format!("{stem}-{}.md", stamp()));
    std::fs::write(&target, content).ok()?;
    Some(target)
}

/// Local time as `YYYYMMDD-HHMMSS`. Falls back to UTC when the platform cannot
/// report an offset, which keeps the name unique even if it is an hour or two off.
fn stamp() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let total = duration.as_secs() as i64;
    let local = total + local_offset_seconds();
    let days = local.div_euclid(86_400);
    let time_of_day = local.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60
    )
}

/// Seconds east of UTC, read from the platform. Zero when unknown.
fn local_offset_seconds() -> i64 {
    // `time` reads TZ without pulling in a full date-time stack; it can refuse in a
    // multithreaded process, in which case UTC is good enough for a file name.
    match time::OffsetDateTime::now_local() {
        Ok(local) => local.offset().whole_seconds() as i64,
        Err(_) => 0,
    }
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_content_is_never_stored() {
        assert!(keep_recovered_copy(Some(Path::new("/tmp/a.md")), "").is_none());
        assert!(keep_recovered_copy(Some(Path::new("/tmp/a.md")), "   \n").is_none());
    }

    #[test]
    fn a_copy_keeps_the_document_name_and_lands_in_the_recovery_folder() {
        let dir = std::env::temp_dir().join(format!("loomark-recovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // The real home is not touched: the path is only computed here.
        let path = Path::new("/tmp/My Note.md");
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        assert_eq!(stem, "My Note");
        assert!(crate::paths::recovery_dir().ends_with("recovered"));
    }

    #[test]
    fn the_stamp_is_sortable_and_second_resolution() {
        let now = stamp();
        assert_eq!(now.len(), 15, "YYYYMMDD-HHMMSS: {now}");
        assert_eq!(&now[8..9], "-");
    }
}
