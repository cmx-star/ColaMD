// The command surface the renderer talks to.
//
// Every command here has a counterpart in the Electron main process
// (src/main/index.ts), and the behaviour is meant to be indistinguishable: the same
// guards, the same refusals, the same dialogs. Where the port had to differ it is
// called out in a comment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::fileio::{self, SiblingFile};
use crate::i18n::t;
use crate::paths;
use crate::state::{Registry, SharedDoc};
use crate::trace::trace;
use crate::watcher::{self, Watchers};

/// Everything a command needs that is not the window itself.
#[derive(Default)]
pub struct AppCtx {
    pub registry: Registry,
    pub watchers: Watchers,
    /// Close-flow requests waiting on the renderer's snapshot, keyed by request id.
    pending_states: Mutex<HashMap<String, oneshot::Sender<DocumentSnapshot>>>,
    /// One close decision at a time per window: concurrent ⌘W presses must share a
    /// single prompt and a single save.
    close_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl AppCtx {
    pub fn doc(&self, label: &str) -> SharedDoc {
        self.registry.doc(label)
    }

    fn close_lock(&self, label: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.close_locks.lock().expect("close lock map");
        locks
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn park_request(&self, id: String, sender: oneshot::Sender<DocumentSnapshot>) {
        self.pending_states.lock().expect("pending map").insert(id, sender);
    }

    fn take_request(&self, id: &str) -> Option<oneshot::Sender<DocumentSnapshot>> {
        self.pending_states.lock().expect("pending map").remove(id)
    }
}

// --- payloads ---------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct OpenedDocument {
    pub path: Option<String>,
    pub content: String,
}

#[derive(Serialize, Clone)]
pub struct ActiveDocument {
    pub content: String,
    pub mtime: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResult {
    pub action: String,
    pub content: Option<String>,
    pub recovery_path: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct TabSnapshot {
    pub path: Option<String>,
    pub content: String,
}

#[derive(Deserialize, Clone)]
pub struct DocumentSnapshot {
    pub dirty: bool,
    pub content: String,
    #[serde(default)]
    pub tabs: Option<Vec<TabSnapshot>>,
}

/// Ask a question and report **which label was clicked**, matched by its text.
///
/// Matching on the label rather than on a button position is deliberate: rfd reports
/// the text, and a positional mapping had "cancel" and "discard" the wrong way round,
/// which threw unsaved work away (2026-10-09). Three of the questions below decide
/// whether content survives.
///
/// The button order follows what the platform does with the keyboard: the first
/// button is what Enter chooses, the second is what Escape chooses. Escape must never
/// destroy anything, so the second button is the safe one in every call.
async fn ask_label(title: &str, message: &str, labels: &[&str]) -> Option<String> {
    let buttons = match labels.len() {
        1 => rfd::MessageButtons::OkCustom(labels[0].to_string()),
        2 => rfd::MessageButtons::OkCancelCustom(labels[0].to_string(), labels[1].to_string()),
        _ => rfd::MessageButtons::YesNoCancelCustom(labels[0].to_string(), labels[1].to_string(), labels[2].to_string()),
    };
    match rfd::AsyncMessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(title)
        .set_description(message)
        .set_buttons(buttons)
        .show()
        .await
    {
        rfd::MessageDialogResult::Custom(label) => Some(label),
        _ => None,
    }
}

// --- opening ----------------------------------------------------------------

fn open_filters() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        ("Markdown", vec!["md", "markdown", "mdown", "mkd"]),
        ("Text", vec!["txt"]),
        ("All Files", vec!["*"]),
    ]
}

async fn pick_file(window: &WebviewWindow) -> Option<PathBuf> {
    let (sender, receiver) = oneshot::channel();
    let mut builder = window.dialog().file();
    for (name, extensions) in open_filters() {
        builder = builder.add_filter(name, &extensions);
    }
    builder.pick_file(move |picked| {
        let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
    });
    receiver.await.ok().flatten()
}

/// Read a document into this window: bind it, watch it, tell the renderer.
pub async fn load_path_into(app: &AppHandle, window: &WebviewWindow, ctx: &AppCtx, path: &Path) -> Option<OpenedDocument> {
    let data = fileio::read_document(path).ok()?;
    let doc = ctx.doc(window.label());
    {
        let mut state = doc.lock().expect("doc lock");
        state.file_path = Some(path.to_path_buf());
        state.browse_path = path.parent().map(Path::to_path_buf);
        state.last_internal_save_content = Some(data.content.clone());
        state.last_known_mtime = data.mtime;
    }
    install_watcher(window, ctx, path.to_path_buf());
    update_window_title(window, path);
    crate::recent::remember(path);
    let payload = OpenedDocument { path: Some(path.to_string_lossy().to_string()), content: data.content.clone() };
    trace(|| format!("opened {} ({} bytes)", path.display(), data.content.len()));
    let _ = window.emit("file-opened", payload.clone());
    let _ = app; // kept for symmetry with the Electron flow that also touches menus
    Some(payload)
}

fn install_watcher(window: &WebviewWindow, ctx: &AppCtx, path: PathBuf) {
    trace(|| format!("watching {}", path.display()));
    let doc = ctx.doc(window.label());
    let watcher = watcher::watch(window.clone(), doc, path);
    ctx.watchers.install(window.label(), watcher);
}

fn update_window_title(window: &WebviewWindow, path: &Path) {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "loomark".to_string());
    let _ = window.set_title(&format!("{name} — loomark"));
}

#[tauri::command]
pub async fn open_file(app: AppHandle, window: WebviewWindow, ctx: tauri::State<'_, AppCtx>) -> Result<Option<OpenedDocument>, String> {
    let Some(path) = pick_file(&window).await else {
        return Ok(None);
    };
    let has_file = ctx.doc(window.label()).lock().expect("doc lock").file_path.is_some();
    if has_file {
        // A window already holding a document opens the new one as a tab, which is
        // the renderer's job: it owns the tab strip.
        let _ = window.emit("open-in-new-tab", path.to_string_lossy().to_string());
        return Ok(None);
    }
    Ok(load_path_into(&app, &window, &ctx, &path).await)
}

#[tauri::command]
pub async fn open_file_path(app: AppHandle, window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, file_path: String) -> Result<Option<OpenedDocument>, String> {
    let path = PathBuf::from(&file_path);
    let has_file = ctx.doc(window.label()).lock().expect("doc lock").file_path.is_some();
    if has_file {
        let _ = window.emit("open-in-new-tab", file_path);
        return Ok(None);
    }
    Ok(load_path_into(&app, &window, &ctx, &path).await)
}

/// Point the window at another document without touching the renderer's content:
/// tabs keep their own editor state, so only the window's binding moves.
#[tauri::command]
pub async fn activate_file(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, file_path: Option<String>) -> Result<Option<ActiveDocument>, String> {
    let target = file_path.filter(|path| !path.is_empty()).map(PathBuf::from);
    let doc = ctx.doc(window.label());

    let Some(path) = target else {
        ctx.watchers.stop(window.label());
        let mut state = doc.lock().expect("doc lock");
        state.file_path = None;
        state.last_internal_save_content = None;
        state.last_known_mtime = 0;
        drop(state);
        let _ = window.set_title("loomark");
        return Ok(None);
    };

    let Ok(data) = fileio::read_document(&path) else {
        return Ok(None);
    };
    {
        let mut state = doc.lock().expect("doc lock");
        state.file_path = Some(path.clone());
        state.browse_path = path.parent().map(Path::to_path_buf);
        state.last_internal_save_content = Some(data.content.clone());
        state.last_known_mtime = data.mtime;
    }
    install_watcher(&window, &ctx, path.clone());
    update_window_title(&window, &path);
    crate::recent::remember(&path);
    Ok(Some(ActiveDocument { content: data.content, mtime: data.mtime }))
}

// --- listing ----------------------------------------------------------------

#[tauri::command]
pub async fn list_siblings(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>) -> Result<Vec<SiblingFile>, String> {
    let (file_path, browse_path) = {
        let doc = ctx.doc(window.label());
        let state = doc.lock().expect("doc lock");
        (state.file_path.clone(), state.browse_path.clone())
    };
    // With no document open the panel shows the default documents folder, which is
    // what the Electron build does with its initial browse path.
    let browse = browse_path.or_else(default_browse_dir);
    Ok(fileio::list_sibling_files(file_path.as_deref(), browse.as_deref()))
}

fn default_browse_dir() -> Option<PathBuf> {
    let dir = paths::home_dir().join("Documents");
    dir.is_dir().then_some(dir)
}

#[tauri::command]
pub async fn list_directory(dir_path: String) -> Result<Vec<SiblingFile>, String> {
    Ok(fileio::list_directory_children(Path::new(&dir_path)))
}

#[tauri::command]
pub async fn open_sibling(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, file_path: String) -> Result<bool, String> {
    let path = PathBuf::from(&file_path);
    let Ok(metadata) = std::fs::metadata(&path) else {
        return Ok(false);
    };
    let doc = ctx.doc(window.label());
    if metadata.is_dir() {
        let mut state = doc.lock().expect("doc lock");
        state.browse_path = Some(path.clone());
        let file_path = state.file_path.clone();
        let browse = state.browse_path.clone();
        drop(state);
        let files = fileio::list_sibling_files(file_path.as_deref(), browse.as_deref());
        let _ = window.emit("siblings-changed", files);
        return Ok(true);
    }
    {
        let state = doc.lock().expect("doc lock");
        // Already open in another tab: focus it instead of loading it twice.
        if state.tab_files.iter().any(|open| open == &file_path) && state.file_path.as_deref() != Some(path.as_path()) {
            drop(state);
            let _ = window.emit("focus-file", file_path);
            return Ok(true);
        }
    }
    let app = window.app_handle().clone();
    Ok(load_path_into(&app, &window, &ctx, &path).await.is_some())
}

#[tauri::command]
pub async fn set_tab_files(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, paths: Vec<String>) -> Result<(), String> {
    let doc = ctx.doc(window.label());
    doc.lock().expect("doc lock").tab_files = paths;
    Ok(())
}

// --- saving -----------------------------------------------------------------

/// Write `content` to `path`, remembering it so the watcher can skip our own echo.
async fn write_and_remember(doc: &SharedDoc, path: &Path, content: &str) -> bool {
    let lock = Arc::clone(&doc.lock().expect("doc lock").save_lock);
    let _serialized = lock.lock().await;

    {
        let mut state = doc.lock().expect("doc lock");
        state.internal_save_depth += 1;
    }

    let written = fileio::write_document(path, content);
    let ok = match written {
        Ok(mtime) => {
            let mut state = doc.lock().expect("doc lock");
            state.remember_save(&path.to_path_buf(), content, mtime);
            true
        }
        Err(_) => false,
    };

    // Our own write echoes back through the filesystem well after this returns, so
    // the flag is held a moment past the write.
    let doc = Arc::clone(doc);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let mut state = doc.lock().expect("doc lock");
        state.internal_save_depth = state.internal_save_depth.saturating_sub(1);
    });

    ok
}

fn save_dialog<W, R>(parent: &W, file_path: Option<&Path>, content: &str) -> Option<PathBuf>
where
    R: tauri::Runtime,
    W: DialogExt<R>,
{

    let suggested = fileio::suggest_file_name(file_path, Some(content)).unwrap_or_else(|| "Untitled".to_string());
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut builder = parent
        .dialog()
        .file()
        .set_title(t("保存 Markdown 文档", "Save Markdown document"))
        .set_file_name(&format!("{suggested}.md"))
        .add_filter("Markdown", &["md"])
        .add_filter("All Files", &["*"]);
    if let Some(parent) = file_path.and_then(|path| path.parent()) {
        builder = builder.set_directory(parent);
    }
    crate::trace::trace(|| "save dialog shown".to_string());
    builder.save_file(move |picked| {
        let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
    });
    let chosen = receiver.recv_timeout(std::time::Duration::from_secs(600)).ok().flatten();
    match &chosen {
        Some(path) => crate::trace::trace(|| format!("save dialog chose {}", path.display())),
        None => crate::trace::trace(|| "save dialog cancelled".to_string()),
    }
    chosen
}

#[tauri::command]
pub async fn save_file(
    window: WebviewWindow,
    ctx: tauri::State<'_, AppCtx>,
    content: String,
    expected_path: Option<String>,
    autosave: Option<bool>,
) -> Result<Option<String>, String> {
    let doc = ctx.doc(window.label());
    let (source_path, current_path) = {
        let state = doc.lock().expect("doc lock");
        (state.file_path.clone(), state.file_path.clone())
    };

    // The caller states which document this content belongs to. Comparing strictly
    // is what stops a save from landing in whatever file the window opened last.
    if let Some(expected) = &expected_path {
        let expected = if expected.is_empty() { None } else { Some(PathBuf::from(expected)) };
        if expected != source_path {
            return Ok(None);
        }
    }

    let file_path = match current_path {
        Some(path) => path,
        None => match {
            let _ = window.set_focus();
            save_dialog(&window, source_path.as_deref(), &content)
        } {
            Some(path) => path,
            None => return Ok(None),
        },
    };

    // Auto-save never overwrites an edit that landed after our last read or write:
    // the watcher can miss it (an event during our own write is dropped as a
    // self-echo), so probe the mtime and let the user decide instead. A manual
    // save keeps the old behaviour, because the user asked for it explicitly.
    if autosave.unwrap_or(false) {
        let changed = {
            let state = doc.lock().expect("doc lock");
            state.changed_externally(&file_path)
        };
        if changed {
            trace(|| format!("autosave refused: {} changed on disk", file_path.display()));
            crate::conflict::notify_external_change(&window, &file_path);
            return Ok(None);
        }
    }

    if write_and_remember(&doc, &file_path, &content).await {
        update_window_title(&window, &file_path);
        crate::recent::remember(&file_path);
        trace(|| format!("saved {} ({} bytes)", file_path.display(), content.len()));
        Ok(Some(file_path.to_string_lossy().to_string()))
    } else {
        trace(|| format!("save failed for {}", file_path.display()));
        Ok(None)
    }
}

#[tauri::command]
pub async fn save_file_as(
    window: WebviewWindow,
    ctx: tauri::State<'_, AppCtx>,
    content: String,
    expected_path: Option<String>,
) -> Result<Option<String>, String> {
    let doc = ctx.doc(window.label());
    let source_path = { doc.lock().expect("doc lock").file_path.clone() };
    if let Some(expected) = &expected_path {
        let expected = if expected.is_empty() { None } else { Some(PathBuf::from(expected)) };
        if expected != source_path {
            return Ok(None);
        }
    }
    let _ = window.set_focus();
    let Some(target) = save_dialog(&window, source_path.as_deref(), &content) else {
        return Ok(None);
    };
    if write_and_remember(&doc, &target, &content).await {
        update_window_title(&window, &target);
        crate::recent::remember(&target);
        Ok(Some(target.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

// --- external conflict ------------------------------------------------------

/// The one action in this app that can throw unsaved input away for good, so the
/// version being dropped is written down first and only then loaded over
/// (PRINCIPLES.md, 用户数据不可丢).
#[tauri::command]
pub async fn report_external_conflict(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, local_content: String) -> Result<(), String> {
    trace(|| format!("renderer reports a conflict ({} bytes of local work)", local_content.len()));
    let doc = ctx.doc(window.label());
    let file_path = { doc.lock().expect("doc lock").file_path.clone() };

    let loaded = match file_path.clone() {
        Some(path) => fileio::read_document(&path).ok(),
        None => None,
    };

    let keep = t("保留我的版本（继续编辑）", "Keep my version (keep editing)").to_string();
    let load = t("加载磁盘上的版本（我的内容会存成恢复文件）", "Load the version on disk (my version is kept as a recovery file)").to_string();
    let answer = ask_label(
        t("未保存的修改与外部修改冲突", "Unsaved changes conflict with an external edit"),
        t(
            "磁盘上的文件已被其他程序修改，而你正在编辑的内容还没保存。请选择保留哪个版本。",
            "The file on disk was changed by another program while your edits were unsaved. Choose which version to keep.",
        ),
        &[&keep, &load, t("取消", "Cancel")],
    )
    .await;

    if answer.as_deref() != Some(load.as_str()) {
        let _ = window.emit(
            "external-conflict-result",
            ConflictResult { action: "keep".to_string(), content: None, recovery_path: None },
        );
        return Ok(());
    }

    let Some(data) = loaded else {
        let _ = window.emit(
            "external-conflict-result",
            ConflictResult { action: "keep".to_string(), content: None, recovery_path: None },
        );
        return Ok(());
    };

    match crate::recovery::keep_recovered_copy(file_path.as_deref(), &local_content) {
        Some(recovery_path) => {
            {
                let mut state = doc.lock().expect("doc lock");
                state.last_internal_save_content = Some(data.content.clone());
                state.last_known_mtime = data.mtime;
            }
            let _ = window.emit(
                "external-conflict-result",
                ConflictResult {
                    action: "load".to_string(),
                    content: Some(data.content),
                    recovery_path: Some(recovery_path.to_string_lossy().to_string()),
                },
            );
        }
        // No recovery copy means nothing may be discarded: keep the editor version.
        None => {
            let _ = window.emit(
                "external-conflict-result",
                ConflictResult { action: "keep".to_string(), content: None, recovery_path: None },
            );
        }
    }
    Ok(())
}

// --- shell reporting --------------------------------------------------------

/// Hand an external URL to the system's default browser.
///
/// The renderer used to call `window.open`, which the webview either blocks or
/// answers with an empty window: a link in a document did nothing (2026-10-09).
/// Only the schemes `opener:default` covers get through, so a `file:` or a
/// script URL cannot reach the shell this way.
#[tauri::command]
pub async fn open_external(window: WebviewWindow, url: String) -> Result<bool, String> {
    let lowered = url.trim().to_ascii_lowercase();
    let allowed = ["http://", "https://", "mailto:", "tel:"];
    if !allowed.iter().any(|scheme| lowered.starts_with(scheme)) {
        return Ok(false);
    }
    Ok(window.app_handle().opener().open_url(url, None::<&str>).is_ok())
}

#[tauri::command]
pub async fn reveal_file(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>) -> Result<bool, String> {
    let path = { ctx.doc(window.label()).lock().expect("doc lock").file_path.clone() };
    let Some(path) = path else { return Ok(false) };
    Ok(window.app_handle().opener().reveal_item_in_dir(&path).is_ok())
}

/// The renderer names a path it was just told about; only our own recovery folder
/// is allowed through.
#[tauri::command]
pub async fn reveal_path(window: WebviewWindow, target: String) -> Result<bool, String> {
    let resolved = std::fs::canonicalize(&target).unwrap_or_else(|_| PathBuf::from(&target));
    let recovery_root = std::fs::canonicalize(paths::recovery_dir()).unwrap_or_else(|_| paths::recovery_dir());
    if !resolved.starts_with(&recovery_root) {
        return Ok(false);
    }
    Ok(window.app_handle().opener().reveal_item_in_dir(&resolved).is_ok())
}

#[tauri::command]
pub async fn report_dirty(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, is_dirty: bool) -> Result<(), String> {
    let doc = ctx.doc(window.label());
    doc.lock().expect("doc lock").dirty = is_dirty;
    Ok(())
}

/// Ask before throwing unsaved content away. Anything other than an explicit
/// "discard" answers false, because the safe direction for this question is to keep
/// the content (PRINCIPLES.md, 用户数据不可丢).
#[tauri::command]
pub async fn confirm_discard_tab(window: WebviewWindow, message: String) -> Result<bool, String> {
    trace(|| format!("asked: discard an unsaved tab? ({})", window.label()));
    let discard = t("丢弃", "Discard").to_string();
    let answer = ask_label(
        t("未保存的标签页", "Unsaved tab"),
        &message,
        &[&discard, t("取消", "Cancel")],
    )
    .await;
    // Only the label that says "Discard" discards; Escape, the window's close button
    // and any other outcome keep the content.
    Ok(answer.as_deref() == Some(discard.as_str()))
}

/// The verification channel, used by the acceptance scripts (scripts/verify-*.mjs).
///
/// They used to drive the app over the Chrome DevTools protocol. No system WebView
/// offers that, so the shell reads the check *name* from COLAMD_VERIFY, hands it to
/// the renderer (the checks are bundled there; a page cannot eval, its CSP forbids it),
/// and writes the renderer's answer to COLAMD_VERIFY_OUT.
/// Right-click on a file panel entry.
#[tauri::command]
pub async fn show_entry_context_menu(window: WebviewWindow, path: String, kind: String) -> Result<(), String> {
    let app = window.app_handle().clone();
    crate::contextmenu::show_entry(&app, &window, &path, &kind).map_err(|error| error.to_string())
}

/// Right-click on a tab.
#[tauri::command]
pub async fn show_tab_context_menu(window: WebviewWindow, payload: serde_json::Value) -> Result<(), String> {
    let app = window.app_handle().clone();
    let tab_id = payload.get("tabId").and_then(|value| value.as_str()).unwrap_or_default();
    if tab_id.is_empty() {
        return Ok(());
    }
    let file_path = payload.get("filePath").and_then(|value| value.as_str());
    let can_close_others = payload.get("canCloseOthers").and_then(|value| value.as_bool()).unwrap_or(false);
    let can_close_right = payload.get("canCloseRight").and_then(|value| value.as_bool()).unwrap_or(false);
    crate::contextmenu::show_tab(&app, &window, tab_id, file_path, can_close_others, can_close_right)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn verify_report(payload: String) -> Result<(), String> {
    let path = std::env::var("COLAMD_VERIFY_OUT").map_err(|_| "COLAMD_VERIFY_OUT is not set".to_string())?;
    std::fs::write(&path, payload).map_err(|error| error.to_string())?;
    trace(|| format!("verify report written to {path}"));
    Ok(())
}

fn hand_over_verify_probe(window: &WebviewWindow) {
    let Ok(name) = std::env::var("COLAMD_VERIFY") else {
        return;
    };
    trace(|| format!("verify check requested: {name}"));
    let _ = window.emit("verify-run", name);
}

#[tauri::command]
pub async fn log_renderer_error(message: String) {
    use std::io::Write;
    let path = paths::renderer_error_log();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamp = chrono_like_now();
    let line = format!("[{stamp}] {}\n", message.chars().take(8000).collect::<String>());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Timestamps in the log are for humans reading the file later; the format matches
/// the Electron build (ISO 8601, UTC).
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
        duration.subsec_millis()
    )
}

/// Howard Hinnant's days-from-civil, inverted. Small enough to keep locally rather
/// than take a date-time dependency for one log line.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// --- the close guard --------------------------------------------------------

async fn request_document_state(window: &tauri::Window, timeout: std::time::Duration) -> Option<DocumentSnapshot> {
    let ctx = window.state::<AppCtx>();
    let id = format!("{}-{}", window.label(), fileio::now_ms());
    let (sender, receiver) = oneshot::channel();
    ctx.park_request(id.clone(), sender);
    let _ = window.emit("request-document-state", id);
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(snapshot)) => Some(snapshot),
        _ => None,
    }
}

#[tauri::command]
pub async fn document_state_response(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, request_id: String, snapshot: DocumentSnapshot) -> Result<(), String> {
    if let Some(sender) = ctx.take_request(&request_id) {
        let _ = sender.send(snapshot);
    }
    let _ = window;
    Ok(())
}

/// Called by the window's CloseRequested handler; `true` lets the window go.
pub async fn confirm_close(window: &tauri::Window) -> bool {
    let ctx = window.state::<AppCtx>();
    let lock = ctx.close_lock(window.label());
    let _serialized = lock.lock().await;

    let doc = ctx.doc(window.label());

    let Some(snapshot) = request_document_state(window, std::time::Duration::from_millis(1500)).await else {
        // The renderer is unresponsive: it cannot report state or save anything, so
        // blocking forever would trap the user. Offer an explicit escape instead.
        let close_anyway = t("仍要关闭", "Close anyway").to_string();
        let answer = ask_label(
            t("仍要关闭？", "Close anyway?"),
            t(
                "窗口可能已停止响应，无法确认是否有未保存的修改。强行关闭可能丢失内容。",
                "The window is not responding, so unsaved changes cannot be checked. Closing it may lose content.",
            ),
            &[&close_anyway, t("取消", "Cancel")],
        )
        .await;
        return answer.as_deref() == Some(close_anyway.as_str());
    };

    if !snapshot.dirty {
        trace(|| "close allowed: nothing unsaved".to_string());
        return true;
    }
    trace(|| "close guard: unsaved changes, asking".to_string());

    let detail = match { doc.lock().expect("doc lock").file_path.clone() } {
        Some(path) => format!(
            "{}",
            t(
                &format!("“{}” 有未保存的修改。", file_name_of(&path)),
                &format!("“{}” has unsaved changes.", file_name_of(&path)),
            )
        ),
        None => t("当前未命名文档有未保存的修改。", "The current untitled document has unsaved changes.").to_string(),
    };

    let choice = rfd::AsyncMessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(t("未保存的修改", "Unsaved changes"))
        .set_description(&detail)
        .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
            t("保存", "Save").to_string(),
            t("不保存", "Don't Save").to_string(),
            t("取消", "Cancel").to_string(),
        ))
        .show()
        .await;

    match choice {
        rfd::MessageDialogResult::Cancel => return false,
        rfd::MessageDialogResult::No => return true,
        _ => {}
    }

    let source_path = { doc.lock().expect("doc lock").file_path.clone() };
    let file_path = match source_path.clone() {
        Some(path) => path,
        None => match {
            let _ = window.set_focus();
            save_dialog(window, None, &snapshot.content)
        } {
            Some(path) => path,
            None => return false,
        },
    };

    // Background tabs are not the window's active document, so they bypass the
    // active-file guards and are written straight to their own paths. An untitled
    // background tab cannot be written without a dialog, so it is reported instead
    // of being dropped silently.
    let tabs = snapshot.tabs.clone().unwrap_or_default();
    for tab in tabs.iter().filter(|tab| tab.path.is_some() && tab.path != path_to_string(&source_path)) {
        let path = PathBuf::from(tab.path.clone().unwrap_or_default());
        if std::fs::write(&path, &tab.content).is_err() {
            window
                .dialog()
                .message(format!(
                    "{}",
                    t(
                        &format!("“{}” 写入失败，为保护内容已取消关闭。", file_name_of(&path)),
                        &format!("Writing “{}” failed, so closing was cancelled to protect the content.", file_name_of(&path)),
                    )
                ))
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::Ok)
                .blocking_show();
            return false;
        }
    }

    let untitled_tabs = tabs.iter().filter(|tab| tab.path.is_none()).count();
    if untitled_tabs > 0 {
        // This one only explains. It is the only dialog that would discard several
        // documents at once, so it offers no single button that does it: the user
        // saves or discards each tab (each has its own guard) and closes again.
        // Electron allowed "discard untitled tabs" here; dropping that button removes
        // the one path that could lose more than the document in front of the user.
        ask_label(
            t("还有未命名的标签页没有保存", "Some untitled tabs are still unsaved"),
            t(
                "关闭窗口会丢掉它们里的内容。请先切到那些标签页保存，或逐个关闭它们。",
                "Closing the window would lose their content. Switch to those tabs and save them, or close them one by one.",
            ),
            &[t("知道了", "OK")],
        )
        .await;
        return false;
    }

    if !write_and_remember(&doc, &file_path, &snapshot.content).await {
        window
            .dialog()
            .message(t(
                "为保护未保存的内容，已取消关闭。请检查文件权限和可用磁盘空间。",
                "Closing was cancelled to protect the unsaved content. Check file permissions and free disk space.",
            ))
            .title(t("无法保存文档", "Could not save the document"))
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show();
        return false;
    }

    true
}

fn path_to_string(path: &Option<PathBuf>) -> Option<String> {
    path.as_ref().map(|path| path.to_string_lossy().to_string())
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()
}

#[tauri::command]
pub async fn request_close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// The renderer is listening: tell it the state it cannot read for itself, and hand
/// over any document that arrived before it could listen (launch argument, file
/// association, second launch).
#[tauri::command]
pub async fn renderer_ready(window: WebviewWindow, ctx: tauri::State<'_, AppCtx>, startup: tauri::State<'_, crate::StartupFiles>) -> Result<(), String> {
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    trace(|| format!("renderer ready (fullscreen={fullscreen})"));
    let _ = window.emit("fullscreen-changed", fullscreen);

    window
        .app_handle()
        .state::<crate::ReadyWindows>()
        .mark_ready(window.label());

    hand_over_verify_probe(&window);

    let queued = startup.drain();
    let app = window.app_handle().clone();
    for (index, path) in queued.into_iter().enumerate() {
        let has_file = ctx.doc(window.label()).lock().expect("doc lock").file_path.is_some();
        if index == 0 && !has_file {
            let _ = load_path_into(&app, &window, &ctx, &path).await;
        } else {
            let _ = window.emit("open-in-new-tab", path.to_string_lossy().to_string());
        }
    }
    Ok(())
}

/// The renderer reports the theme it applied so the menu can show a check mark
/// next to it, and the menu is rebuilt because the check moved.
#[tauri::command]
pub async fn report_theme(window: WebviewWindow, theme: String) -> Result<(), String> {
    let app = window.app_handle().clone();
    let state = app.state::<crate::MenuState>();
    if state.set_theme(&theme) {
        crate::menu::build(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn report_panel_side(window: WebviewWindow, side: String) -> Result<(), String> {
    let app = window.app_handle().clone();
    let state = app.state::<crate::MenuState>();
    if state.set_panel_side(&side) {
        crate::menu::build(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn report_page_width(window: WebviewWindow, width: String) -> Result<(), String> {
    let app = window.app_handle().clone();
    let state = app.state::<crate::MenuState>();
    if state.set_page_width(&width) {
        crate::menu::build(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn report_titlebar_colors(_colors: serde_json::Value) {}
