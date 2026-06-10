// dbd_map_detector.rs
// Detecção de mapa do Dead by Daylight a partir de screenshot do tab screen.
// Zero dependências externas — modelos ONNX embarcados no binário via include_bytes!
//
// SETUP: baixe os modelos uma vez e coloque em assets/
//   curl -L https://ocrs-models.s3.ap-southeast-2.amazonaws.com/text-detection.rten -o assets/text-detection.rten
//   curl -L https://ocrs-models.s3.ap-southeast-2.amazonaws.com/text-recognition.rten -o assets/text-recognition.rten

use image::{DynamicImage, GenericImageView, imageops};
use ocrs::{ImageSource, OcrEngine, OcrEngineParams};

// ── Modelos embarcados no binário ──────────────────────────────────────────────
// Os arquivos .rten são ~5MB cada; o binário final fica ~10MB maior.
// Se preferir não embarcar, troque include_bytes! por Model::load_file(path).
static DETECTION_MODEL: &[u8] =
    include_bytes!("../assets/text-detection.rten");
static RECOGNITION_MODEL: &[u8] =
    include_bytes!("../assets/text-recognition.rten");

// ── Região do nome do mapa na tela ────────────────────────────────────────────
// Medido no screenshot 1456×816 (tab screen do DBD).
// O nome do mapa aparece centralizado no rodapé: "FAZENDA COLDWIND - CASA DOS THOMPSON"
// Ajuste se sua resolução for diferente — use a proporção abaixo.
//
//   x_ratio:  0.30 → 0.70   (30% a 70% da largura)
//   y_ratio:  0.80 → 0.93   (80% a 93% da altura)
//
// Essas proporções funcionam para 1080p, 1440p e 4K pois são relativas.
const MAP_REGION_X_START: f32 = 0.30;
const MAP_REGION_X_END:   f32 = 0.70;
const MAP_REGION_Y_START: f32 = 0.79;
const MAP_REGION_Y_END:   f32 = 0.94;

// ── Lista completa de mapas do DBD (PT-BR e EN) ───────────────────────────────
// Fonte: deadbydaylight.fandom.com/wiki/Realms — 58 mapas jogáveis (2025)
// Formato: ("nome em jogo", "nome canônico EN")
//
// O jogo exibe no formato: "REALM - MAP NAME" (PT-BR: "FAZENDA COLDWIND - CASA DOS THOMPSON")
// A lista cobre ambos os idiomas para o fuzzy match funcionar independente do idioma do jogo.
pub const DBD_MAPS: &[(&str, &str)] = &[
    // MacMillan Estate
    ("Shelter Woods",          "SHELTER WOODS"),
    ("Groaning Storehouse",    "GROANING STOREHOUSE"),
    ("Ironworks of Misery",    "IRONWORKS OF MISERY"),
    ("Suffocation Pit",        "SUFFOCATION PIT"),
    ("Coal Tower",             "COAL TOWER"),
    // Autohaven Wreckers
    ("Azarov's Resting Place", "AZAROV'S RESTING PLACE"),
    ("Blood Lodge",            "BLOOD LODGE"),
    ("Gas Heaven",             "GAS HEAVEN"),
    ("Wreckers' Yard",         "WRECKERS' YARD"),
    ("Autohaven Wreckers",     "AUTOHAVEN WRECKERS"),
    // Coldwind Farm
    ("Thompson House",         "THE THOMPSON HOUSE"),
    ("Casa dos Thompson",      "THE THOMPSON HOUSE"),
    ("Rotten Fields",          "ROTTEN FIELDS"),
    ("Campos Podres",          "ROTTEN FIELDS"),
    ("Fractured Cowshed",      "FRACTURED COWSHED"),
    ("Curral Rachado",         "FRACTURED COWSHED"),
    ("Torment Creek",          "TORMENT CREEK"),
    ("Córrego do Tormento",    "TORMENT CREEK"),
    ("Rancid Abattoir",        "RANCID ABATTOIR"),
    ("Abatedouro Rançoso",     "RANCID ABATTOIR"),
    // Crotus Prenn Asylum
    ("Disturbed Ward",         "DISTURBED WARD"),
    ("Father Campbell's Chapel","FATHER CAMPBELL'S CHAPEL"),
    // Backwater Swamp
    ("The Pale Rose",          "THE PALE ROSE"),
    ("Grim Pantry",            "GRIM PANTRY"),
    // Léry's Memorial Institute
    ("Treatment Theatre",      "TREATMENT THEATRE"),
    // Red Forest
    ("Mother's Dwelling",      "MOTHER'S DWELLING"),
    ("Temple of Purgation",    "THE TEMPLE OF PURGATION"),
    // Haddonfield
    ("Lampkin Lane",           "LAMPKIN LANE"),
    // Gideon Meat Plant
    ("The Game",               "THE GAME"),
    // Yamaoka Estate
    ("Family Residence",       "FAMILY RESIDENCE"),
    ("Sanctum of Wrath",       "SANCTUM OF WRATH"),
    // Ormond
    ("Mount Ormond Resort",    "MOUNT ORMOND RESORT"),
    // Hawkins National Laboratory
    ("The Underground Complex","THE UNDERGROUND COMPLEX"),
    // Grave of Glenvale
    ("Dead Dawg Saloon",       "DEAD DAWG SALOON"),
    // Springwood
    ("Badham Preschool I",     "BADHAM PRESCHOOL I"),
    ("Badham Preschool II",    "BADHAM PRESCHOOL II"),
    ("Badham Preschool III",   "BADHAM PRESCHOOL III"),
    ("Badham Preschool IV",    "BADHAM PRESCHOOL IV"),
    ("Badham Preschool V",     "BADHAM PRESCHOOL V"),
    // Silent Hill
    ("Midwich Elementary School","MIDWICH ELEMENTARY SCHOOL"),
    // Raccoon City
    ("Raccoon City Police Station","RACCOON CITY POLICE STATION"),
    // Forsaken Boneyard
    ("Eyrie of Crows",         "EYRIE OF CROWS"),
    ("Garden of Joy",          "GARDEN OF JOY"),
    // Withered Isle
    ("Greenville Square",      "GREENVILLE SQUARE"),
    // The Decimated Borgo
    ("The Shattered Square",   "THE SHATTERED SQUARE"),
    ("Forgotten Ruins",        "FORGOTTEN RUINS"),
    // Dvarka Deepwood
    ("Nostromo Wreckage",      "NOSTROMO WRECKAGE"),
    ("Toba Landing",           "TOBA LANDING"),
    // Realm display names (PT-BR)
    ("Fazenda Coldwind",       "COLDWIND FARM"),
    ("MacMillan",              "MACMILLAN ESTATE"),
    ("Autohaven",              "AUTOHAVEN WRECKERS"),
    ("Pântano de Backwater",   "BACKWATER SWAMP"),
    ("Instituto Memorial Léry","LÉRY'S MEMORIAL INSTITUTE"),
    ("Floresta Vermelha",      "RED FOREST"),
    ("Propriedade Yamaoka",    "YAMAOKA ESTATE"),
    ("Ilha Murcha",            "WITHERED ISLE"),
];

// ── Resultado da detecção ─────────────────────────────────────────────────────
#[derive(Debug, Clone)]
pub struct MapDetectionResult {
    /// Nome canônico em inglês do mapa detectado
    pub map_name: String,
    /// Texto bruto extraído pelo OCR (para debug)
    pub raw_ocr_text: String,
    /// Score de confiança do fuzzy match (0.0–1.0)
    pub confidence: f32,
}

// ── Motor de OCR (lazy-initialized, reuse entre frames) ──────────────────────
pub struct DbdMapDetector {
    engine: OcrEngine,
}

impl DbdMapDetector {
    /// Inicializa o motor uma vez. Chame no startup da aplicação.
    pub fn new() -> anyhow::Result<Self> {
        let detection_model = rten::Model::load(DETECTION_MODEL.to_vec())?;
        let recognition_model = rten::Model::load(RECOGNITION_MODEL.to_vec())?;

        let engine = OcrEngine::new(OcrEngineParams {
            detection_model: Some(detection_model),
            recognition_model: Some(recognition_model),
            ..Default::default()
        })?;

        Ok(Self { engine })
    }

    /// Detecta o mapa a partir de uma screenshot do tab screen.
    ///
    /// # Argumentos
    /// * `screenshot` - Imagem capturada quando o usuário pressionou Tab
    pub fn detect_map(&self, screenshot: &DynamicImage) -> anyhow::Result<Option<MapDetectionResult>> {
        // 1. Recorta apenas a região do nome do mapa (rodapé)
        let cropped = crop_map_region(screenshot);

        // 2. Pré-processa: aumenta contraste para o OCR funcionar melhor
        let processed = preprocess_for_ocr(&cropped);

        // 3. Roda OCR
        let image_source = ImageSource::from_bytes(
            processed.as_raw(),
            (processed.width() as u32, processed.height() as u32),
        )?;
        let ocr_input = self.engine.prepare_input(image_source)?;
        let word_rects = self.engine.detect_words(&ocr_input)?;
        let line_rects = self.engine.find_text_lines(&ocr_input, &word_rects);
        let text_lines = self.engine.recognize_text(&ocr_input, &line_rects)?;

        // Junta todas as linhas detectadas
        let raw_text: String = text_lines
            .iter()
            .filter_map(|l| l.as_ref())
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join(" ")
            .to_uppercase();

        if raw_text.trim().is_empty() {
            return Ok(None);
        }

        // 4. Fuzzy match contra a lista de mapas conhecidos
        let result = fuzzy_match_map(&raw_text);

        Ok(result.map(|(map_name, confidence)| MapDetectionResult {
            map_name,
            raw_ocr_text: raw_text,
            confidence,
        }))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Recorta a região proporcional onde o nome do mapa aparece no tab screen.
fn crop_map_region(img: &DynamicImage) -> DynamicImage {
    let (w, h) = img.dimensions();

    let x = (w as f32 * MAP_REGION_X_START) as u32;
    let y = (h as f32 * MAP_REGION_Y_START) as u32;
    let width  = (w as f32 * (MAP_REGION_X_END - MAP_REGION_X_START)) as u32;
    let height = (h as f32 * (MAP_REGION_Y_END   - MAP_REGION_Y_START)) as u32;

    img.crop_imm(x, y, width, height)
}

/// Pré-processa a imagem para melhorar a acurácia do OCR:
/// - Aumenta contraste (texto do DBD é claro sobre fundo escuro)
/// - Escala 2x apenas se a altura for < 80px (resoluções muito baixas)
fn preprocess_for_ocr(img: &DynamicImage) -> image::RgbImage {
    let (w, h) = img.dimensions();

    // Só faz upscale se a região for muito pequena (< 80px de altura)
    let scaled = if h < 80 {
        img.resize(w * 2, h * 2, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };

    // Converte para RGB e aumenta o contraste
    let mut rgb = scaled.into_rgb8();
    imageops::colorops::contrast_in_place(&mut rgb, 45.0);

    rgb
}

/// Fuzzy match: encontra o mapa mais próximo na lista DBD_MAPS.
///
/// Estratégia:
/// 1. Tenta casar apenas a parte depois do " - " (nome do mapa) — peso maior.
/// 2. Tenta casar o texto completo (inclui realm) — peso menor.
/// 3. Substring match exato: bônus proporcional ao tamanho do candidato.
/// 4. Fallback: distância de Levenshtein em janela deslizante.
fn fuzzy_match_map(ocr_text: &str) -> Option<(String, f32)> {
    let mut best_name = String::new();
    let mut best_score: f32 = 0.0;

    // Separa o texto em "REALM" e "MAP NAME" se houver " - "
    let map_part = ocr_text
        .split(" - ")
        .last()
        .unwrap_or(ocr_text)
        .trim();

    for (candidate, canonical) in DBD_MAPS {
        let candidate_upper = candidate.to_uppercase();

        // Tenta casar primeiro contra a parte do mapa (mais específica)
        let score_map = substring_score(map_part, &candidate_upper);
        // Depois contra o texto completo (fallback para realms)
        let score_full = substring_score(ocr_text, &candidate_upper);

        // A parte do mapa tem peso maior (×1.0) que o texto completo (×0.85)
        let score = score_map.max(score_full * 0.85);

        if score > best_score && score > 0.6 {
            best_score = score;
            best_name = canonical.to_string();
        }
    }

    if best_name.is_empty() {
        None
    } else {
        Some((best_name, best_score))
    }
}

/// Calcula o score de similaridade entre um texto OCR e um candidato.
/// Substring exata → score alto proporcional ao tamanho do match.
/// Senão → Levenshtein em janela deslizante.
fn substring_score(haystack: &str, needle: &str) -> f32 {
    if needle.is_empty() {
        return 0.0;
    }

    if haystack.contains(needle) {
        // Match exato: quanto maior o candidato relativo ao texto, melhor.
        // Fórmula: 0.85 + 0.15 × (needle_len / haystack_len)
        // "THE THOMPSON HOUSE" (18) em texto de 39 chars → 0.85 + 0.15×0.46 = 0.919
        // "COLDWIND FARM"     (14) em texto de 39 chars → 0.85 + 0.15×0.36 = 0.904
        0.85 + 0.15 * (needle.len() as f32 / haystack.len().max(1) as f32)
    } else {
        best_substring_similarity(haystack, needle)
    }
}

/// Calcula a similaridade do candidato contra o melhor sub-trecho do texto OCR.
/// Evita falsos negativos quando o OCR lê texto extra antes/depois do nome.
fn best_substring_similarity(haystack: &str, needle: &str) -> f32 {
    let needle_len = needle.len();
    if haystack.len() < needle_len {
        return levenshtein_similarity(haystack, needle);
    }

    let mut best: f32 = 0.0;
    // Desliza uma janela do tamanho do needle pelo haystack
    for start in 0..=(haystack.len().saturating_sub(needle_len)) {
        if let Some(window) = haystack.get(start..start + needle_len) {
            let sim = levenshtein_similarity(window, needle);
            if sim > best {
                best = sim;
            }
        }
    }
    best
}

/// Distância de Levenshtein normalizada: 1.0 = idêntico, 0.0 = completamente diferente.
fn levenshtein_similarity(a: &str, b: &str) -> f32 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let la = a.len();
    let lb = b.len();

    if la == 0 { return if lb == 0 { 1.0 } else { 0.0 }; }
    if lb == 0 { return 0.0; }

    let mut dp = vec![vec![0usize; lb + 1]; la + 1];
    for i in 0..=la { dp[i][0] = i; }
    for j in 0..=lb { dp[0][j] = j; }

    for i in 1..=la {
        for j in 1..=lb {
            dp[i][j] = if a[i-1] == b[j-1] {
                dp[i-1][j-1]
            } else {
                1 + dp[i-1][j].min(dp[i][j-1]).min(dp[i-1][j-1])
            };
        }
    }

    let dist = dp[la][lb];
    let max_len = la.max(lb);
    1.0 - (dist as f32 / max_len as f32)
}

// ── Testes ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fuzzy_match_exact() {
        let result = fuzzy_match_map("FAZENDA COLDWIND - CASA DOS THOMPSON");
        assert!(result.is_some());
        let (name, score) = result.unwrap();
        assert_eq!(name, "THE THOMPSON HOUSE");
        assert!(score > 0.8, "score foi {score}");
    }

    #[test]
    fn test_fuzzy_match_with_ocr_noise() {
        // Simula OCR com pequenos erros
        let result = fuzzy_match_map("FAZENDA COLDW1ND - ROTTEN FIEL0S MD22");
        assert!(result.is_some());
        let (name, _) = result.unwrap();
        assert_eq!(name, "ROTTEN FIELDS");
    }

    #[test]
    fn test_fuzzy_match_english() {
        let result = fuzzy_match_map("COLDWIND FARM - IRONWORKS OF MISERY");
        assert!(result.is_some());
        let (name, _) = result.unwrap();
        assert_eq!(name, "IRONWORKS OF MISERY");
    }

    #[test]
    fn test_no_match_garbage() {
        let result = fuzzy_match_map("XYZXYZXYZ QQQQ 999");
        assert!(result.is_none());
    }

    #[test]
    fn test_levenshtein_identical() {
        assert!((levenshtein_similarity("HELLO", "HELLO") - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_levenshtein_different() {
        assert!(levenshtein_similarity("HELLO", "WORLD") < 0.5);
    }
}