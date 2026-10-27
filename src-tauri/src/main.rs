// Keeps a release build on Windows from opening a console window beside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_mini_editor_lib::run()
}
