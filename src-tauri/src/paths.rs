// Where loomark keeps the things that outlive a run.
//
// The folder names carry the app's name, so renaming the app moved them: `~/.loomark`
// holds the shared, visible data (themes, recent documents, recovery copies), and the
// platform data directory holds the quieter preferences under the same name.
//
// The rename is deliberate and was accepted without a migration (2026-10-09). The
// folders used to keep the old names on the grounds that moving them would look like
// data loss; anyone upgrading from a build under the old name keeps their old folder
// on disk, but the app no longer reads it.

use std::path::PathBuf;

/// `~/.loomark`
pub fn loomark_home() -> PathBuf {
    home_dir().join(".loomark")
}

/// `~/.loomark/themes`: imported custom themes, one CSS file each.
pub fn themes_dir() -> PathBuf {
    loomark_home().join("themes")
}

/// `~/.loomark/recovered`: the copy written before unsaved work is discarded.
pub fn recovery_dir() -> PathBuf {
    loomark_home().join("recovered")
}

/// `~/.loomark/recent.json`
pub fn recent_store_path() -> PathBuf {
    loomark_home().join("recent.json")
}

/// The preferences directory, named after the app.
pub fn user_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home_dir().join("Library").join("Application Support").join("loomark")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join("loomark")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("loomark")
    }
}

/// `renderer-errors.log`: the one trace a window that dies during init leaves.
pub fn renderer_error_log() -> PathBuf {
    user_data_dir().join("renderer-errors.log")
}

/// `language.json`: the interface language, chosen once and remembered.
pub fn language_preference_path() -> PathBuf {
    user_data_dir().join("language.json")
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Create a directory and its parents, reporting whether it is usable afterwards.
pub fn ensure_dir(path: &PathBuf) -> bool {
    if path.is_dir() {
        return true;
    }
    std::fs::create_dir_all(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_folders_live_under_the_home_dot_directory() {
        let home = loomark_home();
        assert!(home.ends_with(".loomark"));
        assert!(themes_dir().ends_with(".loomark/themes"));
        assert!(recovery_dir().ends_with(".loomark/recovered"));
        assert!(recent_store_path().ends_with(".loomark/recent.json"));
    }

    #[test]
    fn preferences_live_under_the_app_name() {
        assert!(user_data_dir().ends_with("loomark"));
        assert!(renderer_error_log().ends_with("renderer-errors.log"));
    }
}
