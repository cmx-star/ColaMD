// Right-click menus for the file panel and the tab strip.
//
// Native menus on purpose: there is no popup to theme, and the platform one stays
// accessible and familiar (the Electron build said the same thing).
//
// The context a click needs (which tab, which path) travels in the menu item's id
// rather than in state kept on the side, so a menu that outlives a tab switch still
// acts on what it was opened for. Ids are `tabmenu:<action>:<payload>` and
// `entrymenu:<action>:<payload>`; menu.rs parses them.

use tauri::menu::{ContextMenu, Menu, MenuItemBuilder};
use tauri::{AppHandle, WebviewWindow, Window};

use crate::i18n::t;

/// The native window behind a webview: a context menu is popped on the window, not on
/// the webview.
fn window_of(window: &WebviewWindow) -> Option<Window> {
    Some(window.as_ref().window())
}

/// Build a menu whose items are all plain entries, then show it at the cursor.
fn popup(app: &AppHandle, window: &WebviewWindow, entries: Vec<(String, String)>) -> tauri::Result<()> {
    let mut items = Vec::new();
    for (id, label) in entries {
        items.push(MenuItemBuilder::with_id(id, label).build(app)?);
    }
    let references: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let menu = Menu::with_items(app, &references)?;
    match window_of(window) {
        Some(native) => menu.popup(native),
        None => Ok(()),
    }
}

pub fn show_entry(app: &AppHandle, window: &WebviewWindow, path: &str, kind: &str) -> tauri::Result<()> {
    let is_directory = kind == "directory";
    let mut entries: Vec<(String, String)> = Vec::new();
    if !is_directory {
        // First item: opening a document in its own tab is what this menu is reached
        // for (design.md).
        entries.push((
            format!("entrymenu:newtab:{path}"),
            t("在新标签页打开", "Open in New Tab").to_string(),
        ));
    }
    entries.push((format!("entrymenu:copypath:{path}"), t("复制路径", "Copy path").to_string()));
    if !is_directory {
        entries.push((
            format!("entrymenu:open:{path}"),
            t("用默认应用打开", "Open in default app").to_string(),
        ));
    }
    entries.push((
        format!("entrymenu:reveal:{path}"),
        reveal_label().to_string(),
    ));
    popup(app, window, entries)
}

pub fn show_tab(
    app: &AppHandle,
    window: &WebviewWindow,
    tab_id: &str,
    file_path: Option<&str>,
    can_close_others: bool,
    can_close_right: bool,
) -> tauri::Result<()> {
    let mut entries: Vec<(String, String)> = vec![(
        format!("tabmenu:close:{tab_id}"),
        t("关闭", "Close").to_string(),
    )];
    if can_close_others {
        entries.push((
            format!("tabmenu:close-others:{tab_id}"),
            t("关闭其他标签页", "Close Other Tabs").to_string(),
        ));
    }
    if can_close_right {
        entries.push((
            format!("tabmenu:close-right:{tab_id}"),
            t("关闭右侧标签页", "Close Tabs to the Right").to_string(),
        ));
    }
    if let Some(path) = file_path.filter(|path| !path.is_empty()) {
        entries.push((format!("tabmenu:newwindow:{path}"), t("在新窗口打开", "Open in New Window").to_string()));
        entries.push((format!("tabmenu:copypath:{path}"), t("复制路径", "Copy path").to_string()));
        entries.push((format!("tabmenu:reveal:{path}"), reveal_label().to_string()));
    }
    popup(app, window, entries)
}

/// What the platform calls its file manager, for the reveal entry.
fn reveal_label() -> &'static str {
    if cfg!(target_os = "macos") {
        t("在 Finder 中显示", "Reveal in Finder")
    } else if cfg!(target_os = "windows") {
        t("在资源管理器中显示", "Reveal in File Explorer")
    } else {
        t("打开所在文件夹", "Open Containing Folder")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reveal_entry_names_the_platform_file_manager() {
        let label = reveal_label();
        assert!(!label.is_empty());
        #[cfg(target_os = "macos")]
        assert!(label == "在 Finder 中显示" || label == "Reveal in Finder");
    }
}
