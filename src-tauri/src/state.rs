// Per-window document state.
//
// The Electron build keeps one WindowState per BrowserWindow (src/main/index.ts);
// this is the same idea keyed by the window label, so multi-window (P3) needs no
// reshape. Everything that answers "which document is this window editing, and has
// it changed on disk since we last touched it" lives here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::fileio;

#[derive(Default)]
pub struct Doc {
    /// The file this window is editing. `None` means untitled, which must clear
    /// the binding: otherwise a save of an untitled document lands in whatever
    /// file the window opened last.
    pub file_path: Option<PathBuf>,
    /// Where the file panel is browsing. Follows the document unless the user
    /// walked the panel somewhere else.
    pub browse_path: Option<PathBuf>,
    /// The bytes our last write put on disk, used to recognise our own echo
    /// through the watcher.
    pub last_internal_save_content: Option<String>,
    /// mtime of the version we last read or wrote.
    pub last_known_mtime: u64,
    /// Number of writes in flight. Our own writes echo back long after the call
    /// returns, so the flag is held for a moment past the write (see `save_scope`).
    pub internal_save_depth: u32,
    /// Paths this window holds in tabs, so a file already open is focused rather
    /// than loaded twice.
    pub tab_files: Vec<String>,
    /// What the renderer last reported. Used as the fast path in quit coordination.
    pub dirty: bool,
    /// Serializes writes for this window. A save is valid only while its source
    /// document is still the active one, and two saves must not interleave.
    pub save_lock: Arc<tokio::sync::Mutex<()>>,
}

impl std::fmt::Debug for Doc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Doc")
            .field("file_path", &self.file_path)
            .field("browse_path", &self.browse_path)
            .field("internal_save_depth", &self.internal_save_depth)
            .field("tab_files", &self.tab_files.len())
            .finish()
    }
}

impl Doc {
    /// True while a write of ours is in flight, in which case watcher events are
    /// our own echo and must be ignored.
    pub fn is_internal_save(&self) -> bool {
        self.internal_save_depth > 0
    }

    /// Remember the bytes we just wrote, so the watcher can skip them.
    pub fn remember_save(&mut self, path: &PathBuf, content: &str, mtime: u64) {
        self.file_path = Some(path.clone());
        self.browse_path = path.parent().map(|parent| parent.to_path_buf());
        self.last_internal_save_content = Some(content.to_string());
        self.last_known_mtime = mtime;
    }

    /// A document with no path has no mtime to compare against.
    pub fn changed_externally(&self, path: &PathBuf) -> bool {
        if self.file_path.as_ref() != Some(path) {
            return false;
        }
        fileio::changed_externally(path, self.last_known_mtime)
    }
}

pub type SharedDoc = Arc<Mutex<Doc>>;

/// The window registry: one document state per window label.
#[derive(Default)]
pub struct Registry {
    docs: Mutex<HashMap<String, SharedDoc>>,
}

impl Registry {
    pub fn doc(&self, label: &str) -> SharedDoc {
        let mut docs = self.docs.lock().expect("registry lock");
        docs.entry(label.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Doc::default())))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_that_is_not_the_windows_file_is_never_external() {
        let doc = Doc { file_path: Some(PathBuf::from("/tmp/a.md")), last_known_mtime: 10, ..Doc::default() };
        assert!(!doc.changed_externally(&PathBuf::from("/tmp/b.md")));
    }

    #[test]
    fn an_untitled_document_has_no_external_change() {
        let doc = Doc::default();
        assert!(!doc.changed_externally(&PathBuf::from("/tmp/a.md")));
        assert!(!doc.is_internal_save());
    }

    #[test]
    fn saving_rebinds_the_window_and_clears_the_browse_directory() {
        let mut doc = Doc::default();
        doc.remember_save(&PathBuf::from("/tmp/dir/note.md"), "body", 42);
        assert_eq!(doc.file_path, Some(PathBuf::from("/tmp/dir/note.md")));
        assert_eq!(doc.browse_path, Some(PathBuf::from("/tmp/dir")));
        assert_eq!(doc.last_internal_save_content.as_deref(), Some("body"));
        assert_eq!(doc.last_known_mtime, 42);
    }

    #[test]
    fn a_save_in_flight_is_reported_as_internal() {
        let mut doc = Doc::default();
        doc.internal_save_depth = 1;
        assert!(doc.is_internal_save());
        doc.internal_save_depth = 0;
        assert!(!doc.is_internal_save());
    }
}
