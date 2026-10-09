// The file watcher behind the product's headline promise: the document on screen
// is the file on disk, whoever wrote it (the user, an agent, a script, another
// editor).
//
// The shape follows the Electron implementation (src/main/index.ts, watchFile):
//
//   * the *parent directory* is watched, not the file. Agents usually save
//     atomically (write a temp file and rename over the target), which replaces the
//     file's inode and silently kills a watcher bound to it. A directory watcher
//     survives that and keeps reporting our file name.
//   * events are debounced: 100ms before re-reading the document, 300ms before
//     refreshing the file panel.
//   * events arriving right after a watcher is established are dropped, because
//     macOS FSEvents replays recent history and an open would otherwise reload.
//   * our own writes echo back through the filesystem long after the write call
//     returns, so they are skipped twice over: while a write is in flight, and by
//     comparing the bytes on disk with the bytes we wrote.
//   * a watcher that dies (directory removed, permissions) re-establishes itself.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::{Emitter, WebviewWindow};

use crate::fileio::{self, MARKDOWN_EXTENSIONS};
use crate::state::SharedDoc;
use crate::trace::trace;

const DEBOUNCE_DOCUMENT: Duration = Duration::from_millis(100);
const DEBOUNCE_SIBLINGS: Duration = Duration::from_millis(300);
/// macOS replays recent FSEvents when a watcher starts; ignore that window.
const SUPPRESS_AFTER_ESTABLISH: Duration = Duration::from_millis(300);

/// A watcher for one window. Dropping it stops the worker thread.
pub struct FileWatcher {
    control: Sender<Control>,
}

enum Control {
    Stop,
}

impl FileWatcher {
    pub fn stop(self) {
        let _ = self.control.send(Control::Stop);
    }
}

/// What the worker has been asked to do, coalesced until the debounce elapses.
#[derive(Default)]
struct Pending {
    document: Option<Instant>,
    siblings: Option<Instant>,
}

/// Start watching `path`'s directory for `window`, reporting through the same event
/// names the Electron build uses.
pub fn watch(window: WebviewWindow, doc: SharedDoc, path: PathBuf) -> FileWatcher {
    let (control_tx, control_rx) = channel::<Control>();
    let (event_tx, event_rx) = channel::<notify::Result<Event>>();

    thread::spawn(move || {
        let mut worker = Worker::new(window, doc, path, event_tx);
        worker.run(control_rx, event_rx);
    });

    FileWatcher { control: control_tx }
}

struct Worker {
    window: WebviewWindow,
    doc: SharedDoc,
    path: PathBuf,
    event_tx: Sender<notify::Result<Event>>,
    watcher: Option<RecommendedWatcher>,
    suppress_until: Instant,
}

impl Worker {
    fn new(window: WebviewWindow, doc: SharedDoc, path: PathBuf, event_tx: Sender<notify::Result<Event>>) -> Self {
        Self { window, doc, path, event_tx, watcher: None, suppress_until: Instant::now() }
    }

    fn file_name(&self) -> String {
        self.path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    /// Bind a directory watcher, replacing any previous one.
    fn establish(&mut self) {
        self.suppress_until = Instant::now() + SUPPRESS_AFTER_ESTABLISH;
        let sender = self.event_tx.clone();
        match notify::recommended_watcher(move |res: notify::Result<Event>| {
            // The worker owns the debounce; the callback only forwards.
            let _ = sender.send(res);
        }) {
            Ok(mut watcher) => {
                let directory = self.path.parent().unwrap_or(Path::new("."));
                match watcher.watch(directory, RecursiveMode::NonRecursive) {
                    Ok(()) => self.watcher = Some(watcher),
                    Err(_) => {
                        // Fall back to the file itself when the directory is not
                        // watchable, which still catches plain writes.
                        if watcher.watch(&self.path, RecursiveMode::NonRecursive).is_ok() {
                            self.watcher = Some(watcher);
                        } else {
                            self.watcher = None;
                        }
                    }
                }
            }
            Err(_) => self.watcher = None,
        }
    }

    fn run(&mut self, control: Receiver<Control>, events: Receiver<notify::Result<Event>>) {
        self.establish();
        let mut pending = Pending::default();

        loop {
            match control.try_recv() {
                Ok(Control::Stop) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }

            let timeout = next_deadline(&pending)
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_millis(200));

            match events.recv_timeout(timeout) {
                Ok(Ok(event)) => self.absorb(&event, &mut pending),
                Ok(Err(_)) => self.establish(),
                Err(RecvTimeoutError::Timeout) => {
                    let now = Instant::now();
                    if pending.document.is_some_and(|deadline| deadline <= now) {
                        pending.document = None;
                        self.reload_document();
                    }
                    if pending.siblings.is_some_and(|deadline| deadline <= now) {
                        pending.siblings = None;
                        self.refresh_siblings();
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        if let Some(watcher) = self.watcher.take() {
            drop(watcher);
        }
    }

    /// Decide what an event means for us, and schedule the matching work.
    fn absorb(&mut self, event: &Event, pending: &mut Pending) {
        if self.doc.lock().expect("doc lock").is_internal_save() {
            return;
        }
        if Instant::now() < self.suppress_until {
            return;
        }

        let file_name = self.file_name();
        let mut touched_us = false;
        let mut touched_sibling = false;

        for path in &event.paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            if name == file_name {
                touched_us = true;
            } else {
                let lower = name.to_lowercase();
                if MARKDOWN_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
                    touched_sibling = true;
                }
            }
        }

        // A rename or removal may be an atomic save replacing our file, or the file
        // going away entirely. Either way the binding is worth re-establishing.
        if touched_us && matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)) {
            self.establish();
        }

        if touched_us {
            pending.document = Some(Instant::now() + DEBOUNCE_DOCUMENT);
        }
        if touched_sibling {
            pending.siblings = Some(Instant::now() + DEBOUNCE_SIBLINGS);
        }
    }

    /// Re-read the document and hand it to the renderer, unless these are our own
    /// bytes coming back.
    fn reload_document(&mut self) {
        let Ok(data) = fileio::read_document(&self.path) else {
            // The file may be mid-replace; the next event re-triggers.
            return;
        };

        {
            let mut doc = self.doc.lock().expect("doc lock");
            if doc.last_internal_save_content.as_deref() == Some(data.content.as_str()) {
                // Our own write, still echoing. Leave the echo marker in place: the
                // same content can arrive more than once.
                trace(|| "watcher: own write ignored".to_string());
                return;
            }
            doc.last_internal_save_content = None;
            doc.last_known_mtime = data.mtime;
        }

        trace(|| format!("watcher: {} changed on disk, handing it to the renderer", self.path.display()));
        let _ = self.window.emit("file-changed", data.content);
    }

    fn refresh_siblings(&mut self) {
        let (file_path, browse_path) = {
            let doc = self.doc.lock().expect("doc lock");
            (doc.file_path.clone(), doc.browse_path.clone())
        };
        let files = fileio::list_sibling_files(file_path.as_deref(), browse_path.as_deref());
        let _ = self.window.emit("siblings-changed", files);
    }
}

fn next_deadline(pending: &Pending) -> Option<Instant> {
    match (pending.document, pending.siblings) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// The watcher registry, so a window keeps at most one live watcher.
#[derive(Default)]
pub struct Watchers {
    live: Mutex<std::collections::HashMap<String, FileWatcher>>,
}

impl Watchers {
    pub fn install(&self, label: &str, watcher: FileWatcher) {
        let mut live = self.live.lock().expect("watcher registry lock");
        if let Some(previous) = live.remove(label) {
            previous.stop();
        }
        live.insert(label.to_string(), watcher);
    }

    pub fn stop(&self, label: &str) {
        let mut live = self.live.lock().expect("watcher registry lock");
        if let Some(watcher) = live.remove(label) {
            watcher.stop();
        }
    }
}
