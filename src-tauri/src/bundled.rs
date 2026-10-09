// The document that ships with the app: the Markdown cheatsheet, opened with no file
// behind it, the way the Electron build opened bundled content.
//
// It used to cover the changelog too ("What's New"); that menu entry was removed on
// 2026-10-09, so only the cheatsheet is left.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::i18n;

/// `resources/demo` and `resources/templates` from the repository, or their
/// counterparts inside a packaged app.
fn resource_root(app: &AppHandle) -> Option<PathBuf> {
    // Development builds run from target/<profile>, where the repository is two
    // levels up; a packaged app carries the folders as resources.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("resources");
    if dev.is_dir() {
        return Some(dev);
    }
    app.path()
        .resource_dir()
        .ok()
        .filter(|dir| dir.is_dir())
}

fn templates_dir(app: &AppHandle) -> Option<PathBuf> {
    let root = resource_root(app)?;
    let packaged = root.join("templates");
    if packaged.is_dir() {
        Some(packaged)
    } else {
        Some(root)
    }
}

/// The cheatsheet follows the interface language, like every other string.
pub fn open_cheatsheet(app: &AppHandle) {
    let file = if i18n::code() == "en" { "cheatsheet-en.md" } else { "cheatsheet.md" };
    let dir = templates_dir(app);
    let path = dir.as_ref().map(|dir| dir.join(file));
    match path.and_then(|path| std::fs::read_to_string(path).ok()) {
        Some(content) => crate::windows::open_memory_window(app, content, dir),
        None => {
            crate::trace::trace(|| format!("cheatsheet {file} not found"));
            crate::windows::open_untitled_window(app);
        }
    }
}
