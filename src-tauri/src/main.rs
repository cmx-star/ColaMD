// loomark's Tauri shell.
//
// The renderer is the same code the Electron build ran (src/renderer), reached
// through one adapter that presents the `ElectronAPI` shape on top of these
// commands. What lives here is the part Electron's main process did: document IO,
// the watcher, the close guard, menus, exports and the update flow.
//
// Stage by stage progress and the acceptance check for each stage:
// docs/tauri-migration-plan.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod conflict;
mod contextmenu;
mod contextmenu_actions;
mod export;
mod fileio;
mod fonts;
mod i18n;
mod menu;
mod paths;
mod recent;
mod recovery;
mod state;
mod themes;
mod trace;
mod watcher;
mod windowstate;
mod windows;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager, WindowEvent};

/// What the menu needs to know to draw its check marks. The renderer owns these
/// choices and reports them; the menu shows the answer.
#[derive(Default)]
pub struct MenuState {
    theme: Mutex<String>,
    panel_side: Mutex<String>,
    page_width: Mutex<String>,
    /// View zoom per window label, so the menu can step from the current factor.
    zoom: Mutex<std::collections::HashMap<String, f64>>,
    /// The window the user was last working in. A menu accelerator fires without
    /// naming a window, and at that instant none of them may report focus, so the
    /// last known one is what the event belongs to (the Electron build kept the
    /// same thing in `focusedOrLastWindow()`).
    last_focused: Mutex<Option<String>>,
}

impl MenuState {
    pub fn snapshot(&self) -> (String, String, String) {
        (
            self.theme.lock().expect("theme").clone(),
            self.panel_side.lock().expect("panel side").clone(),
            self.page_width.lock().expect("page width").clone(),
        )
    }

    /// Returns true when the value actually moved, which is when the menu is stale.
    pub fn set_theme(&self, theme: &str) -> bool {
        let mut current = self.theme.lock().expect("theme");
        if *current == theme {
            return false;
        }
        *current = theme.to_string();
        true
    }

    pub fn set_panel_side(&self, side: &str) -> bool {
        let mut current = self.panel_side.lock().expect("panel side");
        if *current == side {
            return false;
        }
        *current = side.to_string();
        true
    }

    /// Step the zoom for a window. `chromium_steps` are the levels a browser uses;
    /// stepping by a fixed amount instead would drift away from them.
    pub fn step_zoom(&self, label: &str, direction: i32) -> f64 {
        const LEVELS: [f64; 13] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
        let mut zoom = self.zoom.lock().expect("zoom");
        let current = *zoom.get(label).unwrap_or(&1.0);
        let index = LEVELS.iter().position(|level| (*level - current).abs() < 0.001).unwrap_or(5) as i32;
        let next = (index + direction).clamp(0, LEVELS.len() as i32 - 1) as usize;
        let value = LEVELS[next];
        zoom.insert(label.to_string(), value);
        value
    }

    /// Adopt a zoom factor restored from the window-state file, so the next save
    /// writes back what the user had rather than the default.
    pub fn set_zoom(&self, label: &str, factor: f64) {
        self.zoom.lock().expect("zoom").insert(label.to_string(), factor);
    }

    /// The zoom this window is at, for the window-state file.
    pub fn current_zoom(&self, label: &str) -> f64 {
        *self.zoom.lock().expect("zoom").get(label).unwrap_or(&1.0)
    }

    pub fn reset_zoom(&self, label: &str) -> f64 {
        self.zoom.lock().expect("zoom").insert(label.to_string(), 1.0);
        1.0
    }

    pub fn remember_focus(&self, label: &str) {
        *self.last_focused.lock().expect("last focused") = Some(label.to_string());
    }

    pub fn last_focused(&self) -> Option<String> {
        self.last_focused.lock().expect("last focused").clone()
    }

    pub fn set_page_width(&self, width: &str) -> bool {
        let mut current = self.page_width.lock().expect("page width");
        if *current == width {
            return false;
        }
        *current = width.to_string();
        true
    }
}

/// A document handed to the app before the renderer could listen: a launch argument
/// (file association, `loomark note.md`) or a second launch. Held until the renderer
/// says it is ready, which is the same handshake the Electron build used.
#[derive(Default)]
pub struct StartupFiles {
    queued: std::sync::Mutex<Vec<PathBuf>>,
}

impl StartupFiles {
    pub fn push(&self, path: PathBuf) {
        self.queued.lock().expect("startup queue").push(path);
    }

    pub fn drain(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.queued.lock().expect("startup queue"))
    }
}

/// Which windows have reported readiness. A document that arrives before that (from
/// the Finder, or from a launch argument) has to wait, because the renderer only
/// starts listening at the end of its init.
#[derive(Default)]
pub struct ReadyWindows {
    ready: Mutex<std::collections::HashSet<String>>,
}

impl ReadyWindows {
    pub fn mark_ready(&self, label: &str) {
        self.ready.lock().expect("ready set").insert(label.to_string());
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.ready.lock().expect("ready set").contains(label)
    }
}

/// A path from the command line, if there is one that exists.
fn path_from_args() -> Option<PathBuf> {
    std::env::args()
        .skip(1)
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // A second launch (double-clicking a file, `open -a loomark note.md`) hands
        // its files to the window that is already running instead of starting a
        // second copy of the app.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files: Vec<PathBuf> = argv.iter().skip(1).map(PathBuf::from).filter(|path| path.is_file()).collect();
            if files.is_empty() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                for file in files {
                    let _ = window.emit("open-in-new-tab", file.to_string_lossy().to_string());
                }
                let _ = window.set_focus();
            }
        }))
        .manage(commands::AppCtx::default())
        .manage(StartupFiles::default())
        .manage(ReadyWindows::default())
        .manage(windowstate::Saver::default())
        .manage(MenuState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::open_file_path,
            commands::activate_file,
            commands::list_siblings,
            commands::list_directory,
            commands::open_sibling,
            commands::set_tab_files,
            commands::save_file,
            commands::save_file_as,
            commands::report_external_conflict,
            commands::reveal_file,
            commands::reveal_path,
            commands::open_external,
            commands::report_dirty,
            commands::verify_report,
            commands::show_entry_context_menu,
            commands::show_tab_context_menu,
            commands::confirm_discard_tab,
            commands::renderer_ready,
            commands::log_renderer_error,
            commands::report_theme,
            commands::report_panel_side,
            commands::report_page_width,
            commands::report_titlebar_colors,
            commands::document_state_response,
            commands::request_close_window,
            themes::load_theme_css,
            themes::load_custom_theme,
            fonts::list_system_fonts,
            fonts::set_editor_font,
            fonts::set_slideshow_fullscreen,
            fonts::popup_app_menu,
            export::export_html,
        ])
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .setup(|app| {
            if let Some(path) = path_from_args() {
                app.state::<StartupFiles>().push(path);
            }
            menu::build(app.handle());
            // The main window is created here rather than declared in the config, so it
            // can be born at the size and position it had last time. Applying those
            // afterwards would re-lay-out the title bar and move the traffic lights.
            if let Some(created) = windows::create_main_window(app.handle()) {
                if let Some(zoom) = created.zoom {
                    windowstate::apply_zoom(&created.window, zoom);
                    app.state::<MenuState>().set_zoom(created.window.label(), zoom);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                window.app_handle().state::<MenuState>().remember_focus(window.label());
            }
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                let app = window.app_handle();
                let zoom = app.state::<MenuState>().current_zoom(window.label());
                app.state::<windowstate::Saver>().schedule(window, zoom);
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Never let the window go before the close guard has run: it is what
                // stops unsaved work from disappearing.
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    if commands::confirm_close(&window).await {
                        // Remember where this window was before it goes.
                        let app = window.app_handle();
                        let zoom = app.state::<MenuState>().current_zoom(window.label());
                        app.state::<windowstate::Saver>().save_now(&window, zoom);
                        let _ = window.destroy();
                    }
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building loomark")
        .run(|app, event| handle_run_event(app, event));
}

/// macOS 把「用本应用打开这个文件」作为 Apple Event 交给应用，Tauri 把它抛成
/// [`tauri::RunEvent::Opened`]，参数不在 argv 里。
///
/// 也就是说：Finder 双击 .md、拖到 Dock 图标、文件关联，走的都是这里，而不是
/// `path_from_args()`。少了这一条，那些入口打开的文件根本不会出现在窗口里
/// （2026-10-09 发现）。
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    {
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls {
                let Ok(path) = url.to_file_path() else {
                    crate::trace::trace(|| format!("opened url is not a file path: {url}"));
                    continue;
                };
                // The Finder can hand a document over before the renderer is ready,
                // and an event nobody is listening for is a document that never
                // appears. Queue it for the window that is still starting up.
                let target = app
                    .webview_windows()
                    .into_values()
                    .find(|window| window.is_focused().unwrap_or(false))
                    .or_else(|| app.get_webview_window("main"));
                let ready = app.state::<ReadyWindows>();
                match target {
                    Some(window) if ready.is_ready(window.label()) => {
                        crate::windows::open_document(app, Some(window), path);
                    }
                    _ => {
                        crate::trace::trace(|| format!("queued {} until the renderer is ready", path.display()));
                        app.state::<StartupFiles>().push(path);
                    }
                }
            }
        }
    }
    let _ = (app, event);
}
