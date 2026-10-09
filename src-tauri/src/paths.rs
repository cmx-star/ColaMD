// Where ColaMD keeps the things that outlive a run.
//
// These paths are deliberately the ones the Electron build used, because users
// already have files there: a migration that moved the theme folder or the recent
// list would look exactly like data loss. `~/.colamd` holds the shared, visible
// data (themes, recent documents, recovery copies); the platform data directory
// holds the quieter preferences, under the same folder name Electron used.

use std::path::PathBuf;

/// `~/.colamd`
pub fn colamd_home() -> PathBuf {
    home_dir().join(".colamd")
}

/// `~/.colamd/themes`: imported custom themes, one CSS file each.
pub fn themes_dir() -> PathBuf {
    colamd_home().join("themes")
}

/// `~/.colamd/recovered`: the copy written before unsaved work is discarded.
pub fn recovery_dir() -> PathBuf {
    colamd_home().join("recovered")
}

/// `~/.colamd/recent.json`
pub fn recent_store_path() -> PathBuf {
    colamd_home().join("recent.json")
}

/// The preferences directory, named the way Electron's `app.getPath('userData')`
/// was on each platform, so an install of either shell reads the same settings.
pub fn user_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home_dir().join("Library").join("Application Support").join("ColaMD")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join("ColaMD")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("ColaMD")
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
        let home = colamd_home();
        assert!(home.ends_with(".colamd"));
        assert!(themes_dir().ends_with(".colamd/themes"));
        assert!(recovery_dir().ends_with(".colamd/recovered"));
        assert!(recent_store_path().ends_with(".colamd/recent.json"));
    }

    #[test]
    fn preferences_stay_under_the_name_the_electron_build_used() {
        assert!(user_data_dir().ends_with("ColaMD"));
        assert!(renderer_error_log().ends_with("renderer-errors.log"));
    }
}
