// The application menu.
//
// Ported from the Electron build's buildMenu (src/main/index.ts, 355 lines). The
// structure is the same on purpose: the same submenus, the same accelerators, and
// the same route for anything the renderer owns, which is an event on the focused
// window. Two deliberate differences are noted inline: the update items stay
// disabled until the updater lands (P4), and "Set as Default App" is not ported yet.

use tauri::menu::{AboutMetadataBuilder, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::t;
use crate::paths;
use crate::recent;

/// The built-in themes, in the order the menu shows them: light first, then dark.
const BUILT_IN_THEMES: [(&str, &str, &str); 12] = [
    ("light", "浅色", "Light"),
    ("elegant", "雅致", "Elegant"),
    ("notion", "简白", "Notion"),
    ("writer", "作家", "Writer"),
    ("bear", "熊红", "Bear"),
    ("sepia", "羊皮纸", "Sepia"),
    ("dark", "深色", "Dark"),
    ("gruvbox", "暖木", "Gruvbox"),
    ("midnight", "午夜", "Midnight"),
    ("solarized-dark", "夜航", "Solarized Dark"),
    ("nord", "极地", "Nord"),
    ("dracula", "德古拉", "Dracula"),
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

fn format_submenu(app: &AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let zh = crate::i18n::code() == "zh";
    let label = |zh_text: &'static str, en_text: &'static str| t(zh_text, en_text).to_string();
    let item = |id: &'static str, zh_text: &'static str, en_text: &'static str, accel: &'static str, command: &'static str| {
        MenuItemBuilder::with_id(id, label(zh_text, en_text))
            .accelerator(accel)
            .build(app)
            .map(|item| (item, command))
    };
    let _ = zh;

    let entries = [
        item("format-bold", "加粗", "Bold", "CmdOrCtrl+B", "bold")?,
        item("format-italic", "斜体", "Italic", "CmdOrCtrl+I", "italic")?,
        item("format-inline-code", "行内代码", "Inline Code", "CmdOrCtrl+E", "inlineCode")?,
        item("format-strikethrough", "删除线", "Strikethrough", "CmdOrCtrl+Shift+X", "strikethrough")?,
        item("format-link", "链接（网址取自剪贴板）", "Link (URL from clipboard)", "CmdOrCtrl+K", "link")?,
        item("format-bullet", "无序列表", "Bullet List", "CmdOrCtrl+Shift+8", "bulletList")?,
        item("format-ordered", "有序列表", "Ordered List", "CmdOrCtrl+Shift+7", "orderedList")?,
    ];

    let mut builder = SubmenuBuilder::new(app, label("格式", "Format"));
    for (menu_item, _) in &entries {
        builder = builder.item(menu_item);
    }
    builder.build()
}

/// Theme items: the twelve built-ins, then any custom themes the user imported,
/// then the import entry. Check state comes from what the renderer reported.
fn theme_submenu(app: &AppHandle, current: &str) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let mut builder = SubmenuBuilder::new(app, t("主题", "Theme"));

    for (index, (id, zh, en)) in BUILT_IN_THEMES.iter().enumerate() {
        // A separator splits the light themes from the dark ones, like the Electron
        // menu does.
        if index == 6 {
            builder = builder.separator();
        }
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
            Some(t("关于 ColaMD", "About ColaMD")),
            Some(AboutMetadataBuilder::new().name(Some("ColaMD")).version(Some(env!("CARGO_PKG_VERSION"))).build()),
        )?;
        let quit = PredefinedMenuItem::quit(app, Some(t("退出 ColaMD", "Quit ColaMD")))?;
        let hide = PredefinedMenuItem::hide(app, Some(t("隐藏 ColaMD", "Hide ColaMD")))?;
        let hide_others = PredefinedMenuItem::hide_others(app, Some(t("隐藏其他应用", "Hide Others")))?;
        let show_all = PredefinedMenuItem::show_all(app, Some(t("显示全部", "Show All")))?;
        SubmenuBuilder::new(app, "ColaMD")
            .item(&about)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .separator()
            .item(&quit)
            .build()?
    } else {
        SubmenuBuilder::new(app, "ColaMD")
            .item(&PredefinedMenuItem::quit(app, Some(t("退出 ColaMD", "Quit ColaMD")))?)
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
    let new_tab = MenuItemBuilder::with_id("file-new-tab", t("新建标签页", "New Tab"))
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("file-close-tab", t("关闭标签页", "Close Tab"))
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let save = MenuItemBuilder::with_id("file-save", t("保存", "Save"))
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("file-save-as", t("另存为...", "Save As..."))
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let export_pdf = MenuItemBuilder::with_id("file-export-pdf", t("导出 PDF...", "Export PDF...")).build(app)?;
    let export_slides_pdf =
        MenuItemBuilder::with_id("file-export-slides-pdf", t("导出幻灯片 PDF...", "Export Slides PDF...")).build(app)?;
    let export_html = MenuItemBuilder::with_id("file-export-html", t("导出 HTML...", "Export HTML...")).build(app)?;
    let export_word = MenuItemBuilder::with_id("file-export-word", t("导出 Word...", "Export Word...")).build(app)?;
    let export_image_desktop =
        MenuItemBuilder::with_id("file-export-image-desktop", t("导出图片（电脑阅读）...", "Export Image (Desktop)...")).build(app)?;
    let export_image_mobile =
        MenuItemBuilder::with_id("file-export-image-mobile", t("导出图片（手机阅读）...", "Export Image (Mobile)...")).build(app)?;

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
        file_builder
            .item(&PredefinedMenuItem::close_window(app, Some(t("关闭窗口", "Close Window")))?)
    } else {
        file_builder.item(&PredefinedMenuItem::quit(app, Some(t("退出 ColaMD", "Quit ColaMD")))?)
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
    let zoom_out = MenuItemBuilder::with_id("view-zoom-out", t("缩小", "Zoom Out"))
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("view-zoom-in", t("放大", "Zoom In"))
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view-zoom-reset", t("实际大小", "Actual Size"))
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let file_panel = MenuItemBuilder::with_id("view-file-panel", t("显示 / 隐藏文件列表", "Show / Hide File List"))
        .accelerator("CmdOrCtrl+\\")
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
    let source_mode = MenuItemBuilder::with_id("view-source-mode", t("切换 Markdown 源码", "Toggle Markdown Source"))
        .accelerator("CmdOrCtrl+/")
        .build(app)?;
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
    let slideshow = MenuItemBuilder::with_id("view-slideshow", t("放映幻灯片", "Play Slideshow"))
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)?;
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
        .item(&slideshow)
        .item(&fullscreen)
        .build()?;

    let theme = theme_submenu(app, current_theme)?;

    // --- Help ---------------------------------------------------------------
    let whats_new = MenuItemBuilder::with_id("help-whats-new", t("新功能演示", "What's New"))
        .accelerator("CmdOrCtrl+Shift+D")
        .build(app)?;
    let cheatsheet = MenuItemBuilder::with_id("help-cheatsheet", t("Markdown 语法", "Markdown Syntax"))
        .accelerator("CmdOrCtrl+Shift+/")
        .build(app)?;
    let check_updates = MenuItemBuilder::with_id("help-check-updates", t("检查更新...", "Check for Updates..."))
        .enabled(false)
        .build(app)?;
    let about = PredefinedMenuItem::about(
        app,
        Some(t("关于 ColaMD", "About ColaMD")),
        Some(AboutMetadataBuilder::new().name(Some("ColaMD")).version(Some(env!("CARGO_PKG_VERSION"))).build()),
    )?;
    let help = SubmenuBuilder::new(app, t("帮助", "Help"))
        .item(&whats_new)
        .item(&cheatsheet)
        .item(&check_updates)
        .separator()
        .item(&about)
        .build()?;

    let mut builder = MenuBuilder::new(app).item(&menu).item(&file).item(&edit).item(&view).item(&theme);
    if is_mac {
        let window_menu = SubmenuBuilder::new(app, t("窗口", "Window"))
            .item(&PredefinedMenuItem::minimize(app, Some(t("最小化", "Minimize")))?)
            .item(&PredefinedMenuItem::maximize(app, Some(t("缩放", "Zoom")))?)
            .separator()
            .item(&PredefinedMenuItem::close_window(app, Some(t("关闭窗口", "Close Window")))?)
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
        "edit-find" => emit("editor:search", None),
        "view-file-panel" => emit("toggle-file-panel", None),
        "view-source-mode" => emit("toggle-source-mode", None),
        "view-font-settings" => emit("open-font-settings", None),
        "view-slideshow" => emit("menu-play-slideshow", None),
        "help-whats-new" => crate::bundled::open(app, "changelog.md"),
        "help-cheatsheet" => crate::bundled::open_cheatsheet(app),
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
