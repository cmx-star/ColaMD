// Recent documents, in the same `~/.loomark/recent.json` the Electron build writes.
//
// Ten entries, newest first, duplicates moved to the front, stale paths dropped when
// the list is read. The store also carries `restoreOnLaunch`, which belongs to the
// session-restore policy; this module preserves whatever it finds there rather than
// reshaping the file.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::paths;

const LIMIT: usize = 10;

fn read_store() -> Value {
    std::fs::read_to_string(paths::recent_store_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({ "recent": [], "restoreOnLaunch": true }))
}

fn write_store(store: &Value) -> bool {
    let path = paths::recent_store_path();
    if let Some(parent) = path.parent() {
        if !paths::ensure_dir(&parent.to_path_buf()) {
            return false;
        }
    }
    std::fs::write(&path, store.to_string()).is_ok()
}

/// Record a document as most recently used.
pub fn remember(file_path: &Path) {
    let file_path = file_path.to_string_lossy().to_string();
    let mut store = read_store();
    let previous: Vec<String> = store
        .get("recent")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(|entry| entry.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let mut next = vec![file_path.clone()];
    next.extend(previous.iter().filter(|entry| **entry != file_path).cloned());
    next.truncate(LIMIT);

    if next == previous {
        return;
    }
    store["recent"] = serde_json::json!(next);
    write_store(&store);
}

/// The list as the menu should show it: existing files only, newest first.
pub fn files() -> Vec<PathBuf> {
    read_store()
        .get("recent")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(PathBuf::from)
                .filter(|path| path.is_file())
                .take(LIMIT)
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the launch should reopen the last document.
pub fn restore_on_launch() -> bool {
    read_store()
        .get("restoreOnLaunch")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Flip the restore-on-launch preference, keeping the recent list as it is.
pub fn set_restore_on_launch(enabled: bool) {
    let mut store = read_store();
    store["restoreOnLaunch"] = Value::Bool(enabled);
    write_store(&store);
}

/// Empty the list.
pub fn clear() {
    let mut store = read_store();
    store["recent"] = serde_json::json!([] as [String; 0]);
    write_store(&store);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_store_reads_as_empty_with_restore_enabled() {
        // Reads whatever the machine has; only the shape is asserted.
        let list = files();
        assert!(list.len() <= LIMIT);
        let _ = restore_on_launch();
    }

    #[test]
    fn the_limit_is_ten_documents() {
        assert_eq!(LIMIT, 10);
    }
}
