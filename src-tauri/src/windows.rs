// Opening windows and documents.
//
// Electron created a BrowserWindow per document when the user asked for one
// (File → New, File → New Window) and reused an empty one when a document arrived
// from outside. The same rules apply here; the difference is that Tauri needs the
// window's chrome spelled out for windows created at runtime.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

/// The window chrome the config declares for `main`, applied to runtime windows too:
/// one row of our own, with the system controls drawn inside it.
fn configure(
    builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    let builder = builder
        .inner_size(960.0, 720.0)
        .min_inner_size(600.0, 400.0)
        .title("ColaMD");
    if cfg!(target_os = "macos") {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // 22, not the 10 the Electron build used: Electron's value is the offset
            // of the button frame's top, while tao's is the space it leaves *below*
            // the buttons (its title bar container is `button height + y` tall and the
            // buttons centre in it). With 10 the lights sat 6 points high in our
            // 36-point row (2026-10-09).
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 22.0))
    } else {
        builder
    }
}

/// A window with no document in it.
pub fn open_untitled_window(app: &AppHandle) {
    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let builder = match app.get_webview_window("main") {
        Some(main) => {
            // Inherit the focused window's size, so a second window does not jump.
            let size = main.inner_size().unwrap_or(tauri::PhysicalSize::new(960, 720));
            let scale = main.scale_factor().unwrap_or(1.0);
            configure(WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into())))
                .inner_size(size.width as f64 / scale, size.height as f64 / scale)
        }
        None => configure(WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))),
    };
    match builder.build() {
        Ok(window) => {
            let _ = window.set_focus();
            crate::trace::trace(|| format!("opened window {label}"));
        }
        Err(error) => crate::trace::trace(|| format!("could not open window {label}: {error}")),
    }
}

/// A window showing text that has no file behind it (the changelog, the cheatsheet).
pub fn open_memory_window(app: &AppHandle, content: String, browse_dir: Option<PathBuf>) {
    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let builder = configure(WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into())));
    let Ok(window) = builder.build() else {
        crate::trace::trace(|| format!("could not open window {label}"));
        return;
    };

    if let Some(dir) = browse_dir {
        let ctx = app.state::<crate::commands::AppCtx>();
        let doc = ctx.doc(&label);
        doc.lock().expect("doc lock").browse_path = Some(dir);
    }

    // The renderer registers its listeners during init, and a window that never
    // reports readiness would otherwise stay blank, so the document is handed over
    // after a short grace period.
    let payload = serde_json::json!({ "path": null, "content": content });
    let emitter = window.clone();
    // Give the page a moment to finish init before handing it the document; the
    // renderer's ready signal is the reliable trigger, and this is the fallback for
    // windows that never report one.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let _ = emitter.emit("file-opened", payload);
    });
    let _ = window.set_focus();
}

/// Open a document: into this window when it is empty, otherwise as a new tab.
pub fn open_document(app: &AppHandle, window: Option<tauri::WebviewWindow>, path: PathBuf) {
    let Some(window) = window.or_else(|| app.get_webview_window("main")) else {
        return;
    };
    let ctx = app.state::<crate::commands::AppCtx>();
    let has_file = ctx.doc(window.label()).lock().expect("doc lock").file_path.is_some();
    if has_file {
        let _ = window.emit("open-in-new-tab", path.to_string_lossy().to_string());
        return;
    }
    let app = app.clone();
    let target = window.clone();
    tauri::async_runtime::spawn(async move {
        let ctx = app.state::<crate::commands::AppCtx>();
        if crate::commands::load_path_into(&app, &target, &ctx, &path).await.is_some() {
            crate::trace::trace(|| format!("opened {} into the window focused at the time", path.display()));
        }
    });
    let _ = window.set_focus();
}
