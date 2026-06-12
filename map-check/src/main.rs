// main.rs — DBD Map Checker
// Escuta globalmente a tecla TAB: captura screenshot após 100ms e roda OCR
// em thread separada para não travar o listener de teclado.

#![cfg_attr(
    all(windows, feature = "electron-subsystem"),
    windows_subsystem = "windows"
)]

mod map_detector;
use map_detector::{DbdMapDetector, MapCandidate, MapCatalog};

use rdev::{Event, EventType, Key, listen};
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::io::{self, Write};
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

// ── Motor de OCR inicializado uma vez ─────────────────────────────────────────
static DETECTOR: OnceLock<DbdMapDetector> = OnceLock::new();
static PRIMARY_MONITOR: OnceLock<PrimaryMonitorInfo> = OnceLock::new();
static CAPTURE_WORKER: OnceLock<CaptureWorker> = OnceLock::new();
const DEFAULT_LANG: &str = "en-us";
const FALLBACK_LANG: &str = "en-us";

struct PrimaryMonitorInfo {
    index: usize,
    width: u32,
    height: u32,
    name: String,
}

struct CaptureWorker {
    requests: Mutex<mpsc::Sender<mpsc::Sender<anyhow::Result<CapturedScreenshot>>>>,
}

struct CapturedScreenshot {
    image: image::RgbaImage,
    source: CaptureSource,
}

#[derive(Clone, Copy, Debug)]
enum CaptureSource {
    DbdWindow,
    MonitorFallback,
}

impl CaptureSource {
    fn label(self) -> &'static str {
        match self {
            Self::DbdWindow => "janela DBD",
            Self::MonitorFallback => "monitor fallback",
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::DbdWindow => "dbd_window",
            Self::MonitorFallback => "monitor_fallback",
        }
    }
}

#[derive(Debug)]
struct MapCatalogStatus {
    source: &'static str,
    schema: &'static str,
    count: usize,
    language: String,
    fallback_language: &'static str,
}

#[derive(Debug)]
struct MapCatalogLoad {
    maps: MapCatalog,
    status: MapCatalogStatus,
}

fn load_map_catalog(maps_json: Option<&str>, language: &str) -> anyhow::Result<MapCatalogLoad> {
    let language = normalize_lang(language);
    let json = maps_json.ok_or_else(|| anyhow::anyhow!("--maps-json e obrigatorio"))?;
    let (maps, schema) = parse_maps_json(json, &language)?;
    let count = maps.len();

    Ok(MapCatalogLoad {
        maps,
        status: MapCatalogStatus {
            source: "argv_json",
            schema,
            count,
            language,
            fallback_language: FALLBACK_LANG,
        },
    })
}

fn parse_maps_json(json: &str, language: &str) -> anyhow::Result<(MapCatalog, &'static str)> {
    let value: Value = serde_json::from_str(json)?;
    match value {
        Value::Array(rows) => Ok((parse_legacy_map_catalog(&rows)?, "legacy_pairs")),
        Value::Object(_) => Ok((
            parse_structured_map_catalog(&value, language)?,
            "structured",
        )),
        _ => anyhow::bail!("catalogo precisa ser array de pares ou objeto estruturado"),
    }
}

fn parse_legacy_map_catalog(rows: &[Value]) -> anyhow::Result<MapCatalog> {
    let mut maps = Vec::with_capacity(rows.len());

    for (index, row) in rows.iter().enumerate() {
        let row = row
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("item #{index} precisa ser array"))?;
        if row.len() != 2 {
            anyhow::bail!("item #{index} precisa ter exatamente 2 strings");
        }

        let candidate = value_as_non_empty_str(&row[0], "candidate", index)?;
        let canonical = value_as_non_empty_str(&row[1], "canonical", index)?;
        maps.push(MapCandidate {
            candidate,
            canonical,
            map_id: None,
            realm_id: None,
        });
    }

    ensure_catalog_not_empty(maps)
}

fn parse_structured_map_catalog(value: &Value, language: &str) -> anyhow::Result<MapCatalog> {
    let maps_value = value
        .get("maps")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("catalogo estruturado precisa de maps[]"))?;

    let languages = language_chain(language);
    let mut catalog = Vec::new();
    let mut seen = HashSet::new();

    for (realm_index, realm_value) in maps_value.iter().enumerate() {
        let realm = realm_value
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("maps[{realm_index}] precisa ser objeto"))?;
        let realm_id = string_field(realm_value, "realm_id")
            .or_else(|| string_field(realm_value, "id"))
            .unwrap_or_else(|| format!("REALM_{realm_index}"));
        let realm_aliases = realm.get("realm");
        let variations = realm
            .get("variations")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("maps[{realm_index}] precisa de variations[]"))?;

        for (variation_index, variation_value) in variations.iter().enumerate() {
            let map_id = string_field(variation_value, "id").ok_or_else(|| {
                anyhow::anyhow!("maps[{realm_index}].variations[{variation_index}].id ausente")
            })?;
            let canonical = string_field(variation_value, "canonical").ok_or_else(|| {
                anyhow::anyhow!(
                    "maps[{realm_index}].variations[{variation_index}].canonical ausente"
                )
            })?;
            let aliases = variation_value.get("aliases").ok_or_else(|| {
                anyhow::anyhow!("maps[{realm_index}].variations[{variation_index}].aliases ausente")
            })?;

            for lang in &languages {
                let variation_aliases = aliases_for_lang(aliases, lang);
                let realm_aliases = realm_aliases
                    .map(|aliases| aliases_for_lang(aliases, lang))
                    .unwrap_or_default();

                for alias in &variation_aliases {
                    push_map_candidate(
                        &mut catalog,
                        &mut seen,
                        alias,
                        &canonical,
                        &map_id,
                        &realm_id,
                    );

                    for realm_alias in &realm_aliases {
                        push_map_candidate(
                            &mut catalog,
                            &mut seen,
                            &format!("{realm_alias} - {alias}"),
                            &canonical,
                            &map_id,
                            &realm_id,
                        );
                    }
                }
            }

            push_map_candidate(
                &mut catalog,
                &mut seen,
                &canonical,
                &canonical,
                &map_id,
                &realm_id,
            );
        }
    }

    ensure_catalog_not_empty(catalog)
}

fn push_map_candidate(
    catalog: &mut MapCatalog,
    seen: &mut HashSet<String>,
    candidate: &str,
    canonical: &str,
    map_id: &str,
    realm_id: &str,
) {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return;
    }

    let key = format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        candidate.to_uppercase(),
        canonical,
        map_id,
        realm_id
    );
    if seen.insert(key) {
        catalog.push(MapCandidate {
            candidate: candidate.to_string(),
            canonical: canonical.to_string(),
            map_id: Some(map_id.to_string()),
            realm_id: Some(realm_id.to_string()),
        });
    }
}

fn aliases_for_lang(value: &Value, language: &str) -> Vec<String> {
    value
        .get(language)
        .or_else(|| value.get(&normalize_lang(language)))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn language_chain(language: &str) -> Vec<String> {
    let language = normalize_lang(language);
    if language == FALLBACK_LANG {
        vec![language]
    } else {
        vec![language, FALLBACK_LANG.to_string()]
    }
}

fn normalize_lang(language: &str) -> String {
    let language = language.trim().to_ascii_lowercase().replace('_', "-");
    if language.is_empty() {
        DEFAULT_LANG.to_string()
    } else {
        language
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn value_as_non_empty_str(value: &Value, field: &str, index: usize) -> anyhow::Result<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("item #{index} tem {field} vazio ou invalido"))
}

fn ensure_catalog_not_empty(maps: MapCatalog) -> anyhow::Result<MapCatalog> {
    if maps.is_empty() {
        anyhow::bail!("catalogo vazio");
    }

    Ok(maps)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputMode {
    Json,
    Dev,
}

struct CliConfig {
    output: OutputMode,
    maps_json: Option<String>,
    language: String,
}

impl CliConfig {
    fn from_args() -> Self {
        let mut output = if cfg!(debug_assertions) {
            OutputMode::Dev
        } else {
            OutputMode::Json
        };
        let mut maps_json = None;
        let mut language = DEFAULT_LANG.to_string();
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--json" | "--electron" => output = OutputMode::Json,
                "--dev" | "--human" => output = OutputMode::Dev,
                "--maps-json" => {
                    maps_json = Some(args.next().unwrap_or_default());
                }
                "--lang" | "--language" => {
                    language = normalize_lang(&args.next().unwrap_or_default());
                }
                _ => {}
            }

            if let Some(value) = arg.strip_prefix("--maps-json=") {
                maps_json = Some(value.to_string());
            }
            if let Some(value) = arg.strip_prefix("--lang=") {
                language = normalize_lang(value);
            }
            if let Some(value) = arg.strip_prefix("--language=") {
                language = normalize_lang(value);
            }
        }

        Self {
            output,
            maps_json,
            language,
        }
    }
}

impl OutputMode {
    fn is_dev(self) -> bool {
        self == Self::Dev
    }

    fn emit_ready(self, monitor: &PrimaryMonitorInfo, catalog: &MapCatalogStatus) {
        match self {
            Self::Dev => {
                println!(
                    "   Monitor primario: {} ({}x{}).",
                    monitor.name, monitor.width, monitor.height,
                );
                println!(
                    "   Catalogo de mapas: {} entradas ({} / {}, lang {}, fallback {})",
                    catalog.count,
                    catalog.source,
                    catalog.schema,
                    catalog.language,
                    catalog.fallback_language
                );
                println!("   ✓ OCR carregado e pronto.\n");
            }
            Self::Json => emit_json(format!(
                "{{\"type\":\"ready\",\"monitor\":{{\"name\":{},\"width\":{},\"height\":{}}},\"capture_preference\":\"dbd_window\",\"fallback\":\"monitor\",\"map_catalog\":{{\"source\":\"{}\",\"schema\":\"{}\",\"count\":{},\"language\":{},\"fallback_language\":\"{}\"}}}}",
                json_string(&monitor.name),
                monitor.width,
                monitor.height,
                catalog.source,
                catalog.schema,
                catalog.count,
                json_string(&catalog.language),
                catalog.fallback_language,
            )),
        }
    }

    fn emit_catalog_error(self, error: &str) {
        match self {
            Self::Dev => eprintln!("Erro no catalogo de mapas: {error}"),
            Self::Json => emit_json(format!(
                "{{\"type\":\"map_catalog_error\",\"error\":{}}}",
                json_string(error),
            )),
        }
    }

    fn emit_capture_error(self, error: &str) {
        match self {
            Self::Dev => eprintln!("Erro ao capturar screenshot: {error}\n"),
            Self::Json => emit_json(format!(
                "{{\"type\":\"capture_error\",\"error\":{}}}",
                json_string(error),
            )),
        }
    }

    fn emit_ocr_error(self, error: &str, capture: &CaptureMetrics) {
        match self {
            Self::Dev => eprintln!("❌ Erro OCR: {error}\n"),
            Self::Json => emit_json(format!(
                "{{\"type\":\"ocr_error\",\"error\":{},\"capture_source\":\"{}\",\"capture_ms\":{:.3},\"screenshot_width\":{},\"screenshot_height\":{}}}",
                json_string(error),
                capture.source.code(),
                duration_ms(capture.time),
                capture.width,
                capture.height,
            )),
        }
    }

    fn emit_map_not_found(
        self,
        capture: &CaptureMetrics,
        ocr_time: Duration,
        diagnostic: &map_detector::MapDetectionDiagnostic,
    ) {
        match self {
            Self::Dev => {
                println!("Mapa nao identificado");
                println!("    Motivo: {}", diagnostic.reason);
                println!("    OCR: {}", diagnostic.raw_ocr_text);
                println!("    Trecho analisado: {}", diagnostic.map_part);
                println!("    Threshold: {:.0}%", diagnostic.threshold * 100.0);
                println!("    Candidatos mais proximos:");
                for candidate in &diagnostic.candidates {
                    println!(
                        "      - {} via '{}' | map_id {:?} | realm_id {:?} | score {:.0}% | trecho {:.0}% | texto completo {:.0}%",
                        candidate.canonical,
                        candidate.candidate,
                        candidate.map_id.as_deref(),
                        candidate.realm_id.as_deref(),
                        candidate.score * 100.0,
                        candidate.map_part_score * 100.0,
                        candidate.full_text_score * 100.0,
                    );
                }
                println!();
            }
            Self::Json if false => {
                println!("⚠️  Mapa não identificado\n");
            }
            Self::Json => emit_json(json_map_not_found(capture, ocr_time, diagnostic)),
        }
    }

    fn emit_map_detected(
        self,
        result: &map_detector::MapDetectionResult,
        capture: &CaptureMetrics,
        ocr_time: Duration,
    ) {
        match self {
            Self::Dev => {
                println!(
                    "\n📸 Screenshot capturado ({w}x{h}) — rodando OCR...",
                    w = capture.width,
                    h = capture.height,
                );
                println!(
                    "Captura: {} em {:.2?}",
                    capture.source.label(),
                    capture.time
                );
                println!(
                    "🗺️  Mapa: {name}  (confiança: {conf:.0}%)",
                    name = result.map_name,
                    conf = result.confidence * 100.0,
                );
                println!("    OCR: {ocr_time:.2?}");
                println!("    OCR bruto: {}", result.raw_ocr_text);
                println!("    map_id: {:?}", result.map_id.as_deref());
                println!("    realm_id: {:?}", result.realm_id.as_deref());
                println!("→ Mapa confirmado: {}\n", result.map_name);
                println!("{}", "─".repeat(55));
            }
            Self::Json => emit_json(format!(
                "{{\"type\":\"map_detected\",\"map\":{},\"map_id\":{},\"realm_id\":{},\"confidence\":{:.4},\"raw_ocr_text\":{},\"capture_source\":\"{}\",\"capture_ms\":{:.3},\"ocr_ms\":{:.3},\"screenshot_width\":{},\"screenshot_height\":{}}}",
                json_string(&result.map_name),
                json_optional_string(result.map_id.as_deref()),
                json_optional_string(result.realm_id.as_deref()),
                result.confidence,
                json_string(&result.raw_ocr_text),
                capture.source.code(),
                duration_ms(capture.time),
                duration_ms(ocr_time),
                capture.width,
                capture.height,
            )),
        }
    }
}

struct CaptureMetrics {
    source: CaptureSource,
    time: Duration,
    width: u32,
    height: u32,
}

fn emit_json(line: String) {
    println!("{line}");
    let _ = io::stdout().flush();
}

fn duration_ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn json_optional_string(value: Option<&str>) -> String {
    value.map(json_string).unwrap_or_else(|| "null".to_string())
}

fn json_map_not_found(
    capture: &CaptureMetrics,
    ocr_time: Duration,
    diagnostic: &map_detector::MapDetectionDiagnostic,
) -> String {
    format!(
        "{{\"type\":\"map_not_found\",\"capture_source\":\"{}\",\"capture_ms\":{:.3},\"ocr_ms\":{:.3},\"screenshot_width\":{},\"screenshot_height\":{},\"diagnostic\":{{\"reason\":{},\"raw_ocr_text\":{},\"map_part\":{},\"threshold\":{:.4},\"candidates\":{}}}}}",
        capture.source.code(),
        duration_ms(capture.time),
        duration_ms(ocr_time),
        capture.width,
        capture.height,
        json_string(&diagnostic.reason),
        json_string(&diagnostic.raw_ocr_text),
        json_string(&diagnostic.map_part),
        diagnostic.threshold,
        json_candidates(&diagnostic.candidates),
    )
}

fn json_candidates(candidates: &[map_detector::FuzzyCandidate]) -> String {
    let items: Vec<String> = candidates
        .iter()
        .map(|candidate| {
            format!(
                "{{\"candidate\":{},\"canonical\":{},\"map_id\":{},\"realm_id\":{},\"score\":{:.4},\"map_part_score\":{:.4},\"full_text_score\":{:.4}}}",
                json_string(&candidate.candidate),
                json_string(&candidate.canonical),
                json_optional_string(candidate.map_id.as_deref()),
                json_optional_string(candidate.realm_id.as_deref()),
                candidate.score,
                candidate.map_part_score,
                candidate.full_text_score,
            )
        })
        .collect();

    format!("[{}]", items.join(","))
}

fn init_detector(maps: MapCatalog) -> &'static DbdMapDetector {
    let detector =
        DbdMapDetector::new_with_maps(maps).expect("Falha ao inicializar OCR ou catalogo de mapas");
    let _ = DETECTOR.set(detector);
    DETECTOR.get().expect("Detector nao inicializado")
}

fn get_detector() -> &'static DbdMapDetector {
    DETECTOR.get().expect("Detector nao inicializado")
}

// ── Guard contra processamento sobreposto ─────────────────────────────────────
static PROCESSING: AtomicBool = AtomicBool::new(false);

fn get_primary_monitor() -> &'static PrimaryMonitorInfo {
    PRIMARY_MONITOR.get_or_init(|| {
        let monitors = xcap::Monitor::all().expect("Falha ao listar monitores");
        let (index, primary) = monitors
            .iter()
            .enumerate()
            .find(|(_, m)| m.is_primary())
            .unwrap_or((0, &monitors[0]));

        PrimaryMonitorInfo {
            index,
            width: primary.width(),
            height: primary.height(),
            name: primary.name().to_string(),
        }
    })
}

fn get_capture_worker() -> &'static CaptureWorker {
    CAPTURE_WORKER.get_or_init(|| {
        let (request_tx, request_rx) =
            mpsc::channel::<mpsc::Sender<anyhow::Result<CapturedScreenshot>>>();
        let primary = get_primary_monitor();

        thread::Builder::new()
            .name("dbd-map-screen-capture".into())
            .spawn(move || {
                let monitor_result = capture_monitor_for(primary);
                match monitor_result {
                    Ok(monitor) => {
                        let mut dbd_window: Option<xcap::Window> = None;
                        for response_tx in request_rx {
                            let result =
                                capture_from_dbd_window_or_monitor(&mut dbd_window, &monitor);
                            let _ = response_tx.send(result);
                        }
                    }
                    Err(e) => {
                        let message = e.to_string();
                        for response_tx in request_rx {
                            let _ = response_tx.send(Err(anyhow::anyhow!(message.clone())));
                        }
                    }
                }
            })
            .expect("Falha ao iniciar worker de captura");

        CaptureWorker {
            requests: Mutex::new(request_tx),
        }
    })
}

fn capture_monitor_for(primary: &PrimaryMonitorInfo) -> anyhow::Result<xcap::Monitor> {
    let mut monitors = xcap::Monitor::all()?;
    if monitors.is_empty() {
        anyhow::bail!("Nenhum monitor encontrado");
    }

    let index_matches = monitors
        .get(primary.index)
        .map(|monitor| monitor.name() == primary.name)
        .unwrap_or(false);
    let position = if index_matches {
        primary.index
    } else {
        monitors
            .iter()
            .position(|monitor| monitor.is_primary())
            .unwrap_or(0)
    };

    Ok(monitors.swap_remove(position))
}

fn capture_from_dbd_window_or_monitor(
    dbd_window: &mut Option<xcap::Window>,
    monitor: &xcap::Monitor,
) -> anyhow::Result<CapturedScreenshot> {
    if let Some(window) = dbd_window.as_ref() {
        if let Ok(image) = window.capture_image() {
            return Ok(CapturedScreenshot {
                image,
                source: CaptureSource::DbdWindow,
            });
        }

        *dbd_window = None;
    }

    if let Ok(window) = find_dbd_window() {
        if let Ok(image) = window.capture_image() {
            *dbd_window = Some(window);
            return Ok(CapturedScreenshot {
                image,
                source: CaptureSource::DbdWindow,
            });
        }
    }

    let image = monitor.capture_image()?;
    Ok(CapturedScreenshot {
        image,
        source: CaptureSource::MonitorFallback,
    })
}

fn find_dbd_window() -> anyhow::Result<xcap::Window> {
    let mut windows = xcap::Window::all()?;
    let position = windows.iter().position(|window| {
        !window.is_minimized()
            && window.width() > 100
            && window.height() > 100
            && is_dbd_window(window)
    });

    match position {
        Some(position) => Ok(windows.swap_remove(position)),
        None => anyhow::bail!("Janela do Dead by Daylight nao encontrada"),
    }
}

fn is_dbd_window(window: &xcap::Window) -> bool {
    matches_dbd_name(window.title()) || matches_dbd_name(window.app_name())
}

fn matches_dbd_name(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let compact: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();

    lower.contains("dead by daylight") || compact.contains("deadbydaylight")
}

struct ProcessingGuard;

impl ProcessingGuard {
    fn try_acquire() -> Option<Self> {
        if PROCESSING.swap(true, Ordering::AcqRel) {
            None
        } else {
            Some(Self)
        }
    }
}

impl Drop for ProcessingGuard {
    fn drop(&mut self) {
        PROCESSING.store(false, Ordering::Release);
    }
}

// ── Captura real da tela com xcap ─────────────────────────────────────────────
fn capture_screenshot() -> anyhow::Result<(image::DynamicImage, Duration, CaptureSource)> {
    let started_at = Instant::now();
    let (response_tx, response_rx) = mpsc::channel();
    let worker = get_capture_worker();
    worker
        .requests
        .lock()
        .map_err(|_| anyhow::anyhow!("Worker de captura indisponivel"))?
        .send(response_tx)
        .map_err(|_| anyhow::anyhow!("Worker de captura encerrado"))?;
    let captured = response_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("Worker de captura nao respondeu"))??;
    Ok((
        image::DynamicImage::ImageRgba8(captured.image),
        started_at.elapsed(),
        captured.source,
    ))
}

// ── Entry point ───────────────────────────────────────────────────────────────
#[cfg(any())]
fn legacy_dev_main() {
    println!("🔍 DBD Map Checker iniciado");
    println!("   Pressione TAB no jogo para detectar o mapa.");
    println!("   Pressione ESC para sair.\n");

    // Força inicialização do OCR antes do primeiro TAB (roda na main thread)
    let _ = get_detector();
    let monitor = get_primary_monitor();
    let _ = get_capture_worker();
    println!(
        "   Monitor primario: {} ({}x{}).",
        monitor.name, monitor.width, monitor.height,
    );
    println!("   ✓ OCR carregado e pronto.\n");

    // ── Loop de eventos de teclado ────────────────────────────────────────────
    let callback = move |event: Event| {
        if let EventType::KeyPress(key) = event.event_type {
            match key {
                Key::Tab => {
                    // Ignora se já estiver processando um TAB anterior
                    let Some(guard) = ProcessingGuard::try_acquire() else {
                        return;
                    };

                    // Dispara processamento em thread separada — não bloqueia o listener
                    thread::spawn(|| {
                        let _guard = guard;

                        // Aguarda 50ms para a animação do tab screen terminar
                        thread::sleep(Duration::from_millis(50));

                        // Captura o screenshot com o mapa visível
                        let (screenshot, capture_time, capture_source) = match capture_screenshot()
                        {
                            Ok(result) => result,
                            Err(e) => {
                                eprintln!("Erro ao capturar screenshot: {e}\n");
                                return;
                            }
                        };
                        println!(
                            "\n📸 Screenshot capturado ({w}x{h}) — rodando OCR...",
                            w = screenshot.width(),
                            h = screenshot.height(),
                        );
                        println!("Captura: {} em {capture_time:.2?}", capture_source.label());

                        // Roda OCR
                        let detector = get_detector();
                        let ocr_started_at = Instant::now();
                        match detector.detect_map(&screenshot) {
                            Ok(Some(r)) => {
                                let ocr_time = ocr_started_at.elapsed();
                                println!(
                                    "🗺️  Mapa: {name}  (confiança: {conf:.0}%)",
                                    name = r.map_name,
                                    conf = r.confidence * 100.0,
                                );
                                println!("    OCR: {ocr_time:.2?}");
                                println!("    OCR bruto: {}", r.raw_ocr_text);
                                println!("→ Mapa confirmado: {}\n", r.map_name);
                            }
                            Ok(None) => println!("⚠️  Mapa não identificado\n"),
                            Err(e) => eprintln!("❌ Erro OCR: {e}\n"),
                        }

                        println!("{}", "─".repeat(55));
                    });
                }
                Key::Escape => {
                    println!("\n👋 Encerrando DBD Map Checker...");
                    std::process::exit(0);
                }
                _ => {}
            }
        }
    };

    if let Err(e) = listen(callback) {
        eprintln!("❌ Erro ao iniciar listener de teclado global: {e:?}");
        eprintln!("   Windows: verifique se o programa não está bloqueado pelo antivírus.");
        eprintln!("   Linux:   talvez precise rodar com sudo para capturar eventos globais.");
    }
}

// ── Teste de integração (modo offline com screenshot salvo) ───────────────────
fn main() {
    let cli = CliConfig::from_args();
    let output = cli.output;
    let catalog = match load_map_catalog(cli.maps_json.as_deref(), &cli.language) {
        Ok(catalog) => catalog,
        Err(error) => {
            output.emit_catalog_error(&error.to_string());
            process::exit(2);
        }
    };

    if output.is_dev() {
        println!("DBD Map Checker iniciado");
        println!("   Pressione TAB no jogo para detectar o mapa.");
        println!("   Pressione ESC para sair.\n");
    }

    let detector = init_detector(catalog.maps);
    let monitor = get_primary_monitor();
    let _ = get_capture_worker();
    debug_assert_eq!(detector.map_count(), catalog.status.count);
    output.emit_ready(monitor, &catalog.status);

    let callback = move |event: Event| {
        if let EventType::KeyPress(key) = event.event_type {
            match key {
                Key::Tab => {
                    let Some(guard) = ProcessingGuard::try_acquire() else {
                        return;
                    };

                    let output = output;
                    thread::spawn(move || {
                        let _guard = guard;
                        thread::sleep(Duration::from_millis(50));

                        let (screenshot, capture_time, capture_source) = match capture_screenshot()
                        {
                            Ok(result) => result,
                            Err(e) => {
                                output.emit_capture_error(&e.to_string());
                                return;
                            }
                        };

                        let capture = CaptureMetrics {
                            source: capture_source,
                            time: capture_time,
                            width: screenshot.width(),
                            height: screenshot.height(),
                        };

                        let detector = get_detector();
                        let ocr_started_at = Instant::now();
                        match detector.detect_map_detailed(&screenshot) {
                            Ok(detection) => match &detection.result {
                                Some(result) => output.emit_map_detected(
                                    result,
                                    &capture,
                                    ocr_started_at.elapsed(),
                                ),
                                None => output.emit_map_not_found(
                                    &capture,
                                    ocr_started_at.elapsed(),
                                    &detection.diagnostic,
                                ),
                            },
                            Err(e) => output.emit_ocr_error(&e.to_string(), &capture),
                        }
                    });
                }
                Key::Escape if output.is_dev() => {
                    println!("\nEncerrando DBD Map Checker...");
                    process::exit(0);
                }
                _ => {}
            }
        }
    };

    if let Err(e) = listen(callback) {
        let message = format!("{e:?}");
        match output {
            OutputMode::Dev => {
                eprintln!("Erro ao iniciar listener de teclado global: {message}");
                eprintln!("   Windows: verifique se o programa nao esta bloqueado pelo antivirus.");
                eprintln!("   Linux: talvez precise rodar com sudo para capturar eventos globais.");
            }
            OutputMode::Json => emit_json(format!(
                "{{\"type\":\"listener_error\",\"error\":{}}}",
                json_string(&message),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn test_map_catalog() -> MapCatalog {
        vec![MapCandidate {
            candidate: "TEST REALM - TEST MAP".to_string(),
            canonical: "TEST MAP".to_string(),
            map_id: Some("TEST_MAP".to_string()),
            realm_id: Some("TEST_REALM".to_string()),
        }]
    }

    #[test]
    fn parse_maps_json_accepts_pairs() {
        let (maps, schema) =
            parse_maps_json(r#"[["CASA DOS THOMPSON","THE THOMPSON HOUSE"]]"#, "en-us").unwrap();

        assert_eq!(schema, "legacy_pairs");
        assert_eq!(
            maps,
            vec![MapCandidate {
                candidate: "CASA DOS THOMPSON".to_string(),
                canonical: "THE THOMPSON HOUSE".to_string(),
                map_id: None,
                realm_id: None,
            }]
        );
    }

    #[test]
    fn parse_maps_json_rejects_invalid_shape() {
        let error = parse_maps_json(r#"[["CASA DOS THOMPSON"]]"#, "en-us").unwrap_err();

        assert!(error.to_string().contains("exatamente 2 strings"));
    }

    #[test]
    fn load_map_catalog_requires_maps_json() {
        let error = load_map_catalog(None, "pt-br").unwrap_err();

        assert!(error.to_string().contains("--maps-json"));
    }

    #[test]
    fn parse_maps_json_accepts_structured_catalog_with_language_fallback() {
        let json = r#"{
            "version": 1,
            "maps": [
                {
                    "realm_id": "COLDWIND_FARM",
                    "realm": {
                        "pt-br": ["FAZENDA COLDWIND"],
                        "en-us": ["COLDWIND FARM"]
                    },
                    "variations": [
                        {
                            "id": "THE_THOMPSON_HOUSE",
                            "canonical": "THE THOMPSON HOUSE",
                            "aliases": {
                                "pt-br": ["CASA DOS THOMPSON"],
                                "en-us": ["THE THOMPSON HOUSE"]
                            }
                        }
                    ]
                }
            ]
        }"#;

        let (maps, schema) = parse_maps_json(json, "pt-br").unwrap();

        assert_eq!(schema, "structured");
        assert!(maps.iter().any(|map| {
            map.candidate == "FAZENDA COLDWIND - CASA DOS THOMPSON"
                && map.canonical == "THE THOMPSON HOUSE"
                && map.map_id.as_deref() == Some("THE_THOMPSON_HOUSE")
                && map.realm_id.as_deref() == Some("COLDWIND_FARM")
        }));
        assert!(
            maps.iter()
                .any(|map| map.candidate == "COLDWIND FARM - THE THOMPSON HOUSE")
        );
    }

    #[test]
    fn integration_test_from_file() {
        if !std::path::Path::new("test_screenshot.png").exists() {
            eprintln!("Pulando: test_screenshot.png não encontrado");
            return;
        }

        let img = image::open("test_screenshot.png").unwrap();
        let detector = DbdMapDetector::new_with_maps(test_map_catalog()).unwrap();
        let result = detector.detect_map(&img).unwrap();

        match result {
            Some(r) => println!("Detectado: {} ({:.0}%)", r.map_name, r.confidence * 100.0),
            None => println!("Nenhum mapa detectado"),
        }
    }

    #[test]
    #[ignore = "captura a tela real; rode com --ignored para medir o ambiente atual"]
    fn bench_capture_screenshot() {
        const RUNS: u32 = 5;

        let _ = get_primary_monitor();
        let mut times: Vec<std::time::Duration> = Vec::with_capacity(RUNS as usize);

        println!("\nBenchmark de captura real da tela");
        for i in 0..RUNS {
            let (img, elapsed, source) = match capture_screenshot() {
                Ok(result) => result,
                Err(e) => {
                    eprintln!("Captura indisponivel neste contexto: {e}");
                    return;
                }
            };
            times.push(elapsed);
            println!(
                "   run #{i}: {:>8.2?}  ->  {}x{} ({})",
                elapsed,
                img.width(),
                img.height(),
                source.label(),
            );
        }

        let total: f64 = times.iter().map(|d| d.as_secs_f64()).sum();
        let avg = total / RUNS as f64;
        let min = times.iter().min().unwrap().as_secs_f64();
        let max = times.iter().max().unwrap().as_secs_f64();

        println!("   media:  {:>8.2?}", Duration::from_secs_f64(avg));
        println!("   minimo: {:>8.2?}", Duration::from_secs_f64(min));
        println!("   maximo: {:>8.2?}", Duration::from_secs_f64(max));
    }

    /// Benchmark dedicado: mede o tempo de cada etapa do reconhecimento.
    /// Roda 5 iterações (1 warmup + 4 medidas) e exibe estatísticas.
    #[test]
    fn bench_detect_map() {
        const WARMUP: u32 = 1;
        const RUNS: u32 = 5;
        const SEP: &str = "──────────────────────────────────────────────────────";

        let path = "test_screenshot.png";
        if !std::path::Path::new(path).exists() {
            eprintln!("⚠️  Pulando benchmark: {path} não encontrado.");
            eprintln!(
                "   Coloque um screenshot do tab screen do DBD em map-check/test_screenshot.png"
            );
            return;
        }

        println!("\n{SEP}");
        println!("🔬 BENCHMARK — Reconhecimento de mapa (OCR)");
        println!("{SEP}");

        // ── 1. Carga da imagem ────────────────────────────────────────────────
        let t_img = Instant::now();
        let img = image::open(path).expect("Falha ao abrir screenshot");
        let img_dims = (img.width(), img.height());
        let img_size_kb = std::fs::metadata(path).map(|m| m.len() / 1024).unwrap_or(0);
        println!(
            "🖼️  Screenshot: {path}  |  {w}×{h} px  |  {kb} KB  |  carregado em {t:?}",
            w = img_dims.0,
            h = img_dims.1,
            kb = img_size_kb,
            t = t_img.elapsed(),
        );

        // ── 2. Inicialização do motor OCR ─────────────────────────────────────
        let t_init = Instant::now();
        let detector = DbdMapDetector::new_with_maps(test_map_catalog())
            .expect("Falha ao inicializar detector");
        println!("🧠 Motor OCR inicializado em {:?}", t_init.elapsed());

        // ── 3. Warmup (cold run — compila shaders, aquece cache) ──────────────
        println!("\n🔥 Warmup ({WARMUP} run)...");
        for i in 0..WARMUP {
            let t = Instant::now();
            let _ = detector.detect_map(&img);
            println!("   warmup #{i}: {:?}", t.elapsed());
        }

        // ── 4. Rodadas medidas ────────────────────────────────────────────────
        println!("\n📏 Medindo {RUNS} execuções...\n");
        let mut times: Vec<std::time::Duration> = Vec::with_capacity(RUNS as usize);
        let mut results: Vec<Option<String>> = Vec::with_capacity(RUNS as usize);

        for i in 0..RUNS {
            let t = Instant::now();
            let result = detector.detect_map(&img);
            let elapsed = t.elapsed();
            times.push(elapsed);

            let map = match &result {
                Ok(Some(r)) => Some(format!("{}  ({:.0}%)", r.map_name, r.confidence * 100.0)),
                Ok(None) => Some("(não identificado)".into()),
                Err(_) => Some("(erro)".into()),
            };
            results.push(map);

            println!(
                "   run #{i}: {:>8.2?}  →  {}",
                elapsed,
                results.last().unwrap().as_deref().unwrap_or("???"),
            );
        }

        // ── 5. Estatísticas ───────────────────────────────────────────────────
        let total: f64 = times.iter().map(|d| d.as_secs_f64()).sum();
        let avg = total / RUNS as f64;
        let min = times.iter().min().unwrap().as_secs_f64();
        let max = times.iter().max().unwrap().as_secs_f64();
        // Desvio padrão amostral
        let variance = times
            .iter()
            .map(|d| (d.as_secs_f64() - avg).powi(2))
            .sum::<f64>()
            / (RUNS - 1) as f64;
        let stddev = variance.sqrt();

        println!("\n{SEP}");
        println!("📊 ESTATÍSTICAS  ({RUNS} execuções)");
        println!("{SEP}");
        println!("   Média:       {:>8.2?}", Duration::from_secs_f64(avg));
        println!("   Mínimo:      {:>8.2?}", Duration::from_secs_f64(min));
        println!("   Máximo:      {:>8.2?}", Duration::from_secs_f64(max));
        println!("   Desvio pad:  {:>8.2?}", Duration::from_secs_f64(stddev));
        println!("   Throughput:  {:>8.1} screenshots/s", 1.0 / avg);
        println!("{SEP}\n");

        // ── Validação: confere se detectou consistentemente ───────────────────
        let consistent = results.windows(2).all(|w| w[0] == w[1]);
        let first = results.first().and_then(|r| r.as_deref()).unwrap_or("???");
        println!("✅ Resultado consistente: {consistent}");
        println!("   Mapa detectado: {first}");

        // Assert suave: só falha se for absurdamente lento (> 30s = algo quebrado)
        let is_release = !cfg!(debug_assertions);
        if is_release {
            assert!(avg < 5.0, "OCR muito lento em release: média de {avg:.2}s");
        } else {
            println!(
                "💡 Modo DEBUG detectado — rode `cargo test --release bench_detect_map` para números reais."
            );
            if avg > 5.0 {
                println!(
                    "⚠️  Em release o tempo deve cair ~10× (estimado: {:.2}s)",
                    avg / 10.0
                );
            }
        }
    }
}
