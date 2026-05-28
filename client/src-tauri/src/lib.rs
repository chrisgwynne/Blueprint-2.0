use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

// ── Production-only: sidecar management ───────────────────────────────────────

#[cfg(not(debug_assertions))]
use {
    std::sync::{Arc, Mutex},
    tauri_plugin_shell::ShellExt,
    tauri_plugin_shell::process::CommandEvent,
};

#[cfg(not(debug_assertions))]
struct ManagedServer(tauri_plugin_shell::process::CommandChild);

#[cfg(not(debug_assertions))]
impl Drop for ManagedServer {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

#[cfg(not(debug_assertions))]
fn find_free_port() -> u16 {
    use std::net::TcpListener;
    TcpListener::bind("127.0.0.1:0")
        .map(|l| l.local_addr().unwrap().port())
        .unwrap_or(4000)
}

/// Poll until port is accepting TCP connections (max ~60s).
#[cfg(not(debug_assertions))]
fn wait_for_port(port: u16) {
    use std::net::TcpStream;
    for _ in 0..120 {
        if TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
            // Brief pause so the HTTP server finishes initialising after TCP bind.
            std::thread::sleep(std::time::Duration::from_millis(400));
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Fast, non-cryptographic secret for first-launch defaults.
/// The user can (and should) rotate these via the Settings UI.
#[cfg(not(debug_assertions))]
fn gen_secret(len: usize) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);
    let v1 = h.finish();
    v1.hash(&mut h);
    let v2 = h.finish();
    v2.hash(&mut h);
    let v3 = h.finish();
    format!("{v1:016x}{v2:016x}{v3:016x}")
        .chars()
        .take(len)
        .collect()
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ── App entry point ────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // ── Release: start the bundled server sidecar ──────────────────────
            #[cfg(not(debug_assertions))]
            let server_port = {
                let app_data = app.path().app_data_dir()?;
                std::fs::create_dir_all(app_data.join("data"))?;
                std::fs::create_dir_all(app_data.join("kb"))?;
                std::fs::create_dir_all(app_data.join("agents"))?;

                // Write default secrets on first launch.
                // The user rotates their password in Settings → Security.
                let env_file = app_data.join(".env");
                if !env_file.exists() {
                    std::fs::write(&env_file, format!(
                        "SESSION_SECRET={}\n\
                         ENCRYPTION_KEY={}\n\
                         ADMIN_USERNAME=admin\n\
                         ADMIN_PASSWORD=blueprint\n",
                        gen_secret(48),
                        gen_secret(32),
                    ))?;
                }

                let port         = find_free_port();
                let resource_dir = app.path().resource_dir()?;

                let (mut rx, child) = app.shell()
                    .sidecar("blueprint-server")?
                    .env("PORT",             port.to_string())
                    .env("NODE_ENV",         "production")
                    .env("DATABASE_PATH",    app_data.join("data/blueprint.db").to_str().unwrap_or(""))
                    .env("KB_PATH",          app_data.join("kb").to_str().unwrap_or(""))
                    .env("AGENTS_DIR",       app_data.join("agents").to_str().unwrap_or(""))
                    .env("CLIENT_DIST_PATH", resource_dir.join("dist").to_str().unwrap_or(""))
                    .env("PROJECT_ROOT",     app_data.to_str().unwrap_or(""))
                    .env("BLUEPRINT_SIDECAR","1")
                    .env("DISABLE_TELEGRAM", "true")
                    .spawn()?;

                tauri::async_runtime::spawn(async move {
                    while let Some(ev) = rx.recv().await {
                        let b = match ev {
                            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => b,
                            _ => continue,
                        };
                        eprintln!("[blueprint] {}", String::from_utf8_lossy(&b).trim_end());
                    }
                });

                app.manage(Arc::new(Mutex::new(ManagedServer(child))));
                port
            };

            // ── Create main window ─────────────────────────────────────────────
            //
            // Dev:     load Vite dev server (with HMR + API proxy to :4000).
            // Release: load from the sidecar we just started.
            #[cfg(debug_assertions)]
            let win_url = WebviewUrl::External("http://localhost:5173".parse().unwrap());
            #[cfg(not(debug_assertions))]
            let win_url = WebviewUrl::External(
                format!("http://localhost:{server_port}").parse().unwrap()
            );

            let _win = WebviewWindowBuilder::new(app, "main", win_url)
                .title("Blueprint")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                // In dev the window appears immediately; in release we reveal it
                // once the sidecar signals it is ready (see thread below).
                .visible(cfg!(debug_assertions))
                .decorations(true)
                .center()
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .build()?;

            // In release, wait for the sidecar's HTTP port, then show the window.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    wait_for_port(server_port);
                    show_window(&handle);
                });
            }

            // ── System tray ────────────────────────────────────────────────────
            let open_i = MenuItem::with_id(app, "open", "Open Blueprint", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Blueprint", true, None::<&str>)?;
            let menu   = Menu::with_items(app, &[
                &open_i,
                &PredefinedMenuItem::separator(app)?,
                &quit_i,
            ])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Blueprint")
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _      => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev {
                        let app = tray.app_handle();
                        match app.get_webview_window("main") {
                            Some(w) if w.is_visible().unwrap_or(false) => { let _ = w.hide(); }
                            _ => show_window(app),
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Hide the window on close instead of quitting — keep running in tray.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error running Blueprint");
}
