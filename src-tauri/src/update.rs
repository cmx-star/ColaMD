// Desktop self-update: check GitHub releases, download the installer, open it.
//
// Mirrors the flow proven in deepseek-harness-desktop: release metadata comes from
// GitHub's HTML/atom pages (api.github.com is rate-limited to 60 req/h unauthenticated),
// the artifact is streamed to `<user data>/updates/` with a SHA-256 check, and the
// system installer is opened either on demand or when the app exits with a download
// pending. No Apple certificate involved: tamper protection is the digest, not code
// signing.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sha2::Digest;
use tauri::Emitter;

use crate::i18n::t;
use crate::paths;

/// GitHub repository the installers are published to.
const REPO_URL: &str = "https://github.com/cmx-star/ColaMD";
/// Where downloaded installers live, under the user data dir.
const UPDATES_DIR: &str = "updates";
/// Check requests are tiny; keep them snappy.
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
/// Installer downloads can be hundreds of MB on slow links.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);
const USER_AGENT: &str = "loomark-desktop";

// --- metadata ----------------------------------------------------------------

/// What one release offers this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub tag: String,
    /// Download page, opened if the user prefers the browser.
    pub url: String,
    /// Chosen artifact's file name.
    pub asset_name: String,
    /// Absolute path once downloaded; empty until then.
    pub path: String,
    pub downloaded: bool,
}

/// Progress for the renderer's banner, one event per chunk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub percentage: f64,
    pub downloaded: u64,
    pub total: u64,
}

fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("http client")
}

/// `str::find` marker slicing: everything between two markers.
fn find_token<'a>(text: &'a str, start_marker: &str, end_marker: &str) -> Option<&'a str> {
    let start = text.find(start_marker)? + start_marker.len();
    let end = start + text[start..].find(end_marker)?;
    Some(&text[start..end])
}

/// Release tags from the atom feed, newest first.
fn parse_atom_tags(feed: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let mut rest = feed;
    while let Some(start) = rest.find("<entry>") {
        let end = rest[start..].find("</entry>").map(|e| start + e).unwrap_or(rest.len());
        let block = &rest[start..end];
        if let Some(tag) = find_token(block, "releases/tag/", "\"") {
            tags.push(tag.to_string());
        }
        rest = &rest[end..];
    }
    tags
}

/// Asset file names listed on a release's expanded-assets page.
fn parse_asset_names(html: &str, tag: &str) -> Vec<String> {
    let needle = format!("releases/download/{tag}/");
    let mut names = Vec::new();
    let mut rest = html;
    while let Some(pos) = rest.find(&needle) {
        let after = &rest[pos + needle.len()..];
        let Some(end) = after.find('"') else { break };
        let name = &after[..end];
        if !name.is_empty() && !names.iter().any(|seen| seen == name) {
            names.push(name.to_string());
        }
        rest = after;
    }
    names
}

/// The digest for one specific asset. Each artifact carries its own `sha256:…`
/// on the page, so the lookup must anchor on the chosen name, not the first
/// hash on the page.
fn parse_digest(html: &str, asset_name: &str) -> Option<String> {
    let pos = html.find(asset_name)?;
    let mut end = (pos + 4096).min(html.len());
    while end > pos && !html.is_char_boundary(end) {
        end -= 1;
    }
    let window = &html[pos..end];
    let hash_start = window.find("sha256:")? + "sha256:".len();
    let hash = &window[hash_start..];
    let hex_len = hash.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(hash.len());
    (hex_len == 64).then(|| hash[..64].to_ascii_lowercase())
}

/// The version this build reports as its own.
fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// A real release: `2.8.6`, not `2.9.0-rc.1` and not `test-42`.
fn is_stable(tag: &str) -> bool {
    let version = tag.trim_start_matches('v');
    version
        .parse::<semver::Version>()
        .is_ok_and(|v| v.pre.is_empty() && v.build.is_empty())
}

/// True when `latest` beats `current` (semver; parse failures mean "no").
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |value: &str| value.trim_start_matches('v').parse::<semver::Version>();
    match (parse(latest), parse(current)) {
        (Ok(latest), Ok(current)) => latest > current,
        _ => false,
    }
}

/// Which artifact extensions fit this machine, best first.
#[cfg(target_os = "macos")]
fn platform_prefs() -> &'static [&'static str] {
    &[".dmg"]
}

#[cfg(target_os = "windows")]
fn platform_prefs() -> &'static [&'static str] {
    &[".exe", ".msi"]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_prefs() -> &'static [&'static str] {
    &[".AppImage", ".deb"]
}

/// How well an asset name matches this machine's architecture. Universal names
/// rank between "wrong arch" and "exact match".
fn arch_rank(name: &str) -> i8 {
    let lowered = name.to_ascii_lowercase();
    #[cfg(target_arch = "aarch64")]
    let keywords = ["aarch64", "arm64", "universal"];
    #[cfg(not(target_arch = "aarch64"))]
    let keywords = ["x86_64", "amd64", "x64", "universal"];
    if keywords.iter().any(|k| lowered.contains(k)) {
        2
    } else {
        0
    }
}

/// Pick the asset this machine should download, or None if the release has
/// nothing for us.
fn pick_asset(assets: &[String]) -> Option<String> {
    let prefs = platform_prefs();
    let mut best: Option<(usize, i8, String)> = None;
    for name in assets {
        let Some(rank) = prefs.iter().position(|p| name.to_ascii_lowercase().ends_with(p)) else {
            continue;
        };
        let rank = prefs.len() - rank;
        let arch = arch_rank(name);
        let better = match &best {
            None => true,
            Some((best_rank, best_arch, _)) => rank > *best_rank || (rank == *best_rank && arch > *best_arch),
        };
        if better {
            best = Some((rank, arch, name.clone()));
        }
    }
    best.map(|(_, _, name)| name)
}

/// Fetch the newest stable release that has an artifact for this machine.
async fn fetch_latest_release() -> Result<Option<(String, String, String, Option<String>)>, String> {
    // (tag, asset_name, download_url, digest)
    let client = http_client(CHECK_TIMEOUT);
    let feed_url = format!("{REPO_URL}/releases.atom");
    let feed = client
        .get(&feed_url)
        .send()
        .await
        .and_then(|res| res.error_for_status())
        .map_err(|error| format!("UPDATE_CHECK: {error}"))?
        .text()
        .await
        .map_err(|error| format!("UPDATE_CHECK: {error}"))?;

    let current = current_version();
    for tag in parse_atom_tags(&feed) {
        if !is_stable(&tag) || !is_newer(&tag, &current) {
            continue;
        }
        let assets_url = format!("{REPO_URL}/releases/expanded_assets/{tag}");
        let Ok(html) = client.get(&assets_url).send().await.map_err(|e| format!("UPDATE_CHECK: {e}"))?.text().await else {
            continue;
        };
        let assets = parse_asset_names(&html, &tag);
        let Some(asset) = pick_asset(&assets) else { continue };
        let digest = parse_digest(&html, &asset);
        let url = format!("{REPO_URL}/releases/download/{tag}/{asset}");
        return Ok(Some((tag, asset, url, digest)));
    }
    Ok(None)
}

// --- pending install ---------------------------------------------------------

/// The installer waiting to be opened at exit: (path, version).
fn pending_path() -> PathBuf {
    paths::user_data_dir().join("pending-update.json")
}

fn read_pending() -> Option<(PathBuf, String)> {
    let raw = std::fs::read_to_string(pending_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((
        PathBuf::from(value.get("path")?.as_str()?),
        value.get("version")?.as_str()?.to_string(),
    ))
}

fn write_pending(path: &Path, version: &str) {
    let value = serde_json::json!({ "path": path.to_string_lossy(), "version": version });
    let _ = std::fs::write(pending_path(), value.to_string());
}

fn clear_pending() {
    let _ = std::fs::remove_file(pending_path());
}

pub fn updates_dir() -> PathBuf {
    paths::user_data_dir().join(UPDATES_DIR)
}

/// Called from the exit path: if an installer was downloaded but never opened,
/// open it now, unless the running version is already at least as new (the
/// user may have updated by hand in between).
pub fn launch_pending_installer() {
    let Some((path, version)) = read_pending() else { return };
    clear_pending();
    if !is_newer(&version, &current_version()) {
        return;
    }
    if !path.is_file() {
        return;
    }
    trace_open(&path, "exit");
    open_installer_now(&path);
}

// --- opening the installer ---------------------------------------------------

/// Guard against path traversal and symlinks escaping the updates dir.
fn path_is_inside_updates(path: &Path) -> bool {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = std::fs::canonicalize(updates_dir()).unwrap_or_else(|_| updates_dir());
    canonical.starts_with(&dir)
}

fn open_installer_now(path: &Path) -> bool {
    if !path_is_inside_updates(path) {
        crate::trace::trace(|| format!("refusing installer outside updates dir: {}", path.display()));
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    // The installer replaces the app; hand it to the OS and let it run.
    open_with_system(path)
}

#[cfg(target_os = "macos")]
fn open_with_system(path: &Path) -> bool {
    std::process::Command::new("open").arg(path).spawn().is_ok()
}

#[cfg(target_os = "windows")]
fn open_with_system(path: &Path) -> bool {
    // `open` on Windows would block explorer-less environments; spawn detached.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &path.to_string_lossy()])
        .creation_flags(0x0000_0008) // DETACHED_PROCESS
        .spawn()
        .is_ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_system(path: &Path) -> bool {
    std::process::Command::new("xdg-open").arg(path).spawn().is_ok()
}

#[cfg(target_os = "windows")]
trait WindowsCreationFlags {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

#[cfg(target_os = "windows")]
impl WindowsCreationFlags for std::process::Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        std::os::windows::process::CommandExt::creation_flags(self, flags)
    }
}

fn trace_open(path: &Path, when: &str) {
    crate::trace::trace(|| format!("opening installer ({when}): {}", path.display()));
}

// --- commands ----------------------------------------------------------------

/// Ask GitHub whether a newer stable release with an artifact for this machine
/// exists. Returns `None` when already up to date.
pub async fn check(_app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let Some((tag, asset, _url, _digest)) = fetch_latest_release().await? else {
        return Ok(None);
    };
    let version = tag.trim_start_matches('v').to_string();
    let target = updates_dir().join(&asset);
    let downloaded = target.is_file();
    Ok(Some(UpdateInfo {
        version: version.clone(),
        current_version: current_version(),
        tag,
        url: format!("{REPO_URL}/releases/latest"),
        asset_name: asset,
        path: target.to_string_lossy().to_string(),
        downloaded,
    }))
}

/// Stream the chosen artifact into the updates dir, verify its digest, and
/// register it as the pending installer. Progress goes to the renderer.
pub async fn download(app: &tauri::AppHandle) -> Result<UpdateInfo, String> {
    let Some((tag, asset, url, digest)) = fetch_latest_release().await? else {
        return Err(t("没有可用的更新", "No update available").to_string());
    };
    let version = tag.trim_start_matches('v').to_string();
    let dir = updates_dir();
    let _ = std::fs::create_dir_all(&dir);
    let target = dir.join(&asset);
    let part = dir.join(format!("{asset}.part"));

    if !target.is_file() {
        download_file(&part, &url, digest.as_deref(), app).await?;
        std::fs::rename(&part, &target).map_err(|error| format!("UPDATE_RENAME: {error}"))?;
    }

    // Remember it even if the user quits before clicking install.
    write_pending(&target, &version);

    Ok(UpdateInfo {
        version,
        current_version: current_version(),
        tag,
        url: format!("{REPO_URL}/releases/latest"),
        asset_name: asset,
        path: target.to_string_lossy().to_string(),
        downloaded: true,
    })
}

async fn download_file(target: &Path, url: &str, digest: Option<&str>, app: &tauri::AppHandle) -> Result<(), String> {
    let client = http_client(DOWNLOAD_TIMEOUT);
    let response = client
        .get(url)
        .send()
        .await
        .and_then(|res| res.error_for_status())
        .map_err(|error| format!("UPDATE_DOWNLOAD: {error}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(target).map_err(|error| format!("UPDATE_DOWNLOAD: {error}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("UPDATE_DOWNLOAD: {error}"))?;
        file.write_all(&chunk).map_err(|error| format!("UPDATE_DOWNLOAD: {error}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        // Throttle the event stream: one per full percent is plenty for a banner.
        if downloaded - last_reported >= total / 100.max(1) || downloaded == total {
            last_reported = downloaded;
            let _ = app.emit(
                "update-progress",
                DownloadProgress {
                    percentage: if total > 0 { downloaded as f64 / total as f64 * 100.0 } else { 0.0 },
                    downloaded,
                    total,
                },
            );
        }
    }
    drop(file);

    if let Some(expected) = digest {
        let actual = format!("{:x}", hasher.finalize());
        if actual != expected.to_ascii_lowercase() {
            let _ = std::fs::remove_file(target);
            return Err("UPDATE_INTEGRITY_CHECK_FAILED".to_string());
        }
    }
    Ok(())
}

/// Open a downloaded installer on the user's click.
pub async fn install(path: String) -> Result<bool, String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Ok(false);
    }
    let opened = open_installer_now(&path);
    if opened {
        clear_pending();
    }
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_tags_only() {
        assert!(is_stable("v2.8.6"));
        assert!(is_stable("2.8.6"));
        assert!(!is_stable("v2.9.0-rc.1"));
        assert!(!is_stable("test-42"));
    }

    #[test]
    fn newer_compares_semver() {
        assert!(is_newer("v2.9.0", "2.8.6"));
        assert!(!is_newer("2.8.6", "v2.8.6"));
        assert!(!is_newer("v2.8.5", "2.8.6"));
        assert!(!is_newer("garbage", "2.8.6"));
    }

    #[test]
    fn atom_tags_are_extracted_in_order() {
        let feed = r#"<feed><entry><link href="https://github.com/x/y/releases/tag/v2.9.0"/></entry>
<entry><link href="https://github.com/x/y/releases/tag/v2.8.6"/></entry></feed>"#;
        assert_eq!(parse_atom_tags(feed), vec!["v2.9.0", "v2.8.6"]);
    }

    #[test]
    fn asset_names_come_from_download_links() {
        let html = concat!(
            r#"<a href="https://github.com/x/y/releases/download/v2.9.0/loomark_2.9.0_aarch64.dmg">"#,
            r#"<a href="https://github.com/x/y/releases/download/v2.9.0/loomark_2.9.0_x64-setup.exe">"#
        );
        let names = parse_asset_names(html, "v2.9.0");
        assert_eq!(names.len(), 2);
        assert!(names[0].ends_with(".dmg"));
    }

    #[test]
    fn digest_is_picked_for_the_chosen_asset() {
        let html = concat!(
            r#"loomark_2.9.0_aarch64.dmg <code>sha256:1111111111111111111111111111111111111111111111111111111111111111</code>"#,
            r#"loomark_2.9.0_x64.dmg <code>sha256:2222222222222222222222222222222222222222222222222222222222222222</code>"#
        );
        let digest = parse_digest(html, "loomark_2.9.0_x64.dmg").expect("digest");
        assert!(digest.ends_with("2222"));
    }

    #[test]
    fn picks_the_platform_asset_with_the_best_arch() {
        let assets = vec![
            "loomark_2.9.0_x64.dmg".to_string(),
            "loomark_2.9.0_aarch64.dmg".to_string(),
            "loomark_2.9.0.deb".to_string(),
        ];
        #[cfg(target_arch = "aarch64")]
        assert_eq!(pick_asset(&assets).as_deref(), Some("loomark_2.9.0_aarch64.dmg"));
        #[cfg(not(target_arch = "aarch64"))]
        assert_eq!(pick_asset(&assets).as_deref(), Some("loomark_2.9.0_x64.dmg"));
    }
}
