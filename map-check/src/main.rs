// main.rs — DBD Map Checker
// Escuta globalmente a tecla TAB: captura screenshot após 100ms e roda OCR
// em thread separada para não travar o listener de teclado.

#![cfg_attr(
    all(windows, feature = "electron-subsystem"),
    windows_subsystem = "windows"
)]

mod map_detector;
use map_detector::DbdMapDetector;

use rdev::{Event, EventType, Key, listen};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputMode {
    Json,
    Dev,
}

impl OutputMode {
    fn from_args() -> Self {
        let mut mode = if cfg!(debug_assertions) {
            Self::Dev
        } else {
            Self::Json
        };

        for arg in env::args().skip(1) {
            match arg.as_str() {
                "--json" | "--electron" => mode = Self::Json,
                "--dev" | "--human" => mode = Self::Dev,
                _ => {}
            }
        }

        mode
    }

    fn is_dev(self) -> bool {
        self == Self::Dev
    }

    fn emit_ready(self, monitor: &PrimaryMonitorInfo) {
        match self {
            Self::Dev => {
                println!(
                    "   Monitor primario: {} ({}x{}).",
                    monitor.name, monitor.width, monitor.height,
                );
                println!("   ✓ OCR carregado e pronto.\n");
            }
            Self::Json => emit_json(format!(
                "{{\"type\":\"ready\",\"monitor\":{{\"name\":{},\"width\":{},\"height\":{}}},\"capture_preference\":\"dbd_window\",\"fallback\":\"monitor\"}}",
                json_string(&monitor.name),
                monitor.width,
                monitor.height,
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
                        "      - {} via '{}' | score {:.0}% | trecho {:.0}% | texto completo {:.0}%",
                        candidate.canonical,
                        candidate.candidate,
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
                println!("→ Mapa confirmado: {}\n", result.map_name);
                println!("{}", "─".repeat(55));
            }
            Self::Json => emit_json(format!(
                "{{\"type\":\"map_detected\",\"map\":{},\"confidence\":{:.4},\"raw_ocr_text\":{},\"capture_source\":\"{}\",\"capture_ms\":{:.3},\"ocr_ms\":{:.3},\"screenshot_width\":{},\"screenshot_height\":{}}}",
                json_string(&result.map_name),
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
                "{{\"candidate\":{},\"canonical\":{},\"score\":{:.4},\"map_part_score\":{:.4},\"full_text_score\":{:.4}}}",
                json_string(&candidate.candidate),
                json_string(&candidate.canonical),
                candidate.score,
                candidate.map_part_score,
                candidate.full_text_score,
            )
        })
        .collect();

    format!("[{}]", items.join(","))
}

fn get_detector() -> &'static DbdMapDetector {
    DETECTOR.get_or_init(|| {
        DbdMapDetector::new().expect("Falha ao inicializar OCR — verifique assets/")
    })
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
    let output = OutputMode::from_args();

    if output.is_dev() {
        println!("DBD Map Checker iniciado");
        println!("   Pressione TAB no jogo para detectar o mapa.");
        println!("   Pressione ESC para sair.\n");
    }

    let _ = get_detector();
    let monitor = get_primary_monitor();
    let _ = get_capture_worker();
    output.emit_ready(monitor);

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

    #[test]
    fn integration_test_from_file() {
        if !std::path::Path::new("test_screenshot.png").exists() {
            eprintln!("Pulando: test_screenshot.png não encontrado");
            return;
        }

        let img = image::open("test_screenshot.png").unwrap();
        let detector = DbdMapDetector::new().unwrap();
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
        let detector = DbdMapDetector::new().expect("Falha ao inicializar detector");
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
