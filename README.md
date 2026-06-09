# DBD Tracker Overlay

Overlay desktop local inspirado no Valorant Tracker. Ele fica sobre o Dead by Daylight, abre com `Ctrl+Shift+F` e salva os dados em SQLite.

## Coleta autonoma

O app em `desktop-tauri/` foi recriado a partir do boilerplate oficial `npm create tauri-app@latest` com Tauri v2 e possui uma janela interna persistente que fica oculta durante o uso normal:

1. Clique em **Fazer login** apenas na primeira vez.
2. Entre na sua conta na janela oficial `stats.deadbydaylight.com`.
3. Clique em **Concluir login** no overlay.

Depois disso, a janela fica oculta e, enquanto o overlay estiver rodando, o app verifica `Statistics` e `Recent Match History` a cada 60 segundos. Quando o site oficial publicar uma partida nova, ela e salva automaticamente no SQLite.

A sessao fica armazenada localmente pelo WebView do sistema usado pelo Tauri. O projeto nao envia credenciais nem dados para servidores externos alem do proprio site oficial.

## Dados monitorados

- `Overview`: estatisticas agregadas de todos os modos.
- `Regular Trials`: estatisticas globais, survivor e killer, separadas de Overview.
- `Recent Match History`: preserva localmente cada partida publicada pelo site.
- Metricas historicas locais: perks usadas pelos cinco jogadores, killers encontrados e mapas recorrentes.

O overlay usa diretamente as imagens publicas da CDN oficial `assets.live.bhvraccount.com` para personagens, mapas e perks. Apenas as URLs ficam no SQLite; nenhum arquivo de imagem e salvo localmente.

O site oficial fornece atualmente as 30 partidas recentes. O overlay salva essas partidas no SQLite e acumula as novas ao longo do tempo, criando um historico maior que o disponibilizado pelo site.

As partidas sao identificadas por uma chave estavel e importadas com `UPSERT`: partidas repetidas sao atualizadas, partidas novas sao adicionadas e partidas antigas nunca sao apagadas quando deixam de aparecer nas 30 recentes do site.

## Rodar

Requer Node.js 22 ou mais recente, Rust e as dependencias de sistema do Tauri v2.

```bash
cd desktop-tauri
npm install
npm run dev
```

O SQLite `dbd_tracker.sqlite3` fica na pasta de dados do aplicativo Tauri.

## Atalhos

- `Ctrl+Shift+F`: mostrar, ocultar ou recuperar o controle do mouse.
- `Ctrl+Shift+X`: ativar/desativar o modo que ignora cliques.

Use o modo **janela sem bordas** do Dead by Daylight para o overlay permanecer visivel.

## Gerar executavel

```bash
cd desktop-tauri
npm run build
```

O instalador sera criado pelos targets do Tauri em `desktop-tauri/src-tauri/target/release/bundle/`.
