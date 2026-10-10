// The application menu.
//
// Ported from the Electron build's buildMenu (src/main/index.ts, 355 lines). The
// structure is the same on purpose: the same submenus, the same accelerators, and
// the same route for anything the renderer owns, which is an event on the focused
// window. Two deliberate differences are noted inline: "Set as Default App" is
// not ported yet.

use tauri::menu::{AboutMetadataBuilder, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::t;
use crate::paths;
use crate::recent;

/// The built-in themes the menu offers. Four on purpose: the list is short enough
/// to pick from without opening anything, and each one is a distinct look rather
/// than a variation (2026-10-09).
const BUILT_IN_THEMES: [(&str, &str, &str); 4] = [
    ("light", "浅色", "Light"),
    ("sepia", "羊皮纸", "Sepia"),
    ("solarized-dark", "夜航", "Solarized Dark"),
    ("nord", "极地", "Nord"),
];

/// Where a menu command goes: the focused window, else the last one the user worked
/// in, else the main window. A menu accelerator belongs to the app rather than to a
/// window, so none of these may report focus at that instant; dropping the event
/// silently is what made ⌘S do nothing (2026-10-09).
fn send_to_focused(app: &AppHandle, event: &str, payload: Option<&str>) {
    let windows = app.webview_windows();
    let focused = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .map(|window| window.label().to_string());
    let remembered = app.state::<crate::MenuState>().last_focused();
    let only_window = if windows.len() == 1 { windows.keys().next().cloned() } else { None };

    let target = focused
        .clone()
        .or_else(|| remembered.clone())
        .filter(|label| windows.contains_key(label))
        .or_else(|| app.get_webview_window("main").map(|window| window.label().to_string()))
        .or(only_window);

    let Some(label) = target else {
        crate::trace::trace(|| {
            format!("menu event {event} dropped: no window to deliver to (focused={focused:?}, remembered={remembered:?}, open={:?})", windows.keys().collect::<Vec<_>>())
        });
        return;
    };
    let Some(window) = app.get_webview_window(&label) else {
        return;
    };
    crate::trace::trace(|| format!("menu event {event} -> window {label}"));
    match payload {
        Some(value) => {
            let _ = window.emit(event, value);
        }
        None => {
            let _ = window.emit(event, ());
        }
    }
}

/// The Format submenu.
///
/// The id suffix is exactly the id the renderer's `runFormatCommand` expects
/// (`inlineCode`, `bulletList`, `orderedList`): the menu handler strips the `format-`
/// prefix and forwards what is left, so a kebab-case spelling here produced a command
/// name the renderer did not know and the item silently did nothing (2026-10-09).
///
/// (id suffix, label in Chinese, label in English, accelerator, shortcut hint)
///
/// `accelerator` is registered with the system, which draws it beside the label. The
/// hint is for the one shortcut the renderer owns instead (see italic below): those
/// cannot be registered, but the user still has to be able to see them.
///
/// Inline formatting only. The two list commands are gone (2026-10-09): typing `- `
/// or `1. ` is what a Markdown writer does anyway, and a menu entry for it was one
/// more thing to keep in step.
const FORMAT_ITEMS: [(&str, &str, &str, &str, &str); 5] = [
    ("bold", "加粗", "Bold", "CmdOrCtrl+B", ""),
    // ⌘I is the renderer's (see main.ts). Registering it here did not reach the shell,
    // and the editor's own keymap turned it into "select parent syntax" instead. The
    // hint is spelled out because a shortcut nobody can see is a shortcut nobody finds.
    ("italic", "斜体", "Italic", "", "⌘I"),
    ("inlineCode", "行内代码", "Inline Code", "CmdOrCtrl+E", ""),
    ("strikethrough", "删除线", "Strikethrough", "CmdOrCtrl+Shift+X", ""),
    ("link", "链接（网址取自剪贴板）", "Link (URL from clipboard)", "CmdOrCtrl+K", ""),
];

fn format_submenu(app: &AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let mut builder = SubmenuBuilder::new(app, t("格式", "Format"));
    for (command, zh, en, accelerator, hint) in FORMAT_ITEMS {
        let label = if hint.is_empty() {
            t(zh, en).to_string()
        } else {
            format!("{}  {hint}", t(zh, en))
        };
        let item_builder = MenuItemBuilder::with_id(format!("format-{command}"), label.clone());
        let item_builder = if accelerator.is_empty() {
            item_builder
        } else {
            item_builder.accelerator(accelerator)
        };
        let item = item_builder.build(app)?;
        // A shortcut nobody can press and a shortcut that was never registered look the
        // same from the outside; this is what the shell was asked to register. The label
        // is logged too, so a hint that never made it into the text is visible in the log
        // rather than only on screen (COLAMD_TRACE=1).
        crate::trace::trace(|| format!("format item {command} label=\"{label}\" asks for {accelerator}"));
        builder = builder.item(&item);
    }
    builder.build()
}

/// Theme items: the twelve built-ins, then any custom themes the user imported,
/// then the import entry. Check state comes from what the renderer reported.
fn theme_submenu(app: &AppHandle, current: &str) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let mut builder = SubmenuBuilder::new(app, t("主题", "Theme"));

    for (id, zh, en) in BUILT_IN_THEMES.iter() {
        let checked = current == *id;
        let item = CheckMenuItemBuilder::with_id(format!("theme-{id}"), t(zh, en))
            .checked(checked)
            .build(app)?;
        builder = builder.item(&item);
    }

    let custom = custom_theme_files();
    if !custom.is_empty() {
        builder = builder.separator();
        for file in custom {
            let id = format!("theme-custom:{file}");
            let checked = current == id;
            let label = file.trim_end_matches(".css").to_string();
            let item = CheckMenuItemBuilder::with_id(id, label).checked(checked).build(app)?;
            builder = builder.item(&item);
        }
    }

    builder = builder.separator();
    let import = MenuItemBuilder::with_id("theme-import", t("导入主题...", "Import Theme...")).build(app)?;
    builder = builder.item(&import);
    builder.build()
}

fn custom_theme_files() -> Vec<String> {
    let dir = paths::themes_dir();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.ends_with(".css").then_some(name)
        })
        .collect();
    files.sort();
    files
}

fn recent_submenu(app: &AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let mut builder = SubmenuBuilder::new(app, t("最近打开", "Open Recent"));
    let files = recent::files();
    if files.is_empty() {
        let empty = MenuItemBuilder::with_id("recent-empty", t("没有最近打开的文件", "No recent files"))
            .enabled(false)
            .build(app)?;
        builder = builder.item(&empty);
    } else {
        for (index, path) in files.iter().enumerate() {
            let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
            let item = MenuItemBuilder::with_id(format!("recent-{index}"), format!("{}. {name}", index + 1))
                .build(app)?;
            builder = builder.item(&item);
        }
    }
    builder.build()
}

/// Build and install the whole menu. Rebuilt when the theme, panel side, page width
/// or language changes, because those items carry check marks.
pub fn build(app: &AppHandle) {
    let state = app.state::<crate::MenuState>();
    let (theme, panel_side, page_width) = state.snapshot();
    let language = crate::i18n::code();

    if let Err(error) = build_inner(app, &theme, &panel_side, &page_width, language) {
        crate::trace::trace(|| format!("menu build failed: {error}"));
    }
}

fn build_inner(
    app: &AppHandle,
    current_theme: &str,
    current_panel_side: &str,
    current_page_width: &str,
    language: &str,
) -> tauri::Result<()> {
    let is_mac = cfg!(target_os = "macos");

    let menu = if is_mac {
        let about = PredefinedMenuItem::about(
            app,
            Some(t("关于 loomark", "About loomark")),
            Some(AboutMetadataBuilder::new().name(Some("loomark")).version(Some(env!("CARGO_PKG_VERSION"))).build()),
        )?;
        let quit = PredefinedMenuItem::quit(app, Some(t("退出 loomark", "Quit loomark")))?;
        let hide = PredefinedMenuItem::hide(app, Some(t("隐藏 loomark", "Hide loomark")))?;
        let hide_others = PredefinedMenuItem::hide_others(app, Some(t("隐藏其他应用", "Hide Others")))?;
        let show_all = PredefinedMenuItem::show_all(app, Some(t("显示全部", "Show All")))?;
        SubmenuBuilder::new(app, "loomark")
            .item(&about)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .separator()
            .item(&quit)
            .build()?
    } else {
        SubmenuBuilder::new(app, "loomark")
            .item(&PredefinedMenuItem::quit(app, Some(t("退出 loomark", "Quit loomark")))?)
            .build()?
    };

    // --- File ---------------------------------------------------------------
    // New opens a tab in this window: design.md, "新建也是开标签，不是开窗口".
    // A separate window is the user asking for one, which is what the item below is.
    let new_tab_from_new = MenuItemBuilder::with_id("file-new", t("新建", "New"))
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_window = MenuItemBuilder::with_id("file-new-window", t("新建窗口", "New Window"))
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let open = MenuItemBuilder::with_id("file-open", t("打开...", "Open..."))
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let recents = recent_submenu(app)?;
    let restore = CheckMenuItemBuilder::with_id("file-restore", t("启动时打开上次文档", "Reopen last document at launch"))
        .checked(recent::restore_on_launch())
        .build(app)?;
    let clear_recent = MenuItemBuilder::with_id("file-clear-recent", t("清除最近记录", "Clear Recent")).build(app)?;
    // No accelerator: ⌘N already creates a tab, and ⌘T now belongs to the file panel
    // (the reporter's ⌘\ never reached the app, so the panel had no working key).
    let new_tab = MenuItemBuilder::with_id("file-new-tab", t("新建标签页", "New Tab")).build(app)?;
    let close_tab = MenuItemBuilder::with_id("file-close-tab", t("关闭标签页", "Close Tab"))
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let save = MenuItemBuilder::with_id("file-save", t("保存", "Save"))
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("file-save-as", t("另存为...", "Save As..."))
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    // 幻灯片 PDF 仍未移植，保持禁用而不是点了没反应：一个静默无事的菜单项与坏掉的
    // 菜单项无法区分。其余导出都已可用（docs/tauri-migration-plan.md 的 P5）。
    let not_ported = t("（此版本尚未提供）", "(not in this build)");
    let export_pdf = MenuItemBuilder::with_id("file-export-pdf", t("导出 PDF...", "Export PDF...")).build(app)?;
    let export_slides_pdf = MenuItemBuilder::with_id(
        "file-export-slides-pdf",
        format!("{} {not_ported}", t("导出幻灯片 PDF...", "Export Slides PDF...")),
    )
    .enabled(false)
    .build(app)?;
    let export_html = MenuItemBuilder::with_id("file-export-html", t("导出 HTML...", "Export HTML...")).build(app)?;
    let export_word = MenuItemBuilder::with_id("file-export-word", t("导出 Word...", "Export Word...")).build(app)?;
    let export_image_desktop = MenuItemBuilder::with_id(
        "file-export-image-desktop",
        t("导出图片（电脑阅读）...", "Export Image (Desktop)..."),
    )
    .build(app)?;
    let export_image_mobile = MenuItemBuilder::with_id(
        "file-export-image-mobile",
        t("导出图片（手机阅读）...", "Export Image (Mobile)..."),
    )
    .build(app)?;

    let mut file_builder = SubmenuBuilder::new(app, t("文件", "File"))
        .item(&new_tab_from_new)
        .item(&new_window)
        .item(&open)
        .item(&recents)
        .item(&restore)
        .item(&clear_recent)
        .separator()
        .item(&new_tab)
        .item(&close_tab)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&export_pdf)
        .item(&export_slides_pdf)
        .item(&export_html)
        .item(&export_word)
        .item(&export_image_desktop)
        .item(&export_image_mobile)
        .separator();
    file_builder = if is_mac {
        // ⌘⇧W, not the predefined close_window: that one carries ⌘W, which is already
        // Close Tab, and macOS would then show the same shortcut twice with the
        // winner decided by menu order. Electron spelled it ⌘⇧W too (2026-10-09).
        let close_window = MenuItemBuilder::with_id("file-close-window", t("关闭窗口", "Close Window"))
            .accelerator("CmdOrCtrl+Shift+W")
            .build(app)?;
        file_builder.item(&close_window)
    } else {
        file_builder.item(&PredefinedMenuItem::quit(app, Some(t("退出 loomark", "Quit loomark")))?)
    };
    let file = file_builder.build()?;

    // --- Edit ---------------------------------------------------------------
    let find = MenuItemBuilder::with_id("edit-find", t("查找", "Find"))
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let format = format_submenu(app)?;
    let edit = SubmenuBuilder::new(app, t("编辑", "Edit"))
        .item(&PredefinedMenuItem::undo(app, Some(t("撤销", "Undo")))?)
        .item(&PredefinedMenuItem::redo(app, Some(t("重做", "Redo")))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(t("剪切", "Cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(t("复制", "Copy")))?)
        .item(&PredefinedMenuItem::paste(app, Some(t("粘贴", "Paste")))?)
        .item(&PredefinedMenuItem::select_all(app, Some(t("全选", "Select All")))?)
        .separator()
        .item(&find)
        .item(&format)
        .build()?;

    // --- View ---------------------------------------------------------------
    // These three used to zoom the whole page (`set_zoom`). That scales the chrome
    // row with it, and macOS draws the traffic lights at the window's own size, so
    // they stopped being centred (2026-10-06). They now step the document's font
    // size in the renderer: the interface keeps its size, only the prose changes.
    let zoom_out = MenuItemBuilder::with_id("view-zoom-out", t("缩小字号", "Smaller Text"))
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("view-zoom-in", t("放大字号", "Larger Text"))
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view-zoom-reset", t("默认字号", "Default Text Size"))
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    // ⌘T, not ⌘\: that key was taken by another app on the machine this was tested
    // on, so the panel was unreachable from the keyboard (2026-10-09).
    let file_panel = MenuItemBuilder::with_id("view-file-panel", t("显示 / 隐藏文件列表", "Show / Hide File List"))
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let panel_right = CheckMenuItemBuilder::with_id("view-panel-right", t("在右侧", "On the Right"))
        .checked(current_panel_side == "right")
        .build(app)?;
    let panel_left = CheckMenuItemBuilder::with_id("view-panel-left", t("在左侧", "On the Left"))
        .checked(current_panel_side == "left")
        .build(app)?;
    let panel_side = SubmenuBuilder::new(app, t("文件列表位置", "File List Position"))
        .item(&panel_right)
        .item(&panel_left)
        .build()?;
    // ⌘/ is the renderer's (main.ts): the accelerator here never arrived, and the
    // editor's keymap turned it into an HTML comment instead. The shortcut is spelled
    // into the label instead, so it is still discoverable from the menu.
    let source_mode = MenuItemBuilder::with_id("view-source-mode", t("切换 Markdown 源码  ⌘/", "Toggle Markdown Source  ⌘/"))
        .build(app)?;
    // Same reason as the format items: whether the hint is really in the label is a fact
    // worth having in the log, not a claim to take on trust.
    crate::trace::trace(|| format!("menu hint: source mode label=\"{}\"", t("切换 Markdown 源码  ⌘/", "Toggle Markdown Source  ⌘/")));
    let font_settings = MenuItemBuilder::with_id("view-font-settings", t("编辑器字体…", "Editor Font…")).build(app)?;
    let width_narrow = CheckMenuItemBuilder::with_id("view-width-narrow", t("窄", "Narrow"))
        .checked(current_page_width == "narrow")
        .build(app)?;
    let width_standard = CheckMenuItemBuilder::with_id("view-width-standard", t("标准", "Standard"))
        .checked(current_page_width == "standard")
        .build(app)?;
    let width_wide = CheckMenuItemBuilder::with_id("view-width-wide", t("宽", "Wide"))
        .checked(current_page_width == "wide")
        .build(app)?;
    let page_width = SubmenuBuilder::new(app, t("正文宽度", "Text Width"))
        .item(&width_narrow)
        .item(&width_standard)
        .item(&width_wide)
        .build()?;
    let language_zh = CheckMenuItemBuilder::with_id("view-language-zh", "中文")
        .checked(language == "zh")
        .build(app)?;
    let language_en = CheckMenuItemBuilder::with_id("view-language-en", "English")
        .checked(language == "en")
        .build(app)?;
    let language_menu = SubmenuBuilder::new(app, t("界面语言", "Language"))
        .item(&language_zh)
        .item(&language_en)
        .build()?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some(t("切换全屏", "Toggle Full Screen")))?;
    let view = SubmenuBuilder::new(app, t("视图", "View"))
        .item(&zoom_reset)
        .item(&zoom_in)
        .item(&zoom_out)
        .separator()
        .item(&file_panel)
        .item(&panel_side)
        .item(&source_mode)
        .separator()
        .item(&font_settings)
        .item(&page_width)
        .item(&language_menu)
        .separator()
        .item(&fullscreen)
        .build()?;

    let theme = theme_submenu(app, current_theme)?;

    // --- Help ---------------------------------------------------------------
    let check_updates = MenuItemBuilder::with_id("help-check-updates", t("检查更新...", "Check for Updates..."))
        .build(app)?;
    let about = PredefinedMenuItem::about(
        app,
        Some(t("关于 loomark", "About loomark")),
        Some(AboutMetadataBuilder::new().name(Some("loomark")).version(Some(env!("CARGO_PKG_VERSION"))).build()),
    )?;
    let help = SubmenuBuilder::new(app, t("帮助", "Help"))
        .item(&check_updates)
        .separator()
        .item(&about)
        .build()?;

    let mut builder = MenuBuilder::new(app).item(&menu).item(&file).item(&edit).item(&view).item(&theme);
    if is_mac {
        // No Close item here: the predefined one carries ⌘W, which is Close Tab, and
        // the menu would then show the same shortcut twice (File → Close Window has
        // ⌘⇧W and covers it). macOS still injects the system window-tiling commands
        // into whichever menu is registered as the Window menu.
        let window_menu = SubmenuBuilder::new(app, t("窗口", "Window"))
            .item(&PredefinedMenuItem::minimize(app, Some(t("最小化", "Minimize")))?)
            .item(&PredefinedMenuItem::maximize(app, Some(t("缩放", "Zoom")))?)
            .build()?;
        builder = builder.item(&window_menu);
    }
    let menu = builder.item(&help).build()?;

    app.set_menu(menu)?;
    crate::trace::trace(|| format!("menu built (theme={current_theme}, lang={language})"));
    Ok(())
}

/// Where the menu sends its commands. Items the renderer owns become events on the
/// focused window, exactly as the Electron menu did.
pub fn handle_event(app: &AppHandle, id: &str) {
    crate::trace::trace(|| format!("menu event: {id}"));
    let window = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));

    let emit = |event: &str, payload: Option<&str>| send_to_focused(app, event, payload);

    match id {
        "file-new" => emit("menu-new-tab", None),
        "file-new-window" => crate::windows::open_untitled_window(app),
        "file-open" => emit("menu-open", None),
        "file-new-tab" => emit("menu-new-tab", None),
        "file-close-tab" => emit("menu-close-tab", None),
        "file-close-window" => {
            if let Some(window) = window {
                let _ = window.close();
            }
        }
        "file-save" => emit("menu-save", None),
        "file-save-as" => emit("menu-save-as", None),
        "file-export-pdf" => emit("menu-export-pdf", None),
        "file-export-slides-pdf" => emit("menu-export-slides-pdf", None),
        "file-export-html" => emit("menu-export-html", None),
        "file-export-word" => emit("menu-export-docx", None),
        "file-export-image-desktop" => emit("menu-export-image", Some("desktop")),
        "file-export-image-mobile" => emit("menu-export-image", Some("mobile")),
        "file-clear-recent" => {
            recent::clear();
            build(app);
        }
        "file-restore" => {
            recent::set_restore_on_launch(!recent::restore_on_launch());
            build(app);
        }
        "help-check-updates" => emit("menu-check-updates", None),
        "edit-find" => emit("editor:search", None),
        // The renderer owns the document's font size; these just tell it which way
        // to step. `0` means "back to the theme's default", and keeps a font family
        // the user picked.
        "view-zoom-in" => emit("editor:step-font", Some("1")),
        "view-zoom-out" => emit("editor:step-font", Some("-1")),
        "view-zoom-reset" => emit("editor:step-font", Some("0")),
        "view-file-panel" => emit("toggle-file-panel", None),
        "view-source-mode" => emit("toggle-source-mode", None),
        "view-font-settings" => emit("open-font-settings", None),
        other if other.starts_with("tabmenu:") || other.starts_with("entrymenu:") => {
            crate::contextmenu_actions::dispatch(app, other);
        }
        other => {
            if let Some(theme) = other.strip_prefix("theme-custom:") {
                crate::themes::apply_custom(app, theme);
            } else if let Some(theme) = other.strip_prefix("theme-") {
                match theme {
                    "import" => emit("menu-import-theme", None),
                    name => {
                        emit("set-theme", Some(name));
                    }
                }
            } else if let Some(action) = other.strip_prefix("format-") {
                emit("editor:format", Some(action));
            } else if let Some(index) = other.strip_prefix("recent-").and_then(|value| value.parse::<usize>().ok()) {
                if let Some(path) = recent::files().get(index) {
                    crate::windows::open_document(app, window, path.clone());
                }
            } else if let Some(side) = other.strip_prefix("view-panel-") {
                emit("set-panel-side", Some(side));
            } else if let Some(width) = other.strip_prefix("view-width-") {
                emit("set-page-width", Some(width));
            } else if let Some(language) = other.strip_prefix("view-language-") {
                crate::i18n::set_code(language);
                emit("language-changed", Some(language));
                build(app);
            } else {
                crate::trace::trace(|| format!("menu item with no handler: {other}"));
            }
        }
    }
}
