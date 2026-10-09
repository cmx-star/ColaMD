// Optional tracing, in the spirit of the Electron build's COLAMD_STARTUP_TRACE.
//
// The migration moves code that used to be observable through a Node process into a
// compiled binary, and a packaged app has no console: without this, "did the file
// load, did the watcher fire, did the save land" can only be answered by looking at
// the window. Set `COLAMD_TRACE=1` and the shell prints a line per decision to
// stderr, which is what a tester (or a script) can collect.
//
// Off by default, and deliberately cheap when off: one environment lookup, cached.
//
// Lines go to stderr and to `~/.colamd/trace.log`. The file matters when the app is
// started by the system rather than by a terminal (`open -a ColaMD`), where nothing
// is attached to stderr; a test round then still has evidence to read afterwards.

use std::io::Write;
use std::sync::OnceLock;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("COLAMD_TRACE").map(|value| value == "1").unwrap_or(false))
}

fn log_path() -> std::path::PathBuf {
    crate::paths::colamd_home().join("trace.log")
}

/// Report one decision when tracing is on. Arguments are formatted lazily.
pub fn trace(message: impl FnOnce() -> String) {
    if !enabled() {
        return;
    }
    let line = format!("[colamd] {}\n", message());
    eprint!("{line}");

    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}
