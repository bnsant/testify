# Testify

Compartilhamento privado de tela com a interface principal dentro de uma Discord Activity.

O fluxo é: **abrir Testify na call → Compartilhar tela → escolher a fonte no Chrome → assistir na mesma Activity**. A sala é a `discordSdk.instanceId`; ninguém digita códigos ou compartilha links manualmente.

## Ligar e testar

O roteiro completo, incluindo teste em dois PCs e retorno ao Railway, está em [TESTAR.md](TESTAR.md).

```powershell
npm ci
npm run doctor
npm run dev
```

Em outro terminal:

```powershell
.\.tools\cloudflared.exe tunnel --url http://localhost:5173
```

Use o domínio HTTPS do túnel em `PUBLIC_BASE_URL` no arquivo **.env.local** e no URL Mapping `/` do Discord Developer Portal. Reinicie `npm run dev` depois de alterar a configuração.

O `.env` existente é preservado; `.env.local` sobrepõe apenas os valores de teste. Nunca envie esses arquivos ao Git ou ao Docker.

## Arquitetura

- React + Vite + Embedded App SDK oficial para autenticação, participantes, convites e abertura da captura.
- OAuth trocado no Express; Client Secret e Bot Token ficam somente no servidor.
- O backend consulta a API oficial de instâncias para confirmar usuário, aplicação e instância. Acesso é revalidado ao conectar e periodicamente.
- Um broadcaster e até cinco viewers por instância.
- Captura externa via `openExternalLink`. O Discord usa o navegador padrão do sistema; configure Chrome como padrão se quiser que ele sempre seja aberto.
- `getDisplayMedia` somente após clique na página de captura, com permissão explícita do navegador.
- Uma codificação MediaRecorder é retransmitida em WebSocket binário para os viewers. O player usa MediaSource; ManagedMediaSource é alternativa quando disponível.
- Nenhuma gravação em disco. As filas de mídia ficam apenas em memória, com limites de tamanho e tratamento de conexão lenta.
- HTTPS/WSS em produção. Isso protege o transporte; não equivale a criptografia ponta a ponta contra o servidor.

A [documentação oficial de networking do Discord](https://docs.discord.com/developers/activities/development-guides/networking) declara WebRTC não suportado nas Activities. TURN ou um SFU não removem essa limitação no viewer. O MVP transmite mídia **codificada**, nunca frames brutos.

WebCodecs não é dependência deste fluxo. A escolha atual mantém áudio e vídeo sincronizados no mesmo contêiner e permite validar a cadeia de captura e player com o Chrome instalado.

## Qualidade e estabilidade

| Perfil | Resolução/FPS alvo | Bitrate de vídeo |
| --- | --- | --- |
| Equilibrado, padrão | 1080p30 | 3 Mbps |
| Movimento | 720p60 | 2,5 Mbps |
| Econômico | 720p30 | 1,5 Mbps |
| Conexão limitada | 576p15 | 600 Kbps |

Os valores são alvos, sujeitos à fonte, navegador, encoder e computador. O áudio usa alvo de 128 Kbps. O painel de captura informa resolução/FPS da fonte e taxa de dados enviada; esses números não garantem o FPS decodificado do outro PC.

A adaptação automática reduz qualidade quando o upload acumula dados ou há sinais persistentes de congestionamento nos viewers. Há intervalo entre ajustes; a recuperação para qualidade maior fica sob controle do usuário no seletor, evitando oscilações.

Fragmentos do MediaRecorder não são arquivos independentes. Por isso:

- Cada sequência de codificação recebe um `streamId` novo.
- O servidor envia `stream-start` antes da primeira mídia.
- O player inicializa sincronamente, sem esperar o ciclo de renderização do React.
- Um viewer tardio espera uma nova sequência completa. Não recebe um cabeçalho antigo seguido de bytes arbitrários do meio da transmissão.
- Entrada tardia, ressincronização e mudança de perfil podem provocar uma breve pausa também nos viewers existentes. Esse é o compromisso do encoder único neste MVP.
- A fila do player e a fila de envio têm limites. Ao atingir o limite, a conexão é recuperada com uma nova sequência, sem descartar bytes de contêiner e continuar um stream corrompido.
- O player acompanha a borda ao vivo e limpa mídia antiga.
- O indicador **Buffer** mede vídeo disponível à frente do cursor, não latência de ponta a ponta.

Não há promessa de latência fixa. Meça entre os dois PCs com um cronômetro na tela compartilhada, usando o procedimento em TESTAR.md.

## Encerrar e reconectar

O dono pode encerrar pela Activity, pela página de captura ou pelo botão nativo de parar compartilhamento do Chrome. O servidor impede que outro usuário encerre a transmissão.

Uma queda do socket do broadcaster encerra a transmissão no servidor. A página tenta restaurar a conexão com a mesma captura até o limite de tentativas. Sessão expirada ou acesso recusado exigem reabrir a Activity.

Se o dono sair da Activity, há oito segundos de tolerância para uma reconexão breve; depois a captura é encerrada. O acesso também é revalidado com o Discord no heartbeat, com cache curto. A última conexão saindo remove a sala.

## Tokens e permissões

O link de captura leva um token aleatório de 256 bits, de uso único e expiração curta, no fragmento `#token=...` — o fragmento não é enviado ao servidor no pedido da página. A página remove o token da barra de endereço imediatamente e o troca por POST por uma sessão de captura. Não há access token do Discord na URL ou em localStorage.

O token fica vinculado ao usuário e à instância. A Activity do dono precisa estar conectada. As sessões expiram segundo `SESSION_TTL_SECONDS`, padrão de uma hora. Ao expirar, reabra o Testify.

A página solicita áudio se marcado, mas continua com vídeo se a fonte não disponibilizar áudio. Cancelar o seletor permite tentar novamente sem gerar outro link. Em capturas de áudio do sistema inteiro, o som do Discord também pode entrar: use áudio de guia quando possível e mantenha o player do transmissor silenciado.

## Configuração Discord

Use a aplicação que já corresponde ao seu bot. Confira:

1. **Activities → Enable Activities** e plataformas desejadas.
2. **OAuth2 → Redirects**: a URI cadastrada para o fluxo oficial, por exemplo `https://127.0.0.1`.
3. **Activities → URL Mappings**: prefixo `/`, target igual ao hostname HTTPS público, sem protocolo.
4. **Developer Mode** no cliente Discord.
5. Um ponto de entrada do tipo `PRIMARY_ENTRY_POINT` para iniciar a Activity.

Se o ponto de entrada já funciona, não é necessário registrá-lo outra vez. `npm run register-command` consulta os comandos e cria/atualiza somente o ponto de entrada, preservando os demais comandos do bot. Esse comando altera a aplicação no Discord; não faz parte dos testes locais automáticos.

`openInviteDialog` depende do contexto e das permissões; não funciona em DMs. A aplicação mostra uma mensagem apropriada nesses casos.

## Produção no Railway

O Dockerfile usa Node 22 e um processo Express que serve frontend, captura, API e WebSocket. O Railway fornece `PORT`; o container escuta em `0.0.0.0`.

Variáveis do serviço:

- `DISCORD_CLIENT_ID`, `VITE_DISCORD_CLIENT_ID` iguais.
- `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` no backend.
- `PUBLIC_BASE_URL=https://seu-host.up.railway.app`.
- `ALLOWED_ORIGINS=https://<APPLICATION_ID>.discordsays.com,https://seu-host.up.railway.app`.
- `SESSION_TTL_SECONDS=3600`, `CAPTURE_TOKEN_TTL_SECONDS=120`.
- `NODE_ENV=production`, `HOST=0.0.0.0`.

O ID do frontend é usado no build. Sessões e salas são em memória: mantenha **uma réplica**. Deploy/restart encerra transmissões e requer reabrir a Activity. Healthcheck: `/health`.

O custo de saída cresce com o público: um stream de 3 Mbps enviado a cinco viewers representa aproximadamente 15 Mbps de saída de vídeo no servidor, além de áudio e overhead. É uma estimativa aritmética, não uma medição do provedor.

## Verificações locais

```powershell
npm test
npm run check
npm run test:browser
```

- `test`: OAuth, vínculo à instância, tokens, limite de espectadores, exclusividade, encerramento autorizado, isolamento entre salas, entrada tardia e recuperação de filas.
- `check`: sintaxe do servidor e build de produção.
- `test:browser`: Chrome headless com perfil temporário, mídia sintética canvas+áudio e sockets reais em localhost. Verifica decodificação, entrada tardia, troca de perfil, reconexão de viewer/captura, encerramento remoto e páginas compiladas.
- Artefatos gerados ficam em `test-results/`, ignorado pelo Git.
- O teste de navegador não usa credenciais reais e **não substitui** o teste de dois PCs dentro do Discord.

Referências: [Networking](https://docs.discord.com/developers/activities/development-guides/networking), [instâncias e participantes](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience), [ações oficiais](https://docs.discord.com/developers/activities/development-guides/user-actions), [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/).
