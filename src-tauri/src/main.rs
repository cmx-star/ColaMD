// ColaMD's Tauri shell.
//
// P1 (docs/tauri-migration-plan.md): the window and nothing else, so the renderer
// can be checked against the Electron build before any behaviour moves. File IO,
// the watcher, menus, the updater and the export paths land in P2 through P5, each
// in its own module and with its own acceptance check.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running ColaMD");
}
