// Opening windows and documents.
//
// Electron created a BrowserWindow per document when the user asked for one
// (File → New, File → New Window) and reused an empty one when a document arrived
// from outside. The same rules apply here; the difference is that Tauri needs the
// window's chrome spelled out for windows created at runtime.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::windowstate::{self, Bounds};

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

// ─── 验收窗口的尺寸与位置 ────────────────────────────────────────────────────
//
// 验收脚本（COLAMD_VERIFY）量的是整篇文档，而 CodeMirror 只为**视口内**的行建 DOM。
// 夹具比一屏长，窗口不够高的话下半段根本不渲染，那些规则就会被误判成「命中不到任何
// 元素」。旧脚本是走 CDP 的 Emulation.setDeviceMetricsOverride 把视口拉到 2600 高，
// 系统 WebView 没有这个调用，所以退而求其次：验收运行时把窗口本身开得足够高。
//
// 宽度沿用 1200，与上游那次 overrride 一致；高度 2600 是上游实测够用的值，留到 2800。
// 这只是高度，不是面积问题：一个 2800 高的窗口在任何显示器上都放得下（放不下也不会
// 被裁剪，视口高度由窗口自己的尺寸决定，不受屏幕限制）。
const VERIFY_WINDOW_WIDTH: f64 = 1200.0;
const VERIFY_WINDOW_HEIGHT: f64 = 2800.0;

/// 验收窗口放哪：屏幕外，但仍然**可见**。
///
/// 为什么不是 `visible(false)`：隐藏的窗口收不到绘制，基于截图的验收会永远卡住
/// （上游 1e9b481 学到的）。所以是「可见但没人看得见」——移到 -100000 去。
/// 让它彻底离开所有显示器，验收时也不抢用户的屏幕。
const VERIFY_WINDOW_X: f64 = -100_000.0;
const VERIFY_WINDOW_Y: f64 = -100_000.0;

/// 验收运行时要把窗口改成什么样；不是验收运行就是 None。
fn verify_geometry() -> Option<Bounds> {
    std::env::var("COLAMD_VERIFY").ok()?;
    Some(Bounds {
        x: VERIFY_WINDOW_X,
        y: VERIFY_WINDOW_Y,
        width: VERIFY_WINDOW_WIDTH,
        height: VERIFY_WINDOW_HEIGHT,
    })
}

/// A window whose zoom should follow the saved preference, if any.
pub struct CreatedWindow {
    pub window: WebviewWindow,
    pub zoom: Option<f64>,
}

/// The chrome every window gets: one row of our own, with the system controls drawn
/// inside it. Geometry is passed in rather than applied afterwards, because a window
/// resized after creation re-lays-out its title bar and the traffic lights move with
/// it, and Tauri can only place them on the builder (2026-10-09).
fn configure(
    builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>,
    geometry: Option<Bounds>,
) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    let (width, height) = geometry.map(|b| (b.width, b.height)).unwrap_or((960.0, 720.0));
    let mut builder = builder
        .inner_size(width, height)
        .min_inner_size(600.0, 400.0)
        .title("loomark");
    if let Some(bounds) = geometry {
        builder = builder.position(bounds.x, bounds.y);
    }
    // `title_bar_style` and friends are macOS-only methods, so gate them at
    // compile time rather than with a runtime `cfg!()` check: `cfg!()` still
    // compiles the branch, which breaks non-macOS targets (2026-10-10).
    #[cfg(target_os = "macos")]
    {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // 18, not the 10 the Electron build used. Electron's value is the top of
            // the button frame; tao's is the distance from the window's top to the
            // lights' centre (it grows the title bar container to `button height + y`,
            // and the buttons centre in it). A 36-point row puts the centre at 18.
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0))
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

/// The window the app starts with, sized and placed where it was left last time.
pub fn create_main_window(app: &AppHandle) -> Option<CreatedWindow> {
    let saved = windowstate::saved_geometry(app);
    // 验收运行时尺寸与位置由 `verify_geometry()` 说了算，不还原上次的窗口状态：
    // 用户上次把窗口拖到哪、开多大，跟这次要量的东西无关，还原回来只会让视口高度
    // 随机（而这一项验收对高度敏感，见上面那段注释）。
    let geometry = verify_geometry().or_else(|| saved.map(|(bounds, _)| bounds));
    let zoom = saved.and_then(|(_, zoom)| zoom);
    let builder = configure(
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())),
        geometry,
    );
    match builder.build() {
        Ok(window) => Some(CreatedWindow { window, zoom }),
        Err(error) => {
            crate::trace::trace(|| format!("could not create the main window: {error}"));
            None
        }
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
            configure(
                WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into())),
                None,
            )
            .inner_size(size.width as f64 / scale, size.height as f64 / scale)
        }
        None => configure(WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into())), None),
    };
    match builder.build() {
        Ok(window) => {
            let _ = window.set_focus();
            crate::trace::trace(|| format!("opened window {label}"));
        }
        Err(error) => crate::trace::trace(|| format!("could not open window {label}: {error}")),
    }
}

/// Open a document: into this window when it is empty, otherwise as a new tab.
pub fn open_document(app: &AppHandle, window: Option<tauri::WebviewWindow>, path: PathBuf) {
    let Some(window) = window.or_else(|| app.get_webview_window("main")) else {
        return;
    };
    let ctx = app.state::<crate::commands::AppCtx>();
    let has_file = ctx.doc(window.label()).lock().expect("doc lock").file_path.is_some();
    crate::trace::trace(|| {
        format!(
            "open_document: window {} has_file={has_file}, path={}",
            window.label(),
            path.display()
        )
    });
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
