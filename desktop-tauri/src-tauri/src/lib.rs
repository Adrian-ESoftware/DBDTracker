mod collector_parser;
mod database;

use database::{now_iso, Database};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tiny_http::{Header, Method, Response, Server};
use url::Url;

const STATISTICS_URL: &str = "https://stats.deadbydaylight.com/statistics/";
const HISTORY_URL: &str = "https://stats.deadbydaylight.com/match-history/";
const COLLECTOR_SCRIPT: &str = include_str!("../collector.js");

#[derive(Clone)]
struct Shared {
    db: Arc<Database>,
    status: Arc<Mutex<CollectorStatus>>,
    compact: Arc<Mutex<bool>>,
    click_through: Arc<Mutex<bool>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectorStatus {
    message: String,
    logged_in: bool,
    collecting: bool,
    last_run: Option<String>,
}

impl Default for CollectorStatus {
    fn default() -> Self {
        Self {
            message: "Iniciando coletor...".to_string(),
            logged_in: false,
            collecting: false,
            last_run: None,
        }
    }
}

#[tauri::command]
fn hide_overlay(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(to_string)
}

#[tauri::command]
fn toggle_size(window: WebviewWindow, state: tauri::State<'_, Shared>) -> Result<bool, String> {
    let mut compact = state.compact.lock().map_err(to_string)?;
    *compact = !*compact;
    let (width, height) = if *compact {
        (480.0, 620.0)
    } else {
        (1180.0, 760.0)
    };
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
        .map_err(to_string)?;
    Ok(*compact)
}

#[tauri::command]
fn show_login(app: AppHandle, state: tauri::State<'_, Shared>) -> Result<CollectorStatus, String> {
    let window = ensure_collector(&app, true)?;
    navigate(&window, STATISTICS_URL)?;
    window.show().map_err(to_string)?;
    window.set_focus().map_err(to_string)?;
    set_status(&app, &state, |status| {
        status.message = "Faca login na janela oficial e clique em Concluir login.".to_string();
    })
}

#[tauri::command]
async fn finish_login(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<CollectorStatus, String> {
    if let Some(window) = app.get_webview_window("collector") {
        let _ = window.hide();
    }
    collect_now(app, state).await
}

#[tauri::command]
async fn collect_now(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<CollectorStatus, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || collect_impl(&app, &shared))
        .await
        .map_err(to_string)?
}

#[tauri::command]
fn collector_status(state: tauri::State<'_, Shared>) -> Result<CollectorStatus, String> {
    state
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(to_string)
}

#[tauri::command]
fn ingest_collector_matches(
    state: tauri::State<'_, Shared>,
    matches: Value,
) -> Result<Value, String> {
    state.db.ingest_matches(matches)
}

#[tauri::command]
fn ingest_collector_snapshots(
    state: tauri::State<'_, Shared>,
    snapshots: Value,
) -> Result<Value, String> {
    state.db.ingest_snapshots(snapshots)
}

#[tauri::command]
fn ingest_collector_official_metrics(
    state: tauri::State<'_, Shared>,
    payload: Value,
) -> Result<Value, String> {
    state.db.ingest_official_metrics(payload)
}

#[tauri::command]
fn ingest_collector_official_sections(
    state: tauri::State<'_, Shared>,
    payload: Value,
) -> Result<Value, String> {
    state.db.ingest_official_sections(payload)
}

#[tauri::command]
fn ingest_collector_top_character(
    state: tauri::State<'_, Shared>,
    payload: Value,
) -> Result<Value, String> {
    state.db.ingest_top_character(payload)
}

#[tauri::command]
fn set_collector_status(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    status: Value,
) -> Result<Value, String> {
    update_login_status(&app, &state, status)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(to_string)?;
            fs::create_dir_all(&data_dir).map_err(to_string)?;
            let db = Arc::new(Database::open(&data_dir.join("dbd_tracker.sqlite3"))?);
            let shared = Shared {
                db,
                status: Arc::new(Mutex::new(CollectorStatus::default())),
                compact: Arc::new(Mutex::new(true)),
                click_through: Arc::new(Mutex::new(false)),
            };
            app.manage(shared.clone());
            start_http(shared.clone(), app.handle().clone())?;
            create_tray(app)?;
            register_shortcuts(app, shared.clone())?;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            let app_handle = app.handle().clone();
            thread::spawn(move || loop {
                let _ = collect_impl(&app_handle, &shared);
                thread::sleep(Duration::from_secs(60));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            hide_overlay,
            toggle_size,
            show_login,
            finish_login,
            collect_now,
            collector_status,
            ingest_collector_matches,
            ingest_collector_snapshots,
            ingest_collector_official_metrics,
            ingest_collector_official_sections,
            ingest_collector_top_character,
            set_collector_status
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar DBD Tracker Overlay");
}

fn create_tray(app: &mut tauri::App) -> Result<(), String> {
    let open = MenuItem::with_id(app, "open", "Abrir DBD Tracker", true, None::<&str>)
        .map_err(to_string)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>).map_err(to_string)?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(to_string)?;
    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .ok_or("icone padrao indisponivel")?
                .clone(),
        )
        .tooltip("DBD Tracker Overlay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    match window.is_visible() {
                        Ok(true) => {
                            let _ = window.hide();
                        }
                        _ => {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            }
        })
        .build(app)
        .map_err(to_string)?;
    Ok(())
}

fn register_shortcuts(app: &mut tauri::App, shared: Shared) -> Result<(), String> {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyF);
    let click = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyX);
    let toggle_handler = toggle.clone();
    let click_handler = click.clone();
    app.handle()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &toggle_handler {
                        if let Some(window) = app.get_webview_window("main") {
                            let click_through = shared
                                .click_through
                                .lock()
                                .map(|value| *value)
                                .unwrap_or(false);
                            if click_through {
                                if let Ok(mut value) = shared.click_through.lock() {
                                    *value = false;
                                }
                                let _ = window.set_ignore_cursor_events(false);
                                let _ = window.show();
                                let _ = app.emit(
                                    "collector-status",
                                    CollectorStatus {
                                        message: "Controle do mouse restaurado.".to_string(),
                                        ..shared
                                            .status
                                            .lock()
                                            .map(|s| s.clone())
                                            .unwrap_or_default()
                                    },
                                );
                            } else if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                            }
                        }
                    } else if shortcut == &click_handler {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(mut value) = shared.click_through.lock() {
                                *value = !*value;
                                let _ = window.set_ignore_cursor_events(*value);
                            }
                        }
                    }
                })
                .build(),
        )
        .map_err(to_string)?;
    app.global_shortcut().register(toggle).map_err(to_string)?;
    app.global_shortcut().register(click).map_err(to_string)?;
    Ok(())
}

fn start_http(shared: Shared, app: AppHandle) -> Result<(), String> {
    let server = Server::http(("127.0.0.1", 8765)).map_err(to_string)?;
    thread::spawn(move || {
        for request in server.incoming_requests() {
            handle_request(request, &shared, &app);
        }
    });
    Ok(())
}

fn handle_request(mut request: tiny_http::Request, shared: &Shared, app: &AppHandle) {
    let origin = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Origin"))
        .map(|header| header.value.as_str().to_string());
    if !origin.as_deref().map(allowed_origin).unwrap_or(true) {
        return reply(
            request,
            403,
            json!({ "detail": "Origin not allowed" }),
            origin,
        );
    }
    if request.method() == &Method::Options {
        return reply(request, 204, json!({}), origin);
    }

    let url = match Url::parse(&format!("http://127.0.0.1{}", request.url())) {
        Ok(url) => url,
        Err(error) => return reply(request, 400, json!({ "detail": error.to_string() }), origin),
    };
    let path = url.path().to_string();
    let method = request.method().clone();
    let body = read_json(&mut request);
    let result = match (method, path.as_str()) {
        (Method::Post, "/api/matches/bulk") => {
            body.and_then(|value| shared.db.ingest_matches(value))
        }
        (Method::Post, "/api/snapshots/bulk") => {
            body.and_then(|value| shared.db.ingest_snapshots(value))
        }
        (Method::Post, "/api/official-metrics") => {
            body.and_then(|value| shared.db.ingest_official_metrics(value))
        }
        (Method::Post, "/api/official-sections") => {
            body.and_then(|value| shared.db.ingest_official_sections(value))
        }
        (Method::Post, "/api/top-characters") => {
            body.and_then(|value| shared.db.ingest_top_character(value))
        }
        (Method::Post, "/api/collector/status") => {
            body.and_then(|value| update_login_status(app, shared, value))
        }
        (_, "/api/stats/overview") => shared.db.overview(),
        (_, "/api/stats/killers") => shared.db.killers(),
        (_, "/api/stats/maps") => shared.db.maps(),
        (_, "/api/stats/perks") => shared.db.perks(
            url.query_pairs()
                .find(|(key, _)| key == "scope")
                .map(|(_, value)| value.into_owned())
                .as_deref()
                .unwrap_or("all"),
        ),
        (_, "/api/stats/trends") => shared.db.trends(),
        (_, "/api/assets") => shared.db.asset_images(
            url.query_pairs()
                .find(|(key, _)| key == "type")
                .map(|(_, value)| value.into_owned())
                .as_deref(),
        ),
        (_, "/api/matches") => {
            let limit = url
                .query_pairs()
                .find(|(key, _)| key == "limit")
                .and_then(|(_, value)| value.parse::<i64>().ok())
                .unwrap_or(100)
                .min(500);
            shared.db.matches(limit)
        }
        (_, "/api/official-metrics") => shared.db.official_metrics(),
        (_, "/api/official-sections") => shared.db.official_sections(),
        (_, "/api/top-characters") => shared.db.top_characters(),
        (_, "/health") => Ok(json!({ "status": "ok" })),
        _ => Err("Not found".to_string()),
    };

    match result {
        Ok(value) => reply(request, 200, value, origin),
        Err(error) if error == "Not found" => {
            reply(request, 404, json!({ "detail": error }), origin)
        }
        Err(error) => reply(request, 500, json!({ "detail": error }), origin),
    }
}

fn read_json(request: &mut tiny_http::Request) -> Result<Value, String> {
    let mut text = String::new();
    request
        .as_reader()
        .read_to_string(&mut text)
        .map_err(to_string)?;
    serde_json::from_str(if text.trim().is_empty() {
        "null"
    } else {
        &text
    })
    .map_err(to_string)
}

fn reply(request: tiny_http::Request, status: u16, body: Value, origin: Option<String>) {
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    for (name, value) in [
        ("content-type", "application/json; charset=utf-8"),
        ("access-control-allow-methods", "GET, POST, OPTIONS"),
        ("access-control-allow-headers", "content-type"),
    ] {
        response.add_header(Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap());
    }
    if let Some(origin) = origin.filter(|origin| allowed_origin(origin)) {
        response.add_header(
            Header::from_bytes("access-control-allow-origin", origin.as_bytes()).unwrap(),
        );
    }
    let _ = request.respond(response);
}

fn allowed_origin(origin: &str) -> bool {
    origin.starts_with("https://stats.deadbydaylight.com")
        || origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("http://localhost:")
}

fn update_login_status(app: &AppHandle, shared: &Shared, value: Value) -> Result<Value, String> {
    let logged_in = value
        .get("loggedIn")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(if logged_in {
            "Sessao oficial ativa."
        } else {
            "Sessao expirada. Abra o login uma vez."
        });
    set_status(app, shared, |status| {
        status.logged_in = logged_in;
        status.message = message.to_string();
    })?;
    Ok(json!({ "ok": true }))
}

fn ensure_collector(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("collector") {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        "collector",
        WebviewUrl::External(Url::parse(STATISTICS_URL).map_err(to_string)?),
    )
    .title("DBD Tracker - Login oficial")
    .inner_size(1180.0, 820.0)
    .visible(visible)
    .build()
    .map_err(to_string)?;
    attach_network_collector(&window, app.clone())?;
    Ok(window)
}

fn navigate(window: &WebviewWindow, url: &str) -> Result<(), String> {
    window
        .eval(&format!("window.location.href = {};", json!(url)))
        .map_err(to_string)
}

fn collect_impl(app: &AppHandle, shared: &Shared) -> Result<CollectorStatus, String> {
    {
        let current = shared.status.lock().map_err(to_string)?;
        if current.collecting {
            return Ok(current.clone());
        }
    }
    set_status(app, shared, |status| {
        status.collecting = true;
        status.message = "Atualizando dados em segundo plano...".to_string();
    })?;

    let result = (|| {
        let window = ensure_collector(app, false)?;
        navigate(&window, STATISTICS_URL)?;
        thread::sleep(Duration::from_secs(4));
        window.eval(COLLECTOR_SCRIPT).map_err(to_string)?;
        thread::sleep(Duration::from_secs(2));
        navigate(&window, HISTORY_URL)?;
        thread::sleep(Duration::from_secs(4));
        window.eval(COLLECTOR_SCRIPT).map_err(to_string)?;
        Ok::<(), String>(())
    })();

    match result {
        Ok(()) => set_status(app, shared, |status| {
            status.collecting = false;
            status.logged_in = true;
            status.last_run = Some(now_iso());
            status.message = "Dados atualizados automaticamente.".to_string();
        }),
        Err(error) => set_status(app, shared, |status| {
            status.collecting = false;
            status.message = format!("Falha na coleta: {error}");
        }),
    }
}

fn set_status<F>(app: &AppHandle, shared: &Shared, update: F) -> Result<CollectorStatus, String>
where
    F: FnOnce(&mut CollectorStatus),
{
    let payload = {
        let mut status = shared.status.lock().map_err(to_string)?;
        update(&mut status);
        status.clone()
    };
    app.emit("collector-status", payload.clone())
        .map_err(to_string)?;
    Ok(payload)
}

fn to_string(error: impl ToString) -> String {
    error.to_string()
}

#[cfg(windows)]
fn attach_network_collector(window: &WebviewWindow, app: AppHandle) -> Result<(), String> {
    use serde_json::Value;
    use std::{collections::HashMap, sync::Mutex};
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler,
    };
    use windows::core::HSTRING;

    let shared = app.state::<Shared>().inner().clone();
    let pending = Arc::new(Mutex::new(HashMap::<String, String>::new()));
    window
        .with_webview(move |platform| unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let noop = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
            let network_enable = HSTRING::from("Network.enable");
            let empty_params = HSTRING::from("{}");
            let _ = core.CallDevToolsProtocolMethod(&network_enable, &empty_params, &noop);

            let response_received = HSTRING::from("Network.responseReceived");
            let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(&response_received) else {
                return;
            };
            let mut token = 0;
            let pending_events = pending.clone();
            let event_handler =
                DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
                    let Some(sender) = sender else {
                        return Ok(());
                    };
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut event_json_ptr = windows::core::PWSTR::null();
                    if args.ParameterObjectAsJson(&mut event_json_ptr).is_err()
                        || event_json_ptr.is_null()
                    {
                        return Ok(());
                    }
                    let event_json = event_json_ptr.to_string().unwrap_or_default();
                    let Ok(event): Result<Value, _> = serde_json::from_str(&event_json) else {
                        return Ok(());
                    };
                    let request_id = event
                        .get("requestId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let response = event.get("response").unwrap_or(&Value::Null);
                    let url = response
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let mime_type = response
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    let resource_type = event
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    let interesting = (resource_type == "xhr" || resource_type == "fetch")
                        && (mime_type.contains("json")
                            || url.to_ascii_lowercase().contains("match")
                            || url.to_ascii_lowercase().contains("stat")
                            || url.to_ascii_lowercase().contains("history")
                            || url.to_ascii_lowercase().contains("player"));
                    if request_id.is_empty() || url.is_empty() || !interesting {
                        return Ok(());
                    }
                    if let Ok(mut pending) = pending_events.lock() {
                        pending.insert(request_id.clone(), url.clone());
                    }

                    let shared = shared.clone();
                    let app = app.clone();
                    let pending_bodies = pending_events.clone();
                    let params = json!({ "requestId": request_id }).to_string();
                    let get_response_body = HSTRING::from("Network.getResponseBody");
                    let params = HSTRING::from(params);
                    let body_handler = CallDevToolsProtocolMethodCompletedHandler::create(
                        Box::new(move |result, body_json| {
                            if result.is_err() {
                                return Ok(());
                            }
                            let Ok(body_result): Result<Value, _> =
                                serde_json::from_str(&body_json)
                            else {
                                return Ok(());
                            };
                            let body = body_result
                                .get("body")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let Ok(payload): Result<Value, _> = serde_json::from_str(body) else {
                                return Ok(());
                            };
                            let source_url = pending_bodies
                                .lock()
                                .ok()
                                .and_then(|mut pending| pending.remove(&request_id))
                                .unwrap_or_else(|| url.clone());
                            match collector_parser::process_payload(
                                &shared.db,
                                &source_url,
                                payload,
                            ) {
                                Ok(count) if count > 0 => {
                                    let _ = set_status(&app, &shared, |status| {
                                        status.logged_in = true;
                                        status.message = format!(
                                            "{count} partida(s) capturada(s) via WebView2."
                                        );
                                    });
                                }
                                Ok(_) => {}
                                Err(error) => {
                                    let _ = set_status(&app, &shared, |status| {
                                        status.message =
                                            format!("Falha ao processar resposta: {error}");
                                    });
                                }
                            }
                            Ok(())
                        }),
                    );
                    let _ = sender.CallDevToolsProtocolMethod(
                        &get_response_body,
                        &params,
                        &body_handler,
                    );
                    Ok(())
                }));
            let _ = receiver.add_DevToolsProtocolEventReceived(&event_handler, &mut token);
        })
        .map_err(to_string)
}

#[cfg(not(windows))]
fn attach_network_collector(_window: &WebviewWindow, _app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::allowed_origin;

    #[test]
    fn allows_tauri_and_official_origins() {
        assert!(allowed_origin("tauri://localhost"));
        assert!(allowed_origin("http://tauri.localhost"));
        assert!(allowed_origin("http://127.0.0.1:1420"));
        assert!(allowed_origin("https://stats.deadbydaylight.com"));
        assert!(!allowed_origin("https://example.com"));
    }
}
