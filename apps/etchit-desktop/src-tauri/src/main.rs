//! etch/it desktop binary entry point. Real app lives in
//! `etchit_desktop_lib::run`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    etchit_desktop_lib::run();
}
