// System fonts, for the editor font dialog.
//
// The Electron build asked AppKit for the installed families by running an
// osascript JavaScript snippet, and returned an empty list everywhere else; the
// dialog then falls back to whatever the user types. The same call is made here, so
// the dialog offers the same names rather than a second, divergent list.

use std::process::Command;

use tauri::{AppHandle, Emitter, Manager};

/// The AppKit query, verbatim from the Electron build: family names localized for
/// the interface language.
/// Family names, asked of AppKit directly.
///
/// The Electron build called `localizedFamilyNameForFamilyFace`, which no longer
/// exists in the AppKit that ships with current macOS: the script threw and the
/// dialog listed nothing. Enumerating the array by index works, and it is what both
/// shells need now (2026-10-09).
const APPLESCRIPT: &str = concat!(
    "ObjC.import(\"AppKit\"); ",
    "const fm = $.NSFontManager.sharedFontManager; ",
    "const fams = fm.availableFontFamilies; ",
    "const out = []; ",
    "for (let i = 0; i < fams.count; i++) { out.push(ObjC.unwrap(fams.objectAtIndex(i))) }; ",
    "out.join(\"\\n\")"
);

fn families() -> Vec<String> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let output = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", APPLESCRIPT])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut names: Vec<String> = text
        .split('\n')
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    names
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    let names = tauri::async_runtime::spawn_blocking(families)
        .await
        .unwrap_or_default();
    crate::trace::trace(|| format!("system fonts: {} families", names.len()));
    Ok(names)
}

/// A font chosen in one window reaches the others, which is what keeps two open
/// windows from disagreeing about the editor's typeface.
#[tauri::command]
pub async fn set_editor_font(window: tauri::WebviewWindow, prefs: serde_json::Value) -> Result<(), String> {
    let app = window.app_handle().clone();
    let sender = window.label().to_string();
    for (label, other) in app.webview_windows() {
        if label == sender {
            continue;
        }
        let _ = other.emit("editor-font-changed", prefs.clone());
    }
    Ok(())
}

/// Slideshow presentation takes the whole screen and gives it back.
#[tauri::command]
pub async fn set_slideshow_fullscreen(window: tauri::WebviewWindow, on: bool) -> Result<bool, String> {
    window.set_fullscreen(on).map_err(|error| error.to_string())?;
    Ok(window.is_fullscreen().unwrap_or(on))
}

/// The menu bar on Windows/Linux is drawn by the system; the renderer's own menu
/// button asks for it to pop up at the pointer.
#[tauri::command]
pub async fn popup_app_menu(app: AppHandle) -> Result<(), String> {
    // A menu shown programmatically needs a position, which only the renderer knows.
    // Until the button's geometry is passed through, this reports instead of
    // pretending: the app menu is reachable from the menu bar on every platform.
    crate::trace::trace(|| "popup_app_menu: not ported yet (P4)".to_string());
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_font_query_is_the_one_the_electron_build_used() {
        assert!(APPLESCRIPT.contains("NSFontManager"));
        assert!(APPLESCRIPT.contains("availableFontFamilies"));
    }

    /// The query is an external process, so a broken one fails silently and the
    /// dialog just looks empty. This is the net for that (2026-10-09: the method the
    /// Electron build called no longer exists and both shells listed nothing).
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_actually_reports_its_font_families() {
        let names = families();
        assert!(
            names.len() > 10,
            "AppKit returned {} families; the query is broken again",
            names.len()
        );
        assert!(names.iter().any(|name| !name.is_empty()));
    }

    #[test]
    fn only_macos_answers_with_families() {
        let names = families();
        if !cfg!(target_os = "macos") {
            assert!(names.is_empty());
        }
    }
}
