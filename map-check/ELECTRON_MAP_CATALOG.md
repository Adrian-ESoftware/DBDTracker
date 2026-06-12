# Atualizando mapas pelo Electron

Este guia mostra como o Electron deve enviar a lista de mapas diretamente para o `map-check.exe`, sem recompilar o Rust a cada novo mapa ou alias. O catalogo JSON e obrigatorio.

## Formato recomendado

Use o schema estruturado por realm/grupo e variacoes:

```json
{
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
        },
        {
          "id": "ROTTEN_FIELDS",
          "canonical": "ROTTEN FIELDS",
          "aliases": {
            "pt-br": ["CAMPOS PODRES"],
            "en-us": ["ROTTEN FIELDS"]
          }
        }
      ]
    }
  ]
}
```

O `map-check` transforma isso internamente em candidatos fuzzy, por exemplo:

```text
FAZENDA COLDWIND - CASA DOS THOMPSON -> THE THOMPSON HOUSE
CASA DOS THOMPSON -> THE THOMPSON HOUSE
COLDWIND FARM - THE THOMPSON HOUSE -> THE THOMPSON HOUSE
THE THOMPSON HOUSE -> THE THOMPSON HOUSE
```

O retorno principal continua sendo `map`, mas no schema novo o evento tambem inclui `map_id` e `realm_id`.

## Idioma

Passe o idioma do jogo com `--lang`:

```powershell
map-check.exe --json --lang pt-br --maps-json "<json>"
```

Regras:

- Se `--lang` nao for informado, o padrao e `en-us`.
- Se `--lang pt-br` for usado, o fuzzy usa aliases `pt-br` e tambem fallback `en-us`.
- Se uma variacao nao tiver aliases na lingua escolhida, os aliases `en-us` ainda entram como fallback.

Tambem pode usar `--language`:

```powershell
map-check.exe --json --language pt-br --maps-json "<json>"
```

## Formato legado

O formato antigo continua aceito:

```json
[
  ["FAZENDA COLDWIND - CASA DOS THOMPSON", "THE THOMPSON HOUSE"],
  ["CASA DOS THOMPSON", "THE THOMPSON HOUSE"]
]
```

Nesse formato, `map_id` e `realm_id` saem como `null`.

## Passando para o processo

Use `spawn`, nao `exec`, para evitar problemas com aspas e limite de shell.

```js
import { spawn } from "node:child_process";
import path from "node:path";

const maps = [
  {
    realm_id: "COLDWIND_FARM",
    realm: {
      "pt-br": ["FAZENDA COLDWIND"],
      "en-us": ["COLDWIND FARM"],
    },
    variations: [
      {
        id: "THE_THOMPSON_HOUSE",
        canonical: "THE THOMPSON HOUSE",
        aliases: {
          "pt-br": ["CASA DOS THOMPSON"],
          "en-us": ["THE THOMPSON HOUSE"],
        },
      },
    ],
  },
];

const catalog = { version: 1, maps };

const mapCheckPath = path.join(
  process.resourcesPath,
  "map-check",
  "map-check.exe"
);

const mapCheck = spawn(
  mapCheckPath,
  ["--json", "--lang", "pt-br", "--maps-json", JSON.stringify(catalog)],
  {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }
);
```

Tambem funciona com `--maps-json=<json>`, mas no Electron a forma separada costuma ser mais limpa:

```js
["--json", "--lang", "pt-br", "--maps-json", JSON.stringify(catalog)]
```

## Confirmando que carregou

No evento `ready`, leia `map_catalog`:

```json
{
  "type": "ready",
  "map_catalog": {
    "source": "argv_json",
    "schema": "structured",
    "count": 4,
    "language": "pt-br",
    "fallback_language": "en-us"
  }
}
```

Valores possiveis:

- `source: "argv_json"`: o `map-check` carregou o JSON enviado pelo Electron.
- `schema: "structured"`: schema novo por realm/variacoes.
- `schema: "legacy_pairs"`: formato antigo de array de pares.

Se `--maps-json` faltar ou o JSON for invalido, o processo emite `map_catalog_error` e encerra com codigo `2`:

```json
{
  "type": "map_catalog_error",
  "error": "--maps-json e obrigatorio"
}
```

## Fluxo recomendado de atualizacao

Mantenha a lista de mapas no Electron como fonte principal, por exemplo:

```text
src/dbd/maps.json
```

Quando um mapa novo sair:

1. Adicione ou atualize o `realm_id`.
2. Adicione o nome do realm por idioma em `realm`.
3. Adicione cada variacao em `variations[]` com `id`, `canonical` e `aliases`.
4. Rode o Electron com `--lang` igual ao idioma do jogo.
5. Confira no evento `ready` se `source`, `schema`, `language` e `count` estao corretos.
6. Se receber `map_not_found`, use `diagnostic.raw_ocr_text` e `diagnostic.candidates` para criar um novo alias.

## Exemplo lendo de arquivo no Electron

```js
import fs from "node:fs";

const mapsPath = path.join(app.getAppPath(), "src", "dbd", "maps.json");
const maps = JSON.parse(fs.readFileSync(mapsPath, "utf8"));

const mapCheck = spawn(
  mapCheckPath,
  ["--json", "--lang", "pt-br", "--maps-json", JSON.stringify(maps)],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
);
```

Em app empacotado, coloque esse JSON dentro do bundle ou em `extraResources`, conforme sua estrategia de update.

## Observacoes

- O argumento precisa ser JSON valido: use aspas duplas, nao aspas simples.
- Evite enviar milhares de aliases desnecessarios. A comparacao fuzzy roda contra a lista achatada da lingua escolhida mais fallback.
- Para listas muito grandes, prefira manter aliases realmente provaveis de aparecer no OCR.
- Nao existe fallback embutido de catalogo. Se `--maps-json` faltar, o processo falha cedo com `map_catalog_error`.
- O fallback `en-us` e apenas de idioma dentro do catalogo enviado.
