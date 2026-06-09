use rdev::{listen, Event, EventType, Key};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use xcap::Monitor;

/// Proporção da largura (a partir da direita) para recorte do OCR
const OCR_CROP_WIDTH_RATIO: f32 = 0.25;
/// Proporção da altura (a partir de baixo) para recorte do OCR
const OCR_CROP_HEIGHT_RATIO: f32 = 0.20;

fn main() {
    // Cria o diretório tab-preview se não existir
    let dir = Path::new("tab-preview");
    if !dir.exists() {
        fs::create_dir_all(dir).expect("Falha ao criar diretório tab-preview");
    }

    // Verifica se o Tesseract OCR está instalado
    let tesseract_available = Command::new("tesseract")
        .arg("--version")
        .output()
        .is_ok();

    if tesseract_available {
        println!("✅ Tesseract OCR detectado.");
    } else {
        println!("⚠️  Tesseract OCR não encontrado — OCR desabilitado.");
        println!("   Instale: https://github.com/UB-Mannheim/tesseract/wiki");
    }

    println!("🟢 Aguardando tecla Tab...");
    println!("   Pressione Tab para tirar um print (delay de 10ms).");
    println!("   Pressione Ctrl+C para sair.");

    let callback = move |event: Event| {
        if let EventType::KeyPress(Key::Tab) = event.event_type {
            // Dispara em uma thread separada para não travar o gancho do teclado
            thread::spawn(move || {
                // Delay de 10ms
                thread::sleep(Duration::from_millis(10));

                // Captura o monitor principal
                let monitors = match Monitor::all() {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("Erro ao listar monitores: {}", e);
                        return;
                    }
                };

                let monitor = match monitors.first() {
                    Some(m) => m,
                    None => {
                        eprintln!("Nenhum monitor encontrado.");
                        return;
                    }
                };

                let xcap_image = match monitor.capture_image() {
                    Ok(img) => img,
                    Err(e) => {
                        eprintln!("Erro ao capturar tela: {}", e);
                        return;
                    }
                };

                // Timestamp para nome dos arquivos
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis();
                let filename = format!("tab-preview/print_{}.png", timestamp);

                // Salva o screenshot completo
                match xcap_image.save(&filename) {
                    Ok(_) => println!("📸 Print salvo: {}", filename),
                    Err(e) => eprintln!("Erro ao salvar imagem: {}", e),
                }

                // OCR no canto inferior direito (se tesseract disponível)
                if tesseract_available {
                    run_ocr(&filename, timestamp);
                }
            });
        }
    };

    if let Err(error) = listen(callback) {
        eprintln!("Erro no listener de teclado: {:?}", error);
    }
}

/// Faz OCR no canto inferior direito da imagem salva.
/// Salva o resultado em `tab-preview/ocr_<timestamp>.txt`.
fn run_ocr(screenshot_path: &str, timestamp: u128) {
    // Carrega a imagem para recortar
    let img = match image::open(screenshot_path) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("OCR: erro ao abrir imagem: {}", e);
            return;
        }
    };

    let (w, h) = (img.width(), img.height());
    let crop_w = ((w as f32) * OCR_CROP_WIDTH_RATIO).max(1.0) as u32;
    let crop_h = ((h as f32) * OCR_CROP_HEIGHT_RATIO).max(1.0) as u32;
    let x = w.saturating_sub(crop_w);
    let y = h.saturating_sub(crop_h);

    let cropped = img.crop_imm(x, y, crop_w, crop_h);

    // Salva o recorte temporário para o Tesseract
    let crop_path = format!("tab-preview/_ocr_crop_{}.png", timestamp);
    if let Err(e) = cropped.save(&crop_path) {
        eprintln!("OCR: erro ao salvar recorte: {}", e);
        return;
    }

    // Executa o Tesseract (stdout, idioma inglês, sem info extra)
    let result = Command::new("tesseract")
        .arg(&crop_path)
        .arg("stdout")
        .arg("-l")
        .arg("eng")
        .arg("--psm")
        .arg("6") // bloco uniforme de texto
        .output();

    // Remove o arquivo temporário
    let _ = fs::remove_file(&crop_path);

    match result {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let text = text.trim();
            if text.is_empty() {
                println!("🔍 OCR: nada detectado no canto inferior direito.");
            } else {
                let ocr_filename = format!("tab-preview/ocr_{}.txt", timestamp);
                if let Err(e) = fs::write(&ocr_filename, text) {
                    eprintln!("OCR: erro ao salvar resultado: {}", e);
                } else {
                    println!("🔍 OCR salvo: {} → \"{}\"", ocr_filename, text);
                }
            }
        }
        Err(e) => {
            eprintln!("OCR: erro ao executar tesseract: {}", e);
        }
    }
}
