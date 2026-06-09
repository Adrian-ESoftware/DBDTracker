# DBD Tracker Overlay - Tauri v2

Aplicativo desktop em Tauri v2 para coletar e visualizar estatisticas do site oficial de stats do Dead by Daylight. A UI principal e um overlay transparente, enquanto a coleta roda em uma janela WebView separada logada em `stats.deadbydaylight.com`.

## Arquitetura

O projeto foi criado a partir do boilerplate oficial `npm create tauri-app@latest` com template `vanilla`.

Principais camadas:

- `src/index.html`: overlay visual, abas, cards, listagem de partidas e chamadas para a API local.
- `src/overlay-bridge.js`: expõe `window.dbd` para a UI chamar comandos Tauri e consultar a API HTTP local.
- `src-tauri/src/lib.rs`: ponto central do app nativo; cria janela, tray, atalhos globais, servidor HTTP local e coletor.
- `src-tauri/src/database.rs`: schema SQLite, ingestao de partidas, snapshots, metricas e consultas agregadas.
- `src-tauri/src/collector_parser.rs`: normaliza payloads oficiais capturados da rede do WebView.
- `src-tauri/collector.js`: fallback em JavaScript executado na pagina oficial, usado quando a captura nativa nao encontra tudo.

## Fluxo De Funcionamento

1. O app inicia a janela principal `main`, que carrega `src/index.html`.
2. O backend Rust abre/cria o banco local `dbd_tracker.sqlite3` no diretorio de dados do app.
3. Um servidor HTTP local sobe em `127.0.0.1:8765`.
4. A UI consulta esse servidor por endpoints como `/api/stats/overview`, `/api/matches` e `/api/assets`.
5. Ao clicar em **Fazer login**, o app abre uma janela `collector` apontando para `https://stats.deadbydaylight.com/statistics/`.
6. A sessao do site fica no armazenamento do WebView2/Tauri, separado do SQLite.
7. Ao clicar em **Atualizar agora**, o app navega pela pagina oficial e coleta dados.
8. As respostas JSON capturadas sao normalizadas e gravadas no SQLite.
9. O overlay recarrega os dados locais e renderiza as estatisticas.

## Coleta De Dados

No Electron antigo, a coleta funcionava porque `webContents.debugger` permitia ouvir o Chrome DevTools Protocol e ler respostas de rede com `Network.getResponseBody`.

No Tauri, a abordagem principal replica isso no Windows usando WebView2 nativo:

- `with_webview` acessa o `ICoreWebView2`.
- `Network.enable` ativa eventos de rede via DevTools Protocol.
- `Network.responseReceived` detecta respostas relevantes.
- `Network.getResponseBody` recupera o JSON real da resposta.
- `collector_parser.rs` transforma esses payloads em partidas e metricas.

Essa abordagem e mais confiavel do que depender de `fetch` dentro da pagina oficial, pois nao fica presa a CORS/CSP do site.

O fallback `collector.js` ainda existe para:

- tentar chamadas IPC/HTTP quando disponivel;
- extrair metricas visiveis do DOM;
- raspar partidas minimas da tela de `Recent Match History` se necessario.

## Banco Local

As estatisticas coletadas ficam em SQLite:

```text
dbd_tracker.sqlite3
```

O arquivo e criado no diretorio de dados do app Tauri, obtido por:

```rust
app.path().app_data_dir()
```

No Windows, normalmente fica em um caminho parecido com:

```text
C:\Users\<usuario>\AppData\Roaming\local.dbdtracker.overlay\dbd_tracker.sqlite3
```

Tabelas principais:

- `matches`: partidas coletadas.
- `loadouts`: perks, item, addons e offering do jogador.
- `killer_info`: killer, kills e loadout do killer.
- `participants`: outros participantes quando disponiveis.
- `source_snapshots`: payloads brutos capturados para auditoria.
- `official_metrics`: metricas agregadas do site oficial.
- `official_sections`: secoes oficiais por periodo/role.
- `top_character_stats`: melhores personagens por role.
- `assets`: URLs de imagens oficiais indexadas.

## API Local

O overlay consome dados por HTTP em:

```text
http://127.0.0.1:8765/api
```

Endpoints principais:

- `GET /api/stats/overview`
- `GET /api/stats/killers`
- `GET /api/stats/maps`
- `GET /api/stats/perks?scope=...`
- `GET /api/matches?limit=15`
- `GET /api/official-metrics`
- `GET /api/official-sections`
- `GET /api/top-characters`
- `GET /api/assets`

Tambem existem endpoints `POST` para ingestao interna, usados pelo fallback do coletor.

## Janelas E Atalhos

Janelas:

- `main`: overlay transparente e sem bordas.
- `collector`: WebView com o site oficial da Behaviour.

Atalhos globais:

- `Ctrl+Shift+F`: mostra/oculta o overlay ou restaura o controle do mouse.
- `Ctrl+Shift+X`: ativa/desativa o modo que ignora cliques no overlay.

Tray:

- abre/foca o overlay;
- encerra o app.

## Desenvolvimento

Instalar dependencias:

```bash
npm install
```

Rodar em desenvolvimento:

```bash
npm run dev
```

Rodar testes:

```bash
npm test
```

Build:

```bash
npm run build
```

## Diagnostico

Se o site oficial mostra partidas mas o overlay nao atualiza:

1. Reinicie o app para garantir que o binario Rust novo esta rodando.
2. Clique em **Fazer login** e confirme que a janela oficial esta autenticada.
3. Clique em **Atualizar agora**.
4. O status deve indicar captura, por exemplo `N partida(s) capturada(s) via WebView2.`
5. Se continuar sem dados, verifique se o endpoint local responde:

```text
http://127.0.0.1:8765/health
```

## Privacidade

Credenciais e cookies do site oficial ficam no armazenamento do WebView2/Tauri. O SQLite armazena somente dados de estatisticas, snapshots capturados e URLs de assets oficiais. O app nao envia dados para servidores proprios; ele se comunica com o site oficial e com a API local em `127.0.0.1`.
