// Telling the renderer that the file on disk changed under it.
//
// Used by the autosave path, which refuses to overwrite an edit that landed after
// our last read or write: it hands the renderer the disk version so the existing
// external-change flow can ask the user which side to keep.

use std::path::Path;

use tauri::{Emitter, WebviewWindow};

use crate::fileio;

pub fn notify_external_change(window: &WebviewWindow, path: &Path) {
    if let Ok(data) = fileio::read_document(path) {
        let _ = window.emit("file-changed", data.content);
    }
    // A read failure is not reported: the watcher picks the change up on its next
    // event, and a file mid-replace is the common case.
}
