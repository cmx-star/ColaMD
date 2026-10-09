// Export.
//
// HTML is here and complete. PDF, image and Word are not ported yet, and the reason
// is worth recording rather than hiding:
//
//   * PDF used Electron's `printToPDF`. Neither Tauri nor the system webviews expose
//     an equivalent, so the planned route is print CSS plus the system print dialog,
//     with "Save as PDF" as the user's step (docs/tauri-migration-plan.md, R1).
//   * Image export drew the document in a hidden window and captured it. Browsers do
//     not expose "capture this webview"; the platform APIs exist (WKWebView
//     takeSnapshot, WebView2 CapturePreview, WebKitGTK snapshot) but each needs a
//     small native bridge (R3).
//   * Word export generates the .docx with the `docx` package and Electron's
//     nativeImage for local pictures, so it moves to the renderer side rather than
//     the shell.
//
// Each of those says so to the user instead of failing silently.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::i18n::t;

#[derive(serde::Deserialize)]
pub struct HtmlSnapshot {
    pub content: String,
    pub html: String,
    #[serde(default)]
    pub document: String,
    #[serde(default)]
    pub styles: String,
    #[serde(rename = "bodyClass", default)]
    pub body_class: String,
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Write the document as a standalone HTML file, using the same wrapper and the same
/// stylesheet the Electron build produced.
#[tauri::command]
pub async fn export_html(window: tauri::WebviewWindow, snapshot: HtmlSnapshot) -> Result<bool, String> {
    let base_name = crate::fileio::suggest_file_name(None, Some(&snapshot.content)).unwrap_or_else(|| "untitled".to_string());

    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_title(t("导出 HTML", "Export HTML"))
        .set_file_name(format!("{base_name}.html"))
        .add_filter("HTML", &["html"])
        .save_file(move |picked| {
            let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
        });
    let Some(target) = receiver.await.ok().flatten() else {
        return Ok(false);
    };

    // The semantic document form wins: an export is a document, not the editor's own
    // line structure with its class names.
    let rendered = if !snapshot.document.is_empty() {
        snapshot.document.clone()
    } else if !snapshot.html.is_empty() {
        snapshot.html.clone()
    } else {
        format!("<pre>{}</pre>", escape_html(&snapshot.content))
    };

    let document = format!(
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{title}</title>\n  <style>{styles}\n    html, body {{ height: auto; overflow: visible; }}\n    body {{ min-width: 320px; }}\n    #titlebar, #file-panel, #source-editor {{ display: none !important; }}\n    #editor {{ height: auto !important; min-height: 100vh; overflow: visible !important; padding: 0 !important; }}\n  </style>\n</head>\n<body class=\"{body_class}\">\n  <article class=\"colamd-document\">{rendered}</article>\n</body>\n</html>\n",
        title = escape_html(&base_name),
        styles = snapshot.styles,
        body_class = escape_html(&snapshot.body_class),
    );

    std::fs::write(&target, document).map_err(|error| error.to_string())?;
    crate::trace::trace(|| format!("exported HTML to {}", target.display()));
    let app: AppHandle = window.app_handle().clone();
    let _ = app.opener().reveal_item_in_dir(&target);
    Ok(true)
}
