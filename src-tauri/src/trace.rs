// Optional tracing, in the spirit of the Electron build's COLAMD_STARTUP_TRACE.
//
// The migration moves code that used to be observable through a Node process into a
// compiled binary, and a packaged app has no console: without this, "did the file
// load, did the watcher fire, did the save land" can only be answered by looking at
// the window. Set `COLAMD_TRACE=1` and the shell prints a line per decision to
// stderr, which is what a tester (or a script) can collect.
//
// Off by default, and deliberately cheap when off: one environment lookup, cached.

use std::sync::OnceLock;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("COLAMD_TRACE").map(|value| value == "1").unwrap_or(false))
}

/// Print one trace line when tracing is on. Arguments are formatted lazily.
pub fn trace(message: impl FnOnce() -> String) {
    if !enabled() {
        return;
    }
    eprintln!("[colamd] {}", message());
}
