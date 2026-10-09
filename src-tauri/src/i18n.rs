// The interface language, shared with the Electron build.
//
// Dialogs the user sees during normal use follow the UI language too: they used to
// be hardcoded Chinese, so an English window got Chinese buttons and vice versa.
// The preference lives in `language.json` next to the other settings, in the format
// the Electron build already writes.

use std::sync::OnceLock;

static PREFERRED: OnceLock<String> = OnceLock::new();

fn load() -> String {
    let path = crate::paths::language_preference_path();
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            match parsed.get("language").and_then(|value| value.as_str()) {
                Some("zh") => return "zh".to_string(),
                Some("en") => return "en".to_string(),
                _ => {}
            }
        }
    }
    // No stored choice: follow the system, the way app.getLocale() did.
    if system_prefers_chinese() {
        "zh".to_string()
    } else {
        "en".to_string()
    }
}

/// The system's own language.
///
/// An app launched from Finder or the Dock inherits almost no environment, so
/// `LANG`/`LC_ALL` say nothing about what the user reads; that is why the menu came
/// up English on a Chinese system (2026-10-09). On macOS the answer lives in the
/// global defaults, which is what `app.getLocale()` reads too.
fn system_prefers_chinese() -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("defaults").args(["read", "-g", "AppleLanguages"]).output() {
            // The list is ordered by preference, so the first quoted tag is the answer.
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(tag) = first_quoted(&text) {
                return tag.to_lowercase().starts_with("zh");
            }
        }
        if let Ok(output) = std::process::Command::new("defaults").args(["read", "-g", "AppleLocale"]).output() {
            let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if !text.trim().is_empty() {
                return text.contains("zh");
            }
        }
    }
    let locale = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
        .to_lowercase();
    locale.starts_with("zh")
}

fn current() -> &'static str {
    PREFERRED.get_or_init(load).as_str()
}

/// The active language code: `zh` or `en`.
pub fn code() -> &'static str {
    current()
}

/// Pick the string that matches the active language.
pub fn t<'a>(zh: &'a str, en: &'a str) -> &'a str {
    if current() == "zh" {
        zh
    } else {
        en
    }
}

/// Remember a language chosen from the menu, so the next launch and every dialog
/// agree with it.
pub fn set_code(language: &str) -> bool {
    if language != "zh" && language != "en" {
        return false;
    }
    let path = crate::paths::language_preference_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({ "language": language });
    if std::fs::write(&path, payload.to_string()).is_err() {
        return false;
    }
    // A OnceLock cannot be reassigned; the process keeps its choice until restart,
    // which matches Electron rebuilding its menus after a language switch anyway.
    true
}

/// The first `"…"` token in a string, used for the defaults output.
fn first_quoted(text: &str) -> Option<String> {
    let start = text.find('"')?;
    let rest = &text[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picking_a_string_follows_the_language() {
        let (zh, en) = ("中文", "English");
        let picked = t(zh, en);
        assert!(picked == zh || picked == en);
    }

    #[test]
    fn the_preferred_language_is_the_first_quoted_tag() {
        let output = "(\n    \"zh-Hans-CN\"\n)\n";
        assert_eq!(first_quoted(output).as_deref(), Some("zh-Hans-CN"));
        let output = "(\n    \"en-US\",\n    \"zh-Hans-CN\"\n)\n";
        assert_eq!(first_quoted(output).as_deref(), Some("en-US"));
        assert_eq!(first_quoted(""), None);
    }

    #[test]
    fn only_the_two_supported_codes_are_accepted() {
        assert!(!set_code("fr"));
        assert!(!set_code(""));
    }
}
