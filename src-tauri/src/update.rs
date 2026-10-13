// Desktop update check: ask GitHub whether a newer stable release exists, then hand
// the user over to that release's page in the browser.
//
// Release metadata comes from GitHub's HTML/atom pages (api.github.com is rate-limited
// to 60 req/h unauthenticated). Picking the artifact here rather than in the browser is
// what makes the banner trustworthy: a release with nothing for this platform is not an
// update this machine can install, so it is never announced.
//
// Downloading belongs to the browser and the OS (2026-10-12). The in-app download
// duplicated the browser, carried its own SHA-256 check, and failed on links where the
// browser would have succeeded; the banner opens the release page instead.

use std::time::Duration;

use serde::Serialize;

/// GitHub repository the installers are published to.
const REPO_URL: &str = "https://github.com/cmx-star/ColaMD";
/// Check requests are tiny; keep them snappy.
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const USER_AGENT: &str = "loomark-desktop";

// --- metadata ----------------------------------------------------------------

/// What one release offers this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub tag: String,
    /// The release page the banner button opens.
    pub url: String,
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

/// The page a user downloads from by hand. Pointing at the tag rather than at
/// `/releases/latest` keeps the link honest if another release lands between the
/// check and the click.
fn release_page(tag: &str) -> String {
    format!("{REPO_URL}/releases/tag/{tag}")
}

/// Fetch the newest stable release that has an artifact for this machine, as
/// `(tag, release page)`.
async fn fetch_latest_release() -> Result<Option<(String, String)>, String> {
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
        // No artifact for this platform means nothing to install; stay quiet
        // rather than send the user to a page with nothing for them.
        if pick_asset(&parse_asset_names(&html, &tag)).is_none() {
            continue;
        }
        let url = release_page(&tag);
        return Ok(Some((tag, url)));
    }
    Ok(None)
}

// --- commands ----------------------------------------------------------------

/// Ask GitHub whether a newer stable release with an artifact for this machine
/// exists. Returns `None` when already up to date.
pub async fn check() -> Result<Option<UpdateInfo>, String> {
    let Some((tag, url)) = fetch_latest_release().await? else {
        return Ok(None);
    };
    Ok(Some(UpdateInfo {
        version: tag.trim_start_matches('v').to_string(),
        current_version: current_version(),
        tag,
        url,
    }))
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

    #[test]
    fn release_page_points_at_the_announced_tag() {
        assert_eq!(
            release_page("v2.9.0"),
            "https://github.com/cmx-star/ColaMD/releases/tag/v2.9.0"
        );
    }
}
