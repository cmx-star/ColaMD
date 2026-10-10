// Themes: the four built-ins live in the renderer's CSS; what the shell owns is
// the user's own theme files under `~/.loomark/themes`, the import dialog that puts
// them there, and handing the CSS to the renderer when the menu picks one.
//
// The renderer stores the choice as `custom:<file>`, so everything here speaks that
// same spelling.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::i18n::t;
use crate::paths;

/// Read a custom theme by file name. Refuses anything that is not a plain `.css`
/// name inside the themes folder, so a name from the renderer cannot walk out of it.
pub fn read_custom_theme(file: &str) -> Option<String> {
    if file.is_empty() || file.contains('/') || file.contains('\\') || !file.ends_with(".css") {
        return None;
    }
    std::fs::read_to_string(paths::themes_dir().join(file)).ok()
}

/// The renderer asked for a theme by name; answer with its CSS when it is custom.
#[tauri::command]
pub async fn load_theme_css(file_name: String) -> Result<Option<String>, String> {
    Ok(read_custom_theme(&file_name))
}

/// "Import Theme..." — copy a CSS file the user picks into the themes folder.
#[tauri::command]
pub async fn load_custom_theme(window: tauri::WebviewWindow) -> Result<Option<serde_json::Value>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .add_filter("CSS", &["css"])
        .set_title(t("导入主题", "Import Theme"))
        .pick_file(move |picked| {
            let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
        });
    let Some(source) = receiver.await.ok().flatten() else {
        return Ok(None);
    };

    let Some(name) = source.file_name().map(|name| name.to_string_lossy().to_string()) else {
        return Ok(None);
    };
    let css = std::fs::read_to_string(&source).map_err(|error| error.to_string())?;
    if !paths::ensure_dir(&paths::themes_dir()) {
        return Ok(None);
    }
    std::fs::write(paths::themes_dir().join(&name), &css).map_err(|error| error.to_string())?;
    crate::trace::trace(|| format!("imported theme {name}"));

    // The menu lists custom themes, so it is rebuilt to show the new one.
    let app = window.app_handle().clone();
    crate::menu::build(&app);
    Ok(Some(serde_json::json!({ "name": name, "css": css })))
}

/// Apply a custom theme chosen from the menu: the renderer owns the styling, so it
/// gets told which theme and handed the CSS.
pub fn apply_custom(app: &AppHandle, file: &str) {
    let Some(css) = read_custom_theme(file) else {
        crate::trace::trace(|| format!("custom theme {file} could not be read"));
        return;
    };
    let window = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    if let Some(window) = window {
        let _ = window.emit("set-theme", format!("custom:{file}"));
        let _ = window.emit("set-custom-css", css);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_theme_name_cannot_leave_the_themes_folder() {
        assert!(read_custom_theme("../secrets.css").is_none());
        assert!(read_custom_theme("nested/theme.css").is_none());
        assert!(read_custom_theme("theme.txt").is_none());
        assert!(read_custom_theme("").is_none());
    }

    #[test]
    fn a_missing_theme_reads_as_nothing() {
        assert!(read_custom_theme("definitely-not-here.css").is_none());
    }
}
