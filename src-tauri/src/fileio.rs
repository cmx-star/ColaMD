// Document IO: reading, writing and listing, with the semantics the Electron main
// process already established (src/main/index.ts). The migration mirrors that
// behaviour rather than improving it: a save is a plain write, exactly as before,
// and "atomic" saves are *detected* through a directory watcher, not produced.
// Changing that here would mix a behaviour change into a port.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The extensions the file panel and the open dialog treat as documents.
pub const MARKDOWN_EXTENSIONS: [&str; 4] = [".md", ".markdown", ".mdown", ".mkd"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
    Parent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SiblingFile {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentData {
    pub content: String,
    pub mtime: u64,
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_lowercase();
    MARKDOWN_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Modification time in milliseconds since the epoch, or 0 when it cannot be read.
pub fn file_mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

/// One directory level: subdirectories first, then Markdown files, each sorted by
/// name. Hidden directories stay out of the list.
pub fn list_directory_children(dir: &Path) -> Vec<SiblingFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new()
    };

    let mut directories: Vec<SiblingFile> = Vec::new();
    let mut files: Vec<SiblingFile> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path().to_string_lossy().to_string();
        if file_type.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            directories.push(SiblingFile { name, path, kind: EntryKind::Directory });
        } else if file_type.is_file() && is_markdown(&name) {
            files.push(SiblingFile { name, path, kind: EntryKind::File });
        }
    }

    directories.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    directories.extend(files);
    directories
}

/// The file panel's root: the open document's directory, with `..` as the one way
/// back up. Deeper levels are read one directory at a time.
pub fn list_sibling_files(file_path: Option<&Path>, browse_dir: Option<&Path>) -> Vec<SiblingFile> {
    let dir: PathBuf = match browse_dir {
        Some(dir) => dir.to_path_buf(),
        None => match file_path.and_then(|path| path.parent()) {
            Some(parent) => parent.to_path_buf(),
            None => return Vec::new(),
        },
    };

    let mut children = list_directory_children(&dir);
    match dir.parent() {
        // The filesystem root has no parent, so it gets no `..` entry.
        Some(parent) if parent != dir => {
            let mut entries = vec![SiblingFile {
                name: "..".to_string(),
                path: parent.to_string_lossy().to_string(),
                kind: EntryKind::Parent,
            }];
            entries.append(&mut children);
            entries
        }
        _ => children,
    }
}

/// Read a document as UTF-8, replacing invalid sequences the way Node does.
pub fn read_document(path: &Path) -> std::io::Result<DocumentData> {
    let bytes = fs::read(path)?;
    let content = String::from_utf8_lossy(&bytes).to_string();
    Ok(DocumentData { content, mtime: file_mtime_ms(path) })
}

/// Write a document and report the mtime the file now carries.
///
/// A plain write, mirroring the Electron build. Callers that need to recognise
/// their own echo pass the content to `DocumentState::remember_save`.
pub fn write_document(path: &Path, content: &str) -> std::io::Result<u64> {
    fs::write(path, content)?;
    Ok(file_mtime_ms(path))
}

/// True when the file changed after our own last read or write, meaning there is an
/// external edit this window has not seen yet. The 1ms tolerance absorbs filesystem
/// timestamp rounding.
pub fn changed_externally(path: &Path, last_known_mtime: u64) -> bool {
    if last_known_mtime == 0 {
        return false;
    }
    let disk_mtime = file_mtime_ms(path);
    if disk_mtime == 0 {
        return false;
    }
    disk_mtime > last_known_mtime + 1
}

/// The default file name a save dialog offers: the current document's stem, or the
/// first heading, or the first non-empty line.
pub fn suggest_file_name(file_path: Option<&Path>, content: Option<&str>) -> Option<String> {
    if let Some(path) = file_path {
        if let Some(stem) = path.file_stem() {
            return Some(stem.to_string_lossy().to_string());
        }
    }
    let content = content?;
    let candidate = content
        .lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())?;
    let heading = candidate.strip_prefix('#').map(str::trim).filter(|text| !text.is_empty());
    let text = heading.unwrap_or(candidate);
    let cleaned: String = text
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(60).collect())
    }
}

/// Current wall-clock milliseconds, used to suppress watcher events that carry
/// replayed history (macOS FSEvents).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("colamd-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// The package's oldest discipline: opening a file and saving it back without
    /// edits must not change a single byte (docs/editor-architecture.md).
    #[test]
    fn save_of_an_unedited_document_is_byte_identical() {
        let dir = temp_dir("fidelity");
        let path = dir.join("note.md");
        let original = "# Title\n\n- item one\n- item two\n\n3 * 4 and $5 and snake_case\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
        fs::write(&path, original).expect("seed file");

        let opened = read_document(&path).expect("read");
        assert_eq!(opened.content, original);

        write_document(&path, &opened.content).expect("write back");
        let after = fs::read(&path).expect("read bytes");
        assert_eq!(String::from_utf8_lossy(&after), original);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_reports_a_fresh_mtime() {
        let dir = temp_dir("mtime");
        let path = dir.join("a.md");
        fs::write(&path, "one").expect("seed");
        let before = file_mtime_ms(&path);
        std::thread::sleep(std::time::Duration::from_millis(5));
        let after = write_document(&path, "two").expect("write");
        assert!(after >= before);
        assert!(!changed_externally(&path, after));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_document_edited_after_our_read_is_reported_as_external() {
        let dir = temp_dir("external");
        let path = dir.join("b.md");
        fs::write(&path, "mine").expect("seed");
        let mine = file_mtime_ms(&path);

        // An external writer lands after us: the mtime moves past the tolerance.
        std::thread::sleep(std::time::Duration::from_millis(10));
        let mut handle = fs::OpenOptions::new().write(true).truncate(true).open(&path).expect("open");
        handle.write_all(b"theirs").expect("write");
        drop(handle);

        assert!(changed_externally(&path, mine));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_files_are_not_treated_as_changed() {
        let dir = temp_dir("missing");
        let path = dir.join("gone.md");
        assert!(!changed_externally(&path, 12345));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn siblings_list_directories_first_then_markdown_and_hide_dot_dirs() {
        let dir = temp_dir("siblings");
        fs::create_dir_all(dir.join("zeta")).expect("dir");
        fs::create_dir_all(dir.join("alpha")).expect("dir");
        fs::create_dir_all(dir.join(".hidden")).expect("dir");
        fs::write(dir.join("b.md"), "b").expect("file");
        fs::write(dir.join("a.md"), "a").expect("file");
        fs::write(dir.join("notes.txt"), "t").expect("file");
        fs::write(dir.join("README"), "r").expect("file");

        let children = list_directory_children(&dir);
        let names: Vec<&str> = children.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "zeta", "a.md", "b.md"]);
        assert_eq!(children[0].kind, EntryKind::Directory);
        assert_eq!(children[2].kind, EntryKind::File);

        let with_parent = list_sibling_files(Some(&dir.join("a.md")), None);
        assert_eq!(with_parent[0].kind, EntryKind::Parent);
        assert_eq!(with_parent[0].name, "..");
        // The parent of the temp dir is not itself, so `..` is present.
        assert!(with_parent.len() == children.len() + 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_without_a_document_has_no_siblings_root() {
        assert!(list_sibling_files(None, None).is_empty());
    }

    #[test]
    fn save_name_comes_from_the_heading_then_the_first_line() {
        assert_eq!(suggest_file_name(None, Some("# Hello: world?\n\nbody")).as_deref(), Some("Hello world"));
        assert_eq!(suggest_file_name(None, Some("\n\nonly a line\nsecond")).as_deref(), Some("only a line"));
        assert_eq!(suggest_file_name(None, Some("   \n\n")).as_deref(), None);
        assert_eq!(suggest_file_name(Some(Path::new("/tmp/My Note.md")), None).as_deref(), Some("My Note"));
    }
}
