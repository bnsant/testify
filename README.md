# Testify — Discord Activity

Compartilhamento de tela privado cuja interface principal roda **dentro do Discord**. Não há código de sala: cada sala é a `discordSdk.instanceId` da Activity. O projeto usa somente o [Embedded App SDK oficial](https://docs.discord.com/developers/developer-tools/embedded-app-sdk), OAuth2, o endpoint oficial de validação da instância e WebSocket.

## Arquitetura do MVP

```text
Discord Activity (React + Embedded App SDK)
  ├─ OAuth authorize/authenticate
  ├─ instanceId + participantes oficiais
  ├─ player MediaSource e controles
  └─ WebSocket autenticado ────────────────┐
                                           │ mídia WebM codificada
Capture Page ou captura interna            │
  ├─ token aleatório, curto e de uso único │
  ├─ getDisplayMedia(1080p / 60 fps ideal) │
  └─ MediaRecorder ────────────────────────┤
                                           ▼
Express + ws
  ├─ troca OAuth (secret somente no servidor)
  ├─ valida GET /applications/:id/activity-instances/:instanceId
  ├─ 1 broadcaster + até 5 viewers
  ├─ autoridade de sala e retransmissão
  └─ cleanup quando as conexões saem
```

O servidor não grava mídia. Os fragmentos WebM são mantidos apenas em memória enquanto são retransmitidos; somente o primeiro fragmento é guardado temporariamente para inicializar viewers que chegam durante uma transmissão.

### Por que não há `RTCPeerConnection`

A [documentação atual de Networking das Activities](https://docs.discord.com/developers/activities/development-guides/networking) é explícita: o proxy suporta WebSocket, mas **não suporta WebRTC**. Por isso este MVP não finge que WebRTC compilando significa WebRTC funcional. Ele usa `MediaRecorder` → WebSocket → `MediaSource`, isto é, vídeo já codificado e não frames brutos. `client/src/streaming/rtc.js` isola a fronteira para uma futura migração a WebRTC/SFU se o suporte mudar.

TURN/STUN estão preparados por ENV, porém não são usados neste transporte. Um TURN não corrige a falta de suporte a WebRTC no proxy da Activity.

## Requisitos

- Node.js 18.18+ (Node 20 recomendado)
- uma aplicação no [Discord Developer Portal](https://discord.com/developers/applications)
- `cloudflared` ou outro túnel HTTPS durante desenvolvimento
- transmissor: Discord Desktop/Chromium com `MediaRecorder` (MP4/H.264 de preferência, WebM/VP8-9 como fallback)
- viewer: `MediaSource` (desktop) ou `ManagedMediaSource` (iOS 17.1+); assistir no iOS exige que o transmissor tenha conseguido MP4

## Configurar o Discord

1. Crie uma aplicação no Developer Portal.
2. Em **Installation**, habilite `User Install` e `Guild Install` para permitir canais e DMs/GDMs.
3. Em **OAuth2**, adicione uma Redirect URI. Para o fluxo interno da Activity, a documentação aceita o placeholder `https://127.0.0.1`; o SDK cuida do retorno do comando `authorize`.
4. Copie Application ID, Client Secret e o token do bot para o `.env`. Nunca exponha o Client Secret ou o Bot Token no frontend.
5. Em **Activities → Settings**, marque **Enable Activities** e, em Supported Platforms, **Desktop** (e **iOS**/**Android** se quiser que o celular assista).
6. Registre o comando de ponto de entrada (o Discord não cria mais sozinho): rode `npm run register-command` ou clique no link "comando de ponto de entrada" que aparece no launcher.
7. Em **Activities → URL Mappings**, configure o prefixo `/` apontando para o host público, sem `https://`.
8. No Discord, habilite **User Settings → Advanced → Developer Mode**.

O backend usa o Bot Token para chamar o [Get Application Activity Instance](https://docs.discord.com/developers/resources/application#get-application-activity-instance). Além de autenticar o usuário por OAuth, ele exige que o ID do usuário esteja na lista `users` retornada pelo Discord. Dados de identidade enviados pelo iframe não dão autoridade para iniciar uma transmissão.

## Desenvolvimento local

Copie a configuração e preencha as credenciais:

```powershell
Copy-Item .env.example .env
```

```dotenv
DISCORD_CLIENT_ID=123456789012345678
VITE_DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=seu_client_secret
DISCORD_BOT_TOKEN=seu_bot_token

HOST=127.0.0.1
PORT=3001
PUBLIC_BASE_URL=https://SEU-TUNEL.trycloudflare.com
ALLOWED_ORIGINS=http://localhost:5173,https://123456789012345678.discordsays.com
```

Instale e inicie frontend e backend juntos:

```powershell
npm install
npm run dev
```

O Vite fica em `http://localhost:5173`; ele encaminha `/api`, `/health` e `/ws` ao Express em `http://localhost:3001`.

Em outro terminal:

```powershell
cloudflared tunnel --url http://localhost:5173
```

Copie o hostname gerado, por exemplo `quiet-river.trycloudflare.com`:

- `PUBLIC_BASE_URL=https://quiet-river.trycloudflare.com`
- URL Mapping no Portal: prefixo `/`, target `quiet-river.trycloudflare.com`
- reinicie `npm run dev` após mudar o `.env`

Não habilite Application URL Override quando testar pelo proxy. A [documentação oficial de desenvolvimento local](https://docs.discord.com/developers/activities/development-guides/local-development) recomenda testar o mapping através do proxy do Discord.

Para apenas conferir a interface, abra `http://localhost:5173`. Esse modo é um preview visual, não autentica e não transmite. A funcionalidade real deve ser iniciada pelo App Launcher dentro do Discord.

## Fluxo de captura

Ao clicar **Compartilhar tela**, a Activity executa uma detecção real:

1. verifica `navigator.mediaDevices.getDisplayMedia` e a Permissions Policy;
2. tenta abrir o seletor nativo no gesto do clique;
3. se funcionar, transmite diretamente da Activity;
4. se a API/política/sandbox bloquear, pede ao backend um token e chama `discordSdk.commands.openExternalLink()`;
5. a Capture Page consome o token uma única vez e mostra **Escolher tela** (esse segundo gesto é uma exigência do navegador);
6. ao iniciar, todos os viewers da mesma `instanceId` recebem automaticamente o stream.

O token na URL não é um access token do Discord. É um valor aleatório de 256 bits, vinculado ao usuário e à instância, com validade padrão de 120 segundos. Após o claim, ele é apagado e trocado por uma sessão de captura que não aparece na URL.

Áudio de sistema é solicitado, mas pode não existir dependendo de sistema, navegador e fonte selecionada. A ausência de áudio não interrompe o vídeo.

## Protocolo WebSocket

Mensagens de controle são JSON; mídia é frame WebSocket binário.

- Activity: `authenticate` com a sessão opaca emitida após OAuth.
- Capture Page: `authenticate-capture` com a sessão emitida depois do token de uso único.
- Broadcaster: `start-broadcast`, fragmentos binários, `stop-broadcast`.
- Servidor: `room-state`, `broadcast-ready`, `broadcast-stopped`, `error`.
- `source`, `userId` e `instanceId` nunca são aceitos de mensagens de mídia; vêm exclusivamente da sessão no servidor.

Há heartbeat, backpressure, reconexão exponencial para viewers, limite de payload, um único broadcaster e cinco viewers. Se o broadcaster cair, a transmissão é destruída. Ao sair o último usuário, a sala é removida.

## Produção / Railway

O `Dockerfile` faz o build Vite e inicia uma única instância Express que serve o frontend, Capture Page, API e WebSocket.

1. Crie um serviço a partir deste repositório/Dockerfile.
2. Configure todas as ENV de `.env.example`; use a URL HTTPS pública do serviço em `PUBLIC_BASE_URL`.
3. Em `ALLOWED_ORIGINS`, inclua `https://<APPLICATION_ID>.discordsays.com` e a origem pública.
4. Configure `/` → `seu-host.up.railway.app` em Activities → URL Mappings (target sem protocolo).
5. Use somente uma réplica neste MVP: sessões, salas e mídia vivem na memória do processo.
6. Confirme que o host mantém conexões WebSocket e que o cliente usa `wss://` automaticamente sob HTTPS.

O container roda como usuário sem privilégios. O Vite gera nomes com hash para cache busting dos assets, conforme recomendado para produção de Activities.

## Verificação

```powershell
npm test
npm run check
```

A suíte cobre OAuth/validação da instância, tokens de uso único e expiração, formato do protocolo, exclusividade do broadcaster, limite de viewers, cleanup e retransmissão binária real entre sockets. `check` valida sintaxe do servidor e executa o build de produção.

### Teste obrigatório em dois PCs

Esse teste depende das suas credenciais e de dois clientes Discord, portanto não pode ser automatizado fora da sua aplicação:

1. PC A e PC B entram na mesma call e na mesma instância da Activity.
2. Confirme avatares, nomes e contador nos dois PCs.
3. PC A clica **Compartilhar tela** e escolhe uma janela.
4. Se o iframe não autorizar captura, confirme que a página externa foi aberta pelo diálogo oficial do Discord.
5. PC B deve exibir automaticamente o vídeo; teste áudio, mute e tela cheia.
6. Feche a fonte no PC A: PC B deve voltar a “Aguardando alguém compartilhar a tela”.
7. Desconecte/reconecte o PC B durante o stream para validar o cache do fragmento inicial e a reconexão.

## Troubleshooting

- **“Configuração ausente”**: preencha Client ID, Client Secret e Bot Token. `DISCORD_TOKEN` antigo também é aceito como fallback para `DISCORD_BOT_TOKEN`.
- **Activity não aparece**: confirme Developer Mode, Enable Activities, Supported Platforms e se sua conta pertence à equipe dona da aplicação.
- **401 após OAuth**: o backend não conseguiu trocar o code, obter `/users/@me` ou validar a instância ativa. Confira os três segredos/IDs e reabra a Activity.
- **403 no WebSocket**: adicione a origem exata `<APPLICATION_ID>.discordsays.com` a `ALLOWED_ORIGINS`.
- **`blocked:csp` / 404 pelo proxy**: confira o mapping `/` e remova `https://` do target no Portal.
- **Capture Page expirou**: volte à Activity e clique novamente; links têm vida curta e uso único.
- **Vídeo sem áudio**: compartilhe uma guia ou tela que ofereça áudio no seletor. macOS e algumas fontes não expõem áudio de sistema.
- **Player não suporta o formato**: o transmissor grava em MP4/H.264 quando o navegador suporta (Chrome/Discord Desktop recente) e cai para WebM/VP8-9 caso contrário. Viewers no desktop reproduzem os dois; iPhone/iPad (`ManagedMediaSource`, iOS 17.1+) só reproduzem quando o transmissor conseguiu MP4. Se o transmissor estiver num navegador que só grava WebM, quem assiste no iOS verá "O player não suporta …".
- **Activity não abre no celular**: em **Activities → Settings → Supported Platforms** habilite **iOS**/**Android** além de Desktop. Sem isso o Discord responde "Esta atividade não está disponível para este SO".
- **Latência**: o transporte é `MediaRecorder → WebSocket → MediaSource`. O piso prático fica em ~0.5–1 s (fragmento de 200 ms + encoder + rede + player); sub-200 ms só com WebRTC, que o proxy de Activities não suporta. O player se cola na borda ao vivo (`syncToLiveEdge` em `client/src/streaming/mediaSource.js`): acelera 8 % quando atrasa pouco e salta quando passa de ~1.2 s. Se a latência ainda cresce, a subida do transmissor não sustenta o bitrate — reduza `VIDEO_BITS_PER_SECOND` ou `TIMESLICE_MS` em `client/src/streaming/broadcast.js`, ou hospede mais perto dos usuários.
- **60 fps não engata**: depende da fonte (uma guia estática fica em ~30) e de "Movimento" no seletor do Chrome. O código pede 60 e marca `contentHint = "motion"`; o encoder ainda cai a taxa sob CPU/rede apertadas.

Referências principais: [Building Your First Activity](https://docs.discord.com/developers/activities/building-an-activity), [Multiplayer Experience](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience), [Networking](https://docs.discord.com/developers/activities/development-guides/networking) e [User Actions](https://docs.discord.com/developers/activities/development-guides/user-actions).
