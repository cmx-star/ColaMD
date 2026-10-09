// Window size, position and view zoom survive a restart.
//
// Having to resize and re-zoom on every launch is a daily annoyance on a large
// display (#95), and these are the same kind of choice the app already remembers for
// themes, panel width and language. The file and its shape are the ones the Electron
// build used, so a user's existing preference keeps working.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow, Window};

use crate::paths;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct SavedWindowState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
}

/// The window has to stay reachable, so the stored size never goes below the
/// minimum the window itself enforces.
const MIN_WIDTH: f64 = 600.0;
const MIN_HEIGHT: f64 = 400.0;

pub fn state_path() -> PathBuf {
    paths::user_data_dir().join("window-state.json")
}

pub fn load() -> SavedWindowState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<SavedWindowState>(&raw).ok())
        .unwrap_or_default()
}

fn save(state: SavedWindowState) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string(&state) {
        Ok(json) => {
            if std::fs::write(&path, json).is_err() {
                // A preference that cannot be written is not worth a dialog.
            }
        }
        Err(_) => {}
    }
}

/// A saved position can point at a display that is no longer attached, which would
/// put the window somewhere the user cannot reach. Keep it only when it still
/// overlaps a screen that exists right now, and only when the size is sane.
pub fn usable_bounds(bounds: Bounds, screens: &[Bounds]) -> Option<Bounds> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if !values.iter().all(|value| value.is_finite()) {
        return None;
    }
    if bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT {
        return None;
    }
    let fits = screens.iter().any(|screen| {
        bounds.x < screen.x + screen.width
            && bounds.x + bounds.width > screen.x
            && bounds.y < screen.y + screen.height
            && bounds.y + bounds.height > screen.y
    });
    if fits {
        Some(bounds)
    } else {
        None
    }
}

/// The monitors that exist right now, as plain rectangles.
fn screens(app: &AppHandle) -> Vec<Bounds> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor();
            Bounds {
                x: position.x as f64 / scale,
                y: position.y as f64 / scale,
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
            }
        })
        .collect()
}

/// The size and position to create a window with, from the last session.
///
/// This is read *before* the window exists on purpose: changing a window's geometry
/// after creation makes AppKit re-lay-out the title bar, and the traffic lights move
/// with it. Tauri can only set their position on the builder, so a window that is
/// resized after creation has lights nothing can put back (2026-10-09).
pub fn saved_geometry(app: &AppHandle) -> Option<(Bounds, Option<f64>)> {
    let state = load();
    let bounds = state.bounds.and_then(|bounds| usable_bounds(bounds, &screens(app)))?;
    let zoom = state.zoom.filter(|zoom| (0.3..=4.0).contains(zoom));
    Some((bounds, zoom))
}

/// Apply the zoom a window had last time. Zoom does not touch the title bar, so it is
/// the one part of the state that can safely be applied after creation.
pub fn apply_zoom(window: &WebviewWindow, zoom: f64) {
    let _ = window.set_zoom(zoom);
}

/// Saves are debounced: a drag generates a move event per frame, and writing the file
/// that often is pointless work.
#[derive(Default, Clone)]
pub struct Saver {
    inner: std::sync::Arc<SaverInner>,
}

#[derive(Default)]
struct SaverInner {
    generation: AtomicU64,
    last: Mutex<SavedWindowState>,
}

impl Saver {
    /// Record where the window is now and write it shortly after it settles.
    ///
    /// The zoom comes in as an argument: Tauri can set a webview's zoom but not read
    /// it back, so the shell keeps the current factor itself (see MenuState).
    pub fn schedule(&self, window: &Window, zoom: f64) {
        let Ok(size) = window.inner_size() else { return };
        let Ok(position) = window.outer_position() else { return };
        let scale = window.scale_factor().unwrap_or(1.0);
        let bounds = Bounds {
            x: position.x as f64 / scale,
            y: position.y as f64 / scale,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        };
        *self.inner.last.lock().expect("window state") = SavedWindowState {
            bounds: Some(bounds),
            zoom: Some(zoom),
        };

        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let saver = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            // Only the last event of a burst writes.
            if saver.inner.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let state = *saver.inner.last.lock().expect("window state");
            save(state);
        });
    }

    /// Write immediately, for the moment the window closes.
    pub fn save_now(&self, window: &Window, zoom: f64) {
        self.schedule(window, zoom);
        let state = *self.inner.last.lock().expect("window state");
        save(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Bounds {
        Bounds { x: 0.0, y: 0.0, width: 1920.0, height: 1200.0 }
    }

    #[test]
    fn a_size_that_overlaps_a_screen_is_kept() {
        let bounds = Bounds { x: 100.0, y: 100.0, width: 960.0, height: 720.0 };
        assert_eq!(usable_bounds(bounds, &[screen()]), Some(bounds));
    }

    #[test]
    fn a_position_on_a_display_that_is_gone_is_dropped() {
        // The second monitor was unplugged: x is past the edge of the only screen left.
        let bounds = Bounds { x: 2400.0, y: 100.0, width: 960.0, height: 720.0 };
        assert_eq!(usable_bounds(bounds, &[screen()]), None);
    }

    #[test]
    fn a_window_that_only_touches_the_edge_counts_as_visible() {
        let bounds = Bounds { x: 1900.0, y: 100.0, width: 960.0, height: 720.0 };
        assert!(usable_bounds(bounds, &[screen()]).is_some());
    }

    #[test]
    fn sizes_below_the_window_minimum_are_dropped() {
        let too_small = Bounds { x: 10.0, y: 10.0, width: 400.0, height: 300.0 };
        assert_eq!(usable_bounds(too_small, &[screen()]), None);
    }

    #[test]
    fn nonsense_numbers_are_dropped() {
        let broken = Bounds { x: f64::NAN, y: 0.0, width: 960.0, height: 720.0 };
        assert_eq!(usable_bounds(broken, &[screen()]), None);
    }

    #[test]
    fn the_file_keeps_the_shape_the_electron_build_wrote() {
        let raw = r#"{"bounds":{"x":10,"y":20,"width":960,"height":720},"zoom":1.25}"#;
        let parsed: SavedWindowState = serde_json::from_str(raw).expect("parse");
        assert_eq!(parsed.zoom, Some(1.25));
        assert_eq!(parsed.bounds.map(|b| b.width), Some(960.0));
        // An empty object (a first run) is valid too.
        assert_eq!(serde_json::from_str::<SavedWindowState>("{}").expect("parse"), SavedWindowState::default());
    }
}
