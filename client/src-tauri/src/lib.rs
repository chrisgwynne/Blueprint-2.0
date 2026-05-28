use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

// ── Release-only imports ──────────────────────────────────────────────────────
#[cfg(not(debug_assertions))]
use tauri_plugin_autostart::ManagerExt;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

// ── Embedded status icons (compiled into the binary) ─────────────────────────
static ICON_HEALTHY:  &[u8] = include_bytes!("../icons/tray-healthy.png");
static ICON_DEGRADED: &[u8] = include_bytes!("../icons/tray-degraded.png");
static ICON_CRITICAL: &[u8] = include_bytes!("../icons/tray-critical.png");

// ── Shared state ──────────────────────────────────────────────────────────────

#[derive(Clone, Default, PartialEq)]
enum Health { #[default] Unknown, Healthy, Degraded, Critical }

#[derive(Clone)]
struct Task { id: String, title: String }

#[derive(Clone, Default)]
struct PollState {
    health:    Health,
    tasks:     Vec<Task>,
    known_ids: HashSet<String>,
}

/// App-wide config stored in Tauri managed state so all closures can reach it.
struct Config {
    port:           u16,
    internal_token: String,
    /// tray menu-item-id → (task_id, is_approve) — rebuilt each tray refresh.
    task_actions:   Mutex<HashMap<String, (String, bool)>>,
}

// ── Release-only helpers ──────────────────────────────────────────────────────

#[cfg(not(debug_assertions))]
struct ManagedServer(tauri_plugin_shell::process::CommandChild);

#[cfg(not(debug_assertions))]
impl Drop for ManagedServer {
    fn drop(&mut self) { let _ = self.0.kill(); }
}

#[cfg(not(debug_assertions))]
fn find_free_port() -> u16 {
    use std::net::TcpListener;
    TcpListener::bind("127.0.0.1:0")
        .map(|l| l.local_addr().unwrap().port())
        .unwrap_or(4000)
}

#[cfg(not(debug_assertions))]
fn wait_for_port(port: u16) {
    use std::net::TcpStream;
    for _ in 0..120 {
        if TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
            std::thread::sleep(Duration::from_millis(400));
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Fast, non-cryptographic secret for first-launch defaults.
/// The user should rotate their admin password via Settings → Security.
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
    let v1 = h.finish(); v1.hash(&mut h);
    let v2 = h.finish(); v2.hash(&mut h);
    let v3 = h.finish();
    format!("{v1:016x}{v2:016x}{v3:016x}").chars().take(len).collect()
}

// ── Window helpers ────────────────────────────────────────────────────────────

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ── Tray: icon + tooltip + menu ────────────────────────────────────────────────

fn refresh_tray(app: &AppHandle, state: &PollState) {
    let Some(tray) = app.tray_by_id("main") else { return };

    let icon_bytes: &[u8] = match state.health {
        Health::Critical => ICON_CRITICAL,
        Health::Degraded => ICON_DEGRADED,
        _                => ICON_HEALTHY,
    };
    if let Ok(icon) = Image::from_bytes(icon_bytes) {
        let _ = tray.set_icon(Some(icon));
    }

    let n = state.tasks.len();
    let tooltip = match &state.health {
        Health::Critical => "Blueprint — critical issue".into(),
        Health::Degraded => "Blueprint — degraded".into(),
        _ if n > 0 => format!("Blueprint — {n} task{} pending", if n == 1 { "" } else { "s" }),
        _ => "Blueprint".into(),
    };
    let _ = tray.set_tooltip(Some(&tooltip));

    if let Ok(menu) = build_tray_menu(app, state) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_tray_menu(app: &AppHandle, state: &PollState) -> tauri::Result<Menu<tauri::Wry>> {
    // Refresh the task-action lookup table every time we rebuild the menu.
    {
        let config = app.state::<Config>();
        config.task_actions.lock().unwrap().clear();
    }

    let menu = Menu::new(app)?;

    // ── Health status (non-clickable) ─────────────────────────────────────────
    let health_label = match state.health {
        Health::Critical => "✕  System critical — check dashboard",
        Health::Degraded => "⚠  System degraded",
        Health::Healthy  => "●  System healthy",
        Health::Unknown  => "○  Connecting…",
    };
    menu.append(&MenuItem::with_id(app, "health", health_label, false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // ── Pending approvals ─────────────────────────────────────────────────────
    if state.tasks.is_empty() {
        menu.append(&MenuItem::with_id(
            app, "no-tasks", "No pending approvals", false, None::<&str>,
        )?)?;
    } else {
        let n = state.tasks.len();
        menu.append(&MenuItem::with_id(
            app, "task-header",
            &format!("{n} task{} need approval", if n == 1 { "" } else { "s" }),
            false, None::<&str>,
        )?)?;

        let config = app.state::<Config>();
        let mut actions = config.task_actions.lock().unwrap();

        for (i, task) in state.tasks.iter().take(5).enumerate() {
            let title: String = task.title.chars().take(44).collect();
            let suffix = if task.title.len() > 44 { "…" } else { "" };

            let ap_id = format!("ap-{i}");
            let re_id = format!("re-{i}");
            actions.insert(ap_id.clone(), (task.id.clone(), true));
            actions.insert(re_id.clone(), (task.id.clone(), false));

            menu.append(&MenuItem::with_id(
                app, &format!("tt-{i}"), &format!("  {title}{suffix}"),
                false, None::<&str>,
            )?)?;
            menu.append(&MenuItem::with_id(app, &ap_id, "     ✓  Approve", true, None::<&str>)?)?;
            menu.append(&MenuItem::with_id(app, &re_id, "     ✕  Reject",  true, None::<&str>)?)?;
        }

        if state.tasks.len() > 5 {
            menu.append(&MenuItem::with_id(
                app, "more-tasks",
                &format!("  +{} more — open dashboard", state.tasks.len() - 5),
                true, None::<&str>,
            )?)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Blueprint", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    // ── Launch at login (release only) ────────────────────────────────────────
    #[cfg(not(debug_assertions))]
    {
        let enabled = app.autolaunch().is_enabled().unwrap_or(false);
        let label = if enabled { "Launch at Login  ✓" } else { "Launch at Login" };
        menu.append(&MenuItem::with_id(app, "autostart", label, true, None::<&str>)?)?;
    }

    menu.append(&MenuItem::with_id(app, "quit", "Quit Blueprint", true, None::<&str>)?)?;
    Ok(menu)
}

// ── Notifications ─────────────────────────────────────────────────────────────

fn notify_new_tasks(app: &AppHandle, tasks: &[Task]) {
    let n = tasks.len();
    let body = if n == 1 {
        format!("\u{201c}{}\u{201d} needs your approval", tasks[0].title)
    } else {
        format!("{n} tasks need your approval")
    };
    let _ = app.notification()
        .builder()
        .title("Blueprint — Action required")
        .body(&body)
        .show();
}

// ── Menu event dispatch ───────────────────────────────────────────────────────

fn on_menu_event(app: &AppHandle, id: &str, poll_state: &Arc<Mutex<PollState>>) {
    match id {
        "open" | "more-tasks" => show_window(app),

        "quit" => app.exit(0),

        #[cfg(not(debug_assertions))]
        "autostart" => {
            let al = app.autolaunch();
            if al.is_enabled().unwrap_or(false) {
                let _ = al.disable();
            } else {
                let _ = al.enable();
            }
            let snap = poll_state.lock().unwrap().clone();
            refresh_tray(app, &snap);
        }

        id if id.starts_with("ap-") || id.starts_with("re-") => {
            let config = app.state::<Config>();
            let action = config.task_actions.lock().unwrap().get(id).cloned();
            if let Some((task_id, is_approve)) = action {
                let port  = config.port;
                let token = config.internal_token.clone();
                let ps    = poll_state.clone();
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let verb = if is_approve { "approve" } else { "reject" };
                    let url  = format!("http://127.0.0.1:{port}/api/tasks/{task_id}/{verb}");
                    if let Ok(client) = reqwest::Client::builder()
                        .timeout(Duration::from_secs(8))
                        .build()
                    {
                        let _ = client
                            .patch(&url)
                            .header("authorization", format!("Bearer {token}"))
                            .json(&serde_json::json!({"note": "Actioned via Blueprint Mac app"}))
                            .send()
                            .await;
                    }
                    // Remove from local list immediately for snappy feedback.
                    let snap = {
                        let mut st = ps.lock().unwrap();
                        st.tasks.retain(|t| t.id != task_id);
                        st.known_ids.remove(&task_id);
                        st.clone()
                    };
                    refresh_tray(&handle, &snap);
                });
            }
        }

        _ => {}
    }
}

// ── Background polling loop ───────────────────────────────────────────────────

async fn polling_loop(app: AppHandle, poll_state: Arc<Mutex<PollState>>) {
    let (port, token) = {
        let cfg = app.state::<Config>();
        (cfg.port, cfg.internal_token.clone())
    };

    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    else { return };

    let mut interval = tokio::time::interval(Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;

        let url = format!("http://127.0.0.1:{port}/api/internal/status");
        let Ok(resp) = client
            .get(&url)
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
        else { continue };

        let Ok(data): Result<serde_json::Value, _> = resp.json().await else { continue };

        let health = match data["health"].as_str() {
            Some("healthy")  => Health::Healthy,
            Some("degraded") => Health::Degraded,
            Some("critical") => Health::Critical,
            _                => Health::Unknown,
        };

        let tasks: Vec<Task> = data["tasks"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|t| Some(Task {
                id:    t["id"].as_str()?.to_string(),
                title: t["title"].as_str().unwrap_or("Untitled task").to_string(),
            }))
            .collect();

        // Detect tasks that weren't in the previous poll.
        let new_tasks: Vec<Task> = {
            let st = poll_state.lock().unwrap();
            tasks.iter().filter(|t| !st.known_ids.contains(&t.id)).cloned().collect()
        };

        if !new_tasks.is_empty() {
            notify_new_tasks(&app, &new_tasks);
        }

        let snap = {
            let mut st = poll_state.lock().unwrap();
            st.health    = health;
            st.known_ids = tasks.iter().map(|t| t.id.clone()).collect();
            st.tasks     = tasks;
            st.clone()
        };

        refresh_tray(&app, &snap);
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run() {
    let poll_state: Arc<Mutex<PollState>> = Arc::new(Mutex::new(PollState::default()));

    // Build plugin chain — autostart only in release builds.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    builder
        .setup(move |app| {
            // Request macOS notification permission on first launch.
            let _ = app.notification().request_permission();

            // ── Release: start the bundled server sidecar ──────────────────────
            #[cfg(not(debug_assertions))]
            let (port, internal_token) = {
                let app_data = app.path().app_data_dir()?;
                std::fs::create_dir_all(app_data.join("data"))?;
                std::fs::create_dir_all(app_data.join("kb"))?;
                std::fs::create_dir_all(app_data.join("agents"))?;

                // Write default secrets on first launch.
                let env_file = app_data.join(".env");
                if !env_file.exists() {
                    std::fs::write(&env_file, format!(
                        "SESSION_SECRET={}\n\
                         ENCRYPTION_KEY={}\n\
                         ADMIN_USERNAME=admin\n\
                         ADMIN_PASSWORD=blueprint\n",
                        gen_secret(48), gen_secret(32),
                    ))?;
                }

                let port = find_free_port();
                let tok  = gen_secret(48);
                let resource_dir = app.path().resource_dir()?;

                let (mut rx, child) = app.shell()
                    .sidecar("blueprint-server")?
                    .env("PORT",                     port.to_string())
                    .env("NODE_ENV",                 "production")
                    .env("DATABASE_PATH",            app_data.join("data/blueprint.db").to_str().unwrap_or(""))
                    .env("KB_PATH",                  app_data.join("kb").to_str().unwrap_or(""))
                    .env("AGENTS_DIR",               app_data.join("agents").to_str().unwrap_or(""))
                    .env("CLIENT_DIST_PATH",         resource_dir.join("dist").to_str().unwrap_or(""))
                    .env("PROJECT_ROOT",             app_data.to_str().unwrap_or(""))
                    .env("BLUEPRINT_SIDECAR",        "1")
                    .env("BLUEPRINT_INTERNAL_TOKEN", &tok)
                    .env("DISABLE_TELEGRAM",         "true")
                    .spawn()?;

                tauri::async_runtime::spawn(async move {
                    while let Some(ev) = rx.recv().await {
                        let b = match ev {
                            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => b,
                            _ => continue,
                        };
                        eprintln!("[bp] {}", String::from_utf8_lossy(&b).trim_end());
                    }
                });

                app.manage(Arc::new(Mutex::new(ManagedServer(child))));
                (port, tok)
            };

            // Dev: server already running from beforeDevCommand.
            #[cfg(debug_assertions)]
            let (port, internal_token) = (
                4000u16,
                std::env::var("BLUEPRINT_INTERNAL_TOKEN")
                    .unwrap_or_else(|_| "dev-token".to_string()),
            );

            // Store config in managed state.
            app.manage(Config {
                port,
                internal_token: internal_token.clone(),
                task_actions: Mutex::new(HashMap::new()),
            });

            // ── Main window ────────────────────────────────────────────────────
            #[cfg(debug_assertions)]
            let win_url = WebviewUrl::External("http://localhost:5173".parse().unwrap());
            #[cfg(not(debug_assertions))]
            let win_url = WebviewUrl::External(
                format!("http://localhost:{port}").parse().unwrap()
            );

            WebviewWindowBuilder::new(app, "main", win_url)
                .title("Blueprint")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .visible(cfg!(debug_assertions))
                .decorations(true)
                .center()
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .build()?;

            // Show the window once the sidecar's HTTP port accepts connections.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || { wait_for_port(port); show_window(&handle); });
            }

            // ── System tray ────────────────────────────────────────────────────
            let init_state = PollState::default();
            let init_menu  = build_tray_menu(app, &init_state)?;
            let init_icon  = Image::from_bytes(ICON_HEALTHY)?;
            let ps_menu    = poll_state.clone();

            TrayIconBuilder::new()
                .id("main")
                .icon(init_icon)
                .icon_as_template(false)   // keep colours for status indication
                .menu(&init_menu)
                .tooltip("Blueprint")
                .on_menu_event(move |app, ev| {
                    on_menu_event(app, ev.id.as_ref(), &ps_menu);
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up, ..
                    } = ev {
                        let app = tray.app_handle();
                        match app.get_webview_window("main") {
                            Some(w) if w.is_visible().unwrap_or(false) => { let _ = w.hide(); }
                            _ => show_window(app),
                        }
                    }
                })
                .build(app)?;

            // ── Start background polling ───────────────────────────────────────
            let handle      = app.handle().clone();
            let ps_poll     = poll_state.clone();
            // Give the sidecar a few extra seconds before the first poll.
            #[cfg(debug_assertions)]
            let warm_up = Duration::from_secs(2);
            #[cfg(not(debug_assertions))]
            let warm_up = Duration::from_secs(6);

            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(warm_up).await;
                polling_loop(handle, ps_poll).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray on close instead of quitting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error running Blueprint");
}
