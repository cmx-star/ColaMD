// Export.
//
// HTML、PDF、图片、Word 四条路都在这里。它们的共同点是「渲染侧产出字节，外壳弹保存框
// 再写盘」：文档的排版知识在渲染侧，文件与系统对话框归外壳。
//
// PDF 与图片是渲染侧把文档画成位图后交过来的（src/renderer/export/），所以这两条路
// 不依赖任何原生截图能力 —— wry 0.57.0 没有向桌面三平台暴露截图接口，这是绕开它的办法。
// 位图进 PDF 意味着 PDF 里的文字不可选、不可搜，这是产品上确认过的取舍：走真文字就得
// 嵌入中文字体，一个完整字体的体积与「免费、轻」的定位冲突（docs/export-pdf-image-plan.md）。
//
// Word 走 Markdown 驱动：渲染侧解析并生成 .docx 字节，外壳只负责落盘。

use base64::Engine as _;
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

/// 渲染侧交过来的产物：base64 字节 + 建议文件名。
///
/// 用 base64 而不是 Tauri 的 raw payload：raw 通道整个请求体就是字节，命令只能有一个
/// `Request` 参数，文件名、扩展名这些元数据没地方放。导出是低频操作，33% 的膨胀无关紧要，
/// 换来的是直白的代码。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    /// 建议的基础文件名，不带扩展名。
    #[serde(default)]
    pub base_name: String,
    /// base64 编码的产物字节。
    pub base64: String,
}

/// 一次导出的多张图片。超长文档切成阅读页时是多个文件。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedImages {
    #[serde(default)]
    pub base_name: String,
    /// 每张的 base64 字节，按页序。
    pub files: Vec<String>,
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
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{title}</title>\n  <style>{styles}\n    html, body {{ height: auto; overflow: visible; }}\n    body {{ min-width: 320px; }}\n    #titlebar, #file-panel, #source-editor {{ display: none !important; }}\n    #editor {{ height: auto !important; min-height: 100vh; overflow: visible !important; padding: 0 !important; }}\n  </style>\n</head>\n<body class=\"{body_class}\">\n  <article class=\"loomark-document\">{rendered}</article>\n</body>\n</html>\n",
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

/// 弹保存框、写盘、在文件管理器里选中。四条导出共用的收尾。
///
/// 返回 `Ok(false)` 表示用户取消了 —— 那不是错误，界面不该弹提示。
async fn save_export(
    window: &tauri::WebviewWindow,
    file: ExportedFile,
    title: &str,
    filter_name: &str,
    extension: &str,
) -> Result<bool, String> {
    let base_name = if file.base_name.trim().is_empty() {
        "untitled".to_string()
    } else {
        file.base_name.trim().to_string()
    };

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let suggested = format!("{base_name}.{extension}");
    window
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(&suggested)
        .add_filter(filter_name, &[extension])
        .save_file(move |picked| {
            let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
        });
    let Some(target) = receiver.await.ok().flatten() else {
        return Ok(false);
    };

    let bytes = match base64::engine::general_purpose::STANDARD.decode(file.base64.as_bytes()) {
        Ok(bytes) => bytes,
        Err(error) => {
            notify_export_failure(window, title, &format!("导出数据损坏：{error}"));
            return Ok(false);
        }
    };
    if let Err(error) = std::fs::write(&target, bytes) {
        notify_export_failure(window, title, &error.to_string());
        return Ok(false);
    }

    crate::trace::trace(|| format!("exported to {}", target.display()));
    let app: AppHandle = window.app_handle().clone();
    let _ = app.opener().reveal_item_in_dir(&target);
    Ok(true)
}

/// 导出失败要让人看见。
///
/// 静默失败与「点了没反应」无法区分：用户会以为菜单坏了，或者以为文件已经写出去了。
/// 所以失败一律弹一次框，并把原因写进详情（磁盘满、没有写权限、路径不存在都在这儿）。
fn notify_export_failure(window: &tauri::WebviewWindow, title: &str, detail: &str) {
    crate::trace::trace(|| format!("export failed: {detail}"));
    window
        .dialog()
        .message(format!(
            "{}\n\n{detail}",
            t(
                "导出没有完成，没有写出文件。",
                "The export did not finish, so no file was written.",
            )
        ))
        .title(title)
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::Ok)
        .blocking_show();
}

/// 把文档写成 PDF。渲染侧已经把每页画成位图，这里只管落盘。
#[tauri::command]
pub async fn export_pdf(window: tauri::WebviewWindow, file: ExportedFile) -> Result<bool, String> {
    save_export(&window, file, t("导出 PDF", "Export PDF"), "PDF", "pdf").await
}

/// 把文档写成 PNG。超长文档渲染侧会切成多张，这时写出编号文件（`名字-1.png`…）。
#[tauri::command]
pub async fn export_image(window: tauri::WebviewWindow, images: ExportedImages) -> Result<bool, String> {
    let number = images.files.len();
    let base_name = if images.base_name.trim().is_empty() {
        "untitled".to_string()
    } else {
        images.base_name.trim().to_string()
    };
    // 一张时直接用建议名；多张时问一次目录，然后按编号连写，避免用户点 N 次保存框。
    let suggested = if number <= 1 {
        format!("{base_name}.png")
    } else {
        format!("{base_name}-1.png")
    };

    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_title(t("导出图片", "Export Image"))
        .set_file_name(&suggested)
        .add_filter("PNG", &["png"])
        .save_file(move |picked| {
            let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
        });
    let Some(target) = receiver.await.ok().flatten() else {
        return Ok(false);
    };

    let engine = base64::engine::general_purpose::STANDARD;
    let title = t("导出图片", "Export Image");
    for (index, encoded) in images.files.iter().enumerate() {
        let bytes = match engine.decode(encoded.as_bytes()) {
            Ok(bytes) => bytes,
            Err(error) => {
                notify_export_failure(&window, title, &format!("导出数据损坏：{error}"));
                return Ok(false);
            }
        };
        // 第一张写用户选的那个路径，其余按编号排在它旁边。
        let path = if index == 0 {
            target.clone()
        } else {
            let stem = target.file_stem().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| base_name.clone());
            let extension = target.extension().map(|ext| ext.to_string_lossy().to_string()).unwrap_or_else(|| "png".to_string());
            // 多张时用户选的名字本身就是 `名字-1`，续写的从 `名字-2` 开始。
            let stem = stem.strip_suffix("-1").unwrap_or(&stem).to_string();
            target.with_file_name(format!("{stem}-{}.{extension}", index + 1))
        };
        if let Err(error) = std::fs::write(&path, bytes) {
            notify_export_failure(&window, title, &error.to_string());
            return Ok(false);
        }
        crate::trace::trace(|| format!("exported image to {}", path.display()));
    }

    let app: AppHandle = window.app_handle().clone();
    let _ = app.opener().reveal_item_in_dir(&target);
    Ok(true)
}

/// 把文档写成 Word（.docx）。
#[tauri::command]
pub async fn export_docx(window: tauri::WebviewWindow, file: ExportedFile) -> Result<bool, String> {
    save_export(&window, file, t("导出 Word 文档", "Export Word document"), "Word Document", "docx").await
}

/// 渲染侧的导出失败也要让人看见。
///
/// 排版、字体、画布这些事都发生在渲染侧，那里出了错，外壳只会看到命令没有被调用 ——
/// 用户看到的是「点了没反应」。所以渲染侧捕获到错误后叫这个名字，由外壳弹一次框。
#[tauri::command]
pub async fn report_export_failure(window: tauri::WebviewWindow, title: String, detail: String) -> Result<(), String> {
    notify_export_failure(&window, &title, &detail);
    Ok(())
}
