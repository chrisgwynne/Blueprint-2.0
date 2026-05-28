// On Windows, prevents a console window opening alongside the GUI.
// Harmless on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    blueprint_lib::run()
}
