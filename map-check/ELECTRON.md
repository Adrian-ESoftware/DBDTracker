# Usando o map-check no Electron

Este guia descreve como embutir o `map-check.exe` no app Electron e ler, de forma silenciosa, o mapa atual detectado no Dead by Daylight.

## Objetivo

O `map-check` roda como um processo filho do Electron. Ele fica escutando o `TAB` global, captura a tela/janela do DBD, roda OCR e escreve eventos em `stdout` como JSON por linha.

No build de Electron, o executavel nao abre terminal no Windows.

## Build portable para Electron

Use o perfil `electron`:

```powershell
cd C:\Users\Mesck\OneDrive\Documentos\workspace\DBDTracker\map-check
cargo build --profile electron
```

O executavel sera gerado em:

```text
map-check\target\electron\map-check.exe
```

Este perfil nao usa `target-cpu=native`, entao o binario e mais seguro para distribuir em PCs diferentes.

## Modos de execucao

Para Electron, use:

```powershell
map-check.exe --json
```

Tambem existe um modo humano para debug:

```powershell
map-check.exe --dev
```

Em release, o modo padrao ja e JSON, mas no Electron e melhor passar `--json` explicitamente.

## Iniciando pelo Electron

Exemplo no processo principal do Electron:

```js
import { spawn } from "node:child_process";
import path from "node:path";

const mapCheckPath = path.join(
  process.resourcesPath,
  "map-check",
  "map-check.exe"
);

const mapCheck = spawn(mapCheckPath, ["--json"], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
```

`windowsHide: true` evita janela de console quando aplicavel. O binario de release tambem foi compilado com subsystem Windows, entao ele nao abre terminal.

## Lendo JSON por linha

O `map-check` emite um JSON por linha. Use buffer, porque `stdout` pode chegar quebrado em pedacos.

```js
let buffer = "";

mapCheck.stdout.setEncoding("utf8");
mapCheck.stdout.on("data", chunk => {
  buffer += chunk;

  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      handleMapCheckEvent(event);
    } catch (error) {
      console.warn("Evento invalido do map-check:", line, error);
    }
  }
});
```

## Tratando eventos

Exemplo simples:

```js
function handleMapCheckEvent(event) {
  switch (event.type) {
    case "ready":
      console.log("map-check pronto", event);
      break;

    case "map_detected":
      console.log("Mapa atual:", event.map, event.confidence);
      // Envie para a janela/overlay:
      // mainWindow.webContents.send("dbd-map-detected", event);
      break;

    case "map_not_found":
      console.log("Mapa nao identificado", event);
      break;

    case "capture_error":
    case "ocr_error":
    case "listener_error":
      console.warn("Erro no map-check:", event);
      break;
  }
}
```

## Eventos emitidos

### `ready`

Emitido quando o OCR e o worker de captura estao prontos.

```json
{
  "type": "ready",
  "monitor": {
    "name": "DISPLAY1",
    "width": 1920,
    "height": 1080
  },
  "capture_preference": "dbd_window",
  "fallback": "monitor"
}
```

### `map_detected`

Emitido quando um mapa e reconhecido.

```json
{
  "type": "map_detected",
  "map": "THE THOMPSON HOUSE",
  "confidence": 0.92,
  "raw_ocr_text": "FAZENDA COLDWIND - CASA DOS THOMPSON",
  "capture_source": "dbd_window",
  "capture_ms": 14.25,
  "ocr_ms": 165.8,
  "screenshot_width": 1920,
  "screenshot_height": 1080
}
```

`capture_source` pode ser:

- `dbd_window`: captura direta da janela do Dead by Daylight.
- `monitor_fallback`: fallback para captura do monitor.

### `map_not_found`

Emitido quando o OCR rodou, mas o mapa nao foi identificado.

```json
{
  "type": "map_not_found",
  "capture_source": "monitor_fallback",
  "capture_ms": 18.2,
  "ocr_ms": 150.4,
  "screenshot_width": 1920,
  "screenshot_height": 1080
}
```

### Erros

Possiveis tipos:

- `capture_error`
- `ocr_error`
- `listener_error`

Exemplo:

```json
{
  "type": "capture_error",
  "error": "Identificador invalido. (0x80070006)"
}
```

## Empacotando no Electron

Se usar `electron-builder`, inclua o executavel como recurso extra.

Exemplo no `package.json`:

```json
{
  "build": {
    "extraResources": [
      {
        "from": "../map-check/target/electron/map-check.exe",
        "to": "map-check/map-check.exe"
      }
    ]
  }
}
```

Depois, no runtime, o caminho fica:

```js
path.join(process.resourcesPath, "map-check", "map-check.exe")
```

## Encerrando o processo

Ao fechar o Electron, encerre o processo filho:

```js
app.on("before-quit", () => {
  if (mapCheck && !mapCheck.killed) {
    mapCheck.kill();
  }
});
```

## Observacoes importantes

- O `map-check` so detecta quando o jogador pressiona `TAB`.
- A captura tenta primeiro a janela do DBD e cai para monitor se falhar.
- O modo JSON deve ser tratado como API interna entre Rust e Electron.
- Nao use `target-cpu=native` para o binario distribuido.
- Para debug local, rode `map-check.exe --dev` em um terminal.
