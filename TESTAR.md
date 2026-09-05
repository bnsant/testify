# Ligar e testar o Testify

## 1. Abrir o projeto

Abra dois terminais PowerShell na pasta:

```powershell
cd "C:\Users\berna\OneDrive\Área de Trabalho\Projetos\Testify"
```

Use Node 22 ou superior. Na primeira execução ou após atualizar dependências:

```powershell
npm ci
npm run doctor
```

O diagnóstico mostra campos ausentes e endereços, sem imprimir segredos. Não substitua o `.env` que já está configurado.

## 2. Iniciar localmente

No primeiro terminal:

```powershell
npm run dev
```

Mantenha esse terminal aberto. Frontend: `http://localhost:5173`. Backend padrão: `http://127.0.0.1:3001`.

Abrir localhost no Chrome mostra uma prévia da interface. Para transmitir de verdade, abra a Activity no Discord.

No segundo terminal:

```powershell
.\.tools\cloudflared.exe tunnel --url http://localhost:5173
```

Caso use uma instalação global:

```powershell
cloudflared tunnel --url http://localhost:5173
```

Copie a URL HTTPS exibida. Cada reinício de um túnel temporário pode gerar um domínio diferente.

## 3. Apontar o teste para o túnel

Crie ou edite `.env.local` na raiz, com o domínio gerado:

```dotenv
PUBLIC_BASE_URL=https://SEU-TUNEL.trycloudflare.com
HOST=127.0.0.1
PORT=3001
```

As credenciais continuam vindo do `.env` existente. Não copie tokens de usuário manualmente. Não coloque segredos em variáveis `VITE_*`.

Pare o primeiro terminal com Ctrl+C e rode novamente:

```powershell
npm run dev
```

No Developer Portal da aplicação **Testify**, em **Activities → URL Mappings**, anote o target atual do Railway e altere:

| Prefixo | Target do teste |
| --- | --- |
| `/` | `SEU-TUNEL.trycloudflare.com` |

O target é só o hostname, sem `https://`. Esse mapping pertence à aplicação inteira: enquanto estiver no túnel, quem abrir essa Activity usará o servidor local. Faça isso fora de uma sessão em andamento; para separar completamente os ambientes, use uma segunda aplicação Discord de teste.

Não é necessário alterar o serviço Railway nem registrar os comandos do bot para cada teste. Confira que o Chrome é o navegador padrão do Windows: o Discord abre o navegador padrão, não escolhe o executável por nome.

## 4. Conferir antes da call

Abra `https://SEU-TUNEL.trycloudflare.com/health`.

Esperado:

```json
{"ok":true,"discordConfigured":true}
```

Isso confirma servidor acessível e campos preenchidos, não valida por si só o OAuth. O login real é verificado ao abrir a Activity.

Se receber 502, confira os dois terminais e o domínio atual. Se a porta 5173 estiver ocupada, feche somente a instância anterior do Testify ou escolha outra configuração conscientemente: o Vite agora falha claramente em vez de mudar de porta silenciosamente.

## 5. Testar com dois PCs

1. PC A e PC B entram na mesma call.
2. PC A abre **Testify** pelo launcher de Activities.
3. PC B entra na **mesma Activity**. Estar apenas na mesma call não basta.
4. Os dois conferem nomes, avatares e participantes.
5. PC A clica **Compartilhar tela**.
6. Autoriza o link no diálogo do Discord.
7. No Chrome, escolhe **Equilibrado · 1080p30** e clica **Escolher tela**.
8. Escolhe uma janela, tela ou guia. Para som, marque a opção de compartilhar áudio do seletor quando ela estiver disponível.
9. Volta ao Discord mantendo a página de captura aberta.
10. PC B deve receber o vídeo automaticamente. Clica **Ativar áudio**, se quiser ouvir.
11. PC A deixa seu próprio player silenciado para evitar retorno de áudio.

## 6. Testar os casos que mais quebram transmissão

- **Entrada tardia:** inicie a transmissão antes de PC B entrar na Activity. Ele deve começar a assistir após uma breve ressincronização.
- **Qualidade:** mude de Equilibrado para Econômico na captura. O player pode pausar brevemente e deve voltar.
- **Reconexão:** feche e reabra apenas a Activity do PC B durante a transmissão.
- **Encerrar remotamente:** PC A clica Encerrar na Activity. O indicador de captura do Chrome deve parar e PC B deve voltar à sala vazia.
- **Parar pelo Chrome:** inicie novamente e use o botão nativo de parar compartilhamento.
- **Cancelar seleção:** abra uma captura nova, cancele o seletor e tente novamente pelo mesmo botão.
- **Sem áudio:** desmarque áudio antes da captura. O vídeo deve continuar funcionando.
- **Dono sai:** feche a Activity do PC A; após a tolerância de reconexão, a captura deve terminar.
- **Duas salas:** em outra instância, confirme que ninguém recebe a transmissão da primeira.
- **Rede diferente:** teste um PC em outra conexão, por exemplo hotspot, para validar o percurso real até o túnel.

## 7. Medir atraso

Compartilhe uma janela com cronômetro em movimento e compare a imagem original com o player do outro PC. Repita por alguns minutos e observe se o atraso cresce.

O campo Buffer indica apenas o tempo já recebido e ainda não reproduzido. Ele não mede captura + encoder + rede + player.

Se travar:

1. Tente Econômico.
2. Feche tarefas pesadas do PC transmissor.
3. Prefira uma guia/janela à tela 4K inteira.
4. Confira se a aceleração de hardware está habilitada no Chrome e Discord.
5. Diferencie instabilidade do túnel de desenvolvimento da hospedagem final.

O modo Movimento pede 720p60; o sistema pode entregar menos FPS. Não há garantia de 60 FPS ou de latência fixa.

## 8. Testes automáticos

Com Chrome instalado:

```powershell
npm test
npm run check
npm run test:browser
```

O teste de Chrome não precisa de Discord nem do túnel e não captura sua tela. Usa vídeo/áudio sintéticos e gera `test-results/browser.json`, `activity.png` e `capture.png`.

Se Chrome não estiver no caminho padrão:

```powershell
$env:CHROME_PATH = "C:\caminho\chrome.exe"
npm run test:browser
```

## 9. Depois da aprovação local, voltar ao Railway

1. Encerre as transmissões de teste.
2. Confira as alterações com `git diff`; não inclua `.env`, `.env.local` ou `test-results`.
3. Envie a versão testada pelo fluxo de deploy que seu serviço já usa.
4. Preserve as credenciais já configuradas no Railway.
5. Confira `PUBLIC_BASE_URL` apontando para o domínio Railway, `HOST=0.0.0.0` e `NODE_ENV=production`.
6. Deixe o Railway fornecer `PORT`; mantenha uma réplica.
7. Espere o build e o healthcheck `/health`.
8. Restaure o URL Mapping `/` para o hostname do Railway.
9. Feche e reabra a Activity nos dois PCs para obter o bundle e sessões novos.
10. Repita os passos de vídeo, áudio, entrada tardia e encerramento.
11. Encerre os terminais locais com Ctrl+C.

A aplicação não precisa de banco de dados para essas salas. Reiniciar/deployar o servidor encerra sessões em memória; todos devem reabrir a Activity.

## Erros comuns

- **Link sem token / expirado:** gere outro clicando em Compartilhar tela na Activity; recarregar a captura depois do uso não restaura o token.
- **Activity não aparece:** conferir Enable Activities, plataformas, Developer Mode e ponto de entrada. Se este estiver ausente, use `npm run register-command` uma vez.
- **403 no socket:** conferir origens e URL Mapping.
- **Falha de autenticação:** Client ID, Secret e Bot Token precisam ser da mesma aplicação; o usuário precisa estar na instância validada pelo Discord.
- **Formato incompatível:** iniciar novamente com todos os viewers já na sala ou usar Chrome/Edge nos computadores. O suporte a codecs é detectado; celular precisa ser validado separadamente.
- **Áudio da call voltou para a transmissão:** mantenha o player do dono sem áudio e prefira compartilhar o som de uma guia.
- **Convite em DM:** o diálogo oficial não está disponível nesse contexto; entre na Activity pelo próprio Discord.
