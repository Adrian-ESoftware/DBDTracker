// main.rs — DBD Map Checker
// Escuta globalmente a tecla TAB: captura screenshot após 100ms e roda OCR
// em thread separada para não travar o listener de teclado.

mod map_detector;
use map_detector::DbdMapDetector;

use rdev::{listen, Event, EventType, Key};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

// ── Motor de OCR inicializado uma vez ─────────────────────────────────────────
static DETECTOR: OnceLock<DbdMapDetector> = OnceLock::new();

fn get_detector() -> &'static DbdMapDetector {
    DETECTOR.get_or_init(|| {
        DbdMapDetector::new().expect("Falha ao inicializar OCR — verifique assets/")
    })
}

// ── Guard contra processamento sobreposto ─────────────────────────────────────
static PROCESSING: AtomicBool = AtomicBool::new(false);

// ── Captura real da tela com xcap ─────────────────────────────────────────────
fn capture_screenshot() -> image::DynamicImage {
    let monitors = xcap::Monitor::all().expect("Falha ao listar monitores");
    let primary = monitors
        .iter()
        .find(|m| m.is_primary())
        .unwrap_or(&monitors[0]);
    let img = primary.capture_image().expect("Falha ao capturar tela");
    image::DynamicImage::ImageRgba8(img)
}

// ── Entry point ───────────────────────────────────────────────────────────────
fn main() {
    println!("🔍 DBD Map Checker iniciado");
    println!("   Pressione TAB no jogo para detectar o mapa.");
    println!("   Pressione ESC para sair.\n");

    // Força inicialização do OCR antes do primeiro TAB (roda na main thread)
    let _ = get_detector();
    println!("   ✓ OCR carregado e pronto.\n");

    // ── Loop de eventos de teclado ────────────────────────────────────────────
    let callback = move |event: Event| {
        if let EventType::KeyPress(key) = event.event_type {
            match key {
                Key::Tab => {
                    // Ignora se já estiver processando um TAB anterior
                    if PROCESSING.swap(true, Ordering::AcqRel) {
                        return;
                    }

                    // Dispara processamento em thread separada — não bloqueia o listener
                    thread::spawn(|| {
                        // Aguarda 100ms para a animação do tab screen terminar
                        thread::sleep(Duration::from_millis(100));

                        // Captura o screenshot com o mapa visível
                        let screenshot = capture_screenshot();
                        println!(
                            "\n📸 Screenshot capturado ({w}x{h}) — rodando OCR...",
                            w = screenshot.width(),
                            h = screenshot.height(),
                        );

                        // Roda OCR
                        let detector = get_detector();
                        match detector.detect_map(&screenshot) {
                            Ok(Some(r)) => {
                                println!(
                                    "🗺️  Mapa: {name}  (confiança: {conf:.0}%)",
                                    name = r.map_name,
                                    conf = r.confidence * 100.0,
                                );
                                println!("    OCR bruto: {}", r.raw_ocr_text);
                                println!("→ Mapa confirmado: {}\n", r.map_name);
                            }
                            Ok(None) => println!("⚠️  Mapa não identificado\n"),
                            Err(e) => eprintln!("❌ Erro OCR: {e}\n"),
                        }

                        println!("{}", "─".repeat(55));

                        // Libera o guard para o próximo TAB
                        PROCESSING.store(false, Ordering::Release);
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
            eprintln!("   Coloque um screenshot do tab screen do DBD em map-check/test_screenshot.png");
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
                Ok(Some(r)) => Some(format!(
                    "{}  ({:.0}%)",
                    r.map_name,
                    r.confidence * 100.0
                )),
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
        let variance = times.iter()
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
        println!(
            "   Throughput:  {:>8.1} screenshots/s",
            1.0 / avg
        );
        println!("{SEP}\n");

        // ── Validação: confere se detectou consistentemente ───────────────────
        let consistent = results.windows(2).all(|w| w[0] == w[1]);
        let first = results.first().and_then(|r| r.as_deref()).unwrap_or("???");
        println!("✅ Resultado consistente: {consistent}");
        println!("   Mapa detectado: {first}");

        // Assert suave: só falha se for absurdamente lento (> 30s = algo quebrado)
        let is_release = !cfg!(debug_assertions);
        if is_release {
            assert!(
                avg < 5.0,
                "OCR muito lento em release: média de {avg:.2}s"
            );
        } else {
            println!("💡 Modo DEBUG detectado — rode `cargo test --release bench_detect_map` para números reais.");
            if avg > 5.0 {
                println!("⚠️  Em release o tempo deve cair ~10× (estimado: {:.2}s)", avg / 10.0);
            }
        }
    }
}