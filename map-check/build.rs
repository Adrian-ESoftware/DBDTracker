// build.rs — Baixa os modelos ONNX do ocrs na primeira compilação.
// Os arquivos ficam em assets/ e são embarcados pelo include_bytes! em map_detector.rs.
//
// Para compilar SEM internet (CI offline), coloque os modelos em assets/ antes.
// Download manual:
//   curl -L https://ocrs-models.s3.amazonaws.com/text-detection.rten -o assets/text-detection.rten
//   curl -L https://ocrs-models.s3.amazonaws.com/text-recognition.rten -o assets/text-recognition.rten

use std::path::Path;

fn main() {
    let assets_dir = Path::new("assets");
    std::fs::create_dir_all(assets_dir).unwrap();

    download_if_missing(
        assets_dir.join("text-detection.rten"),
        "https://ocrs-models.s3.amazonaws.com/text-detection.rten",
    );

    download_if_missing(
        assets_dir.join("text-recognition.rten"),
        "https://ocrs-models.s3.amazonaws.com/text-recognition.rten",
    );

    // Rerun apenas se os modelos mudarem
    println!("cargo:rerun-if-changed=assets/text-detection.rten");
    println!("cargo:rerun-if-changed=assets/text-recognition.rten");
}

fn download_if_missing(path: impl AsRef<Path>, url: &str) {
    let path = path.as_ref();
    if path.exists() {
        return;
    }

    eprintln!("[build] Baixando modelo: {url}");

    // Usa curl para não adicionar dependência de build
    let status = std::process::Command::new("curl")
        .args(["-fsSL", "-o", path.to_str().unwrap(), url])
        .status()
        .expect("curl não encontrado — instale curl ou baixe os modelos manualmente para assets/");

    if !status.success() {
        panic!(
            "Falha ao baixar {url}\nBaixe manualmente: curl -L {url} -o {}",
            path.display()
        );
    }

    let size = std::fs::metadata(path).unwrap().len();
    eprintln!("[build] Modelo salvo: {} ({:.1} MB)", path.display(), size as f64 / 1_000_000.0);
}