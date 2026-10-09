// What a context menu entry does when it is clicked.
//
// The menu items carry their context in the id (`tabmenu:<action>:<payload>`), so a
// menu that outlives a tab switch still acts on what it was opened for. Parsing lives
// here rather than in menu.rs because these are not application-menu commands.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::trace::trace;

/// Split `<prefix>:<action>:<payload>`, keeping the payload whole (a path may contain
/// colons).
fn parse(id: &str) -> Option<(&str, &str, &str)> {
    let mut parts = id.splitn(3, ':');
    let prefix = parts.next()?;
    let action = parts.next()?;
    let payload = parts.next()?;
    match prefix {
        "tabmenu" | "entrymenu" => Some((prefix, action, payload)),
        _ => None,
    }
}

pub fn dispatch(app: &AppHandle, id: &str) {
    let Some((prefix, action, payload)) = parse(id) else {
        trace(|| format!("unrecognised context menu id: {id}"));
        return;
    };
    let window = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));

    match (prefix, action) {
        // The tab strip lives in the renderer, so these only report the intent.
        ("tabmenu", "close") => send_tab_action(window.as_ref(), "close", payload),
        ("tabmenu", "close-others") => send_tab_action(window.as_ref(), "close-others", payload),
        ("tabmenu", "close-right") => send_tab_action(window.as_ref(), "close-right", payload),
        (_, "newtab") => {
            if let Some(window) = window {
                let _ = window.emit("open-in-new-tab", payload.to_string());
            }
        }
        ("tabmenu", "newwindow") => {
            crate::windows::open_untitled_window(app);
            crate::windows::open_document(app, None, std::path::PathBuf::from(payload));
        }
        (_, "copypath") => match app.clipboard().write_text(payload.to_string()) {
            Ok(()) => trace(|| format!("copied path {payload}")),
            Err(error) => trace(|| format!("could not copy the path: {error}")),
        },
        (_, "reveal") => {
            let _ = app.opener().reveal_item_in_dir(payload);
        }
        (_, "open") => {
            let _ = app.opener().open_path(payload, None::<&str>);
        }
        _ => trace(|| format!("context menu id with no handler: {id}")),
    }
}

fn send_tab_action(window: Option<&tauri::WebviewWindow>, action: &str, tab_id: &str) {
    let Some(window) = window else { return };
    let _ = window.emit("tab-menu-action", serde_json::json!({ "action": action, "tabId": tab_id }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_yields_its_prefix_action_and_payload() {
        assert_eq!(parse("tabmenu:close:tab-3"), Some(("tabmenu", "close", "tab-3")));
        assert_eq!(
            parse("entrymenu:newtab:/Users/me/notes/a.md"),
            Some(("entrymenu", "newtab", "/Users/me/notes/a.md"))
        );
    }

    #[test]
    fn a_path_may_contain_colons() {
        assert_eq!(
            parse("entrymenu:reveal:/Users/me/odd:name.md"),
            Some(("entrymenu", "reveal", "/Users/me/odd:name.md"))
        );
    }

    #[test]
    fn anything_else_is_not_a_context_menu_id() {
        assert_eq!(parse("file-save"), None);
        assert_eq!(parse("entrymenu:only-two"), None);
    }
}
