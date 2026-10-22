# ZTales Bridge — guia de instalação para donos de servidor (PT-BR)

Tradução do guia em [README.md](README.md). Em caso de diferença, vale o README.

O ZTales é um mod de Project Zomboid Build 42 que roda um mistério escrito por IA num servidor
multiplayer. O mod em si nunca acessa a internet. Quem acessa é este **bridge**: um programa
pequeno que lê os arquivos do mod no servidor do jogo por **FTP**, pede à **IA** a próxima parte
da história, confere a resposta com regras fixas e devolve o resultado para o mod colocar no
mundo.

O bridge é um **Cloudflare Worker**: roda nos servidores da Cloudflare, no **plano gratuito**, a
cada minuto, sozinho. Você não precisa deixar PC ligado. Configura uma vez (uns 20 minutos) e
esquece.

Não precisa ser programador. Você vai copiar e colar alguns comandos num terminal.

---

## Antes de começar: custos de IA (leia)

- O ZTales usa um provedor de IA que **você** escolhe (Anthropic ou OpenRouter), com a **sua
  própria chave de API**. Cada chamada à IA é cobrada por esse provedor **na sua conta**, pelos
  termos de uso, políticas e preços do próprio provedor.
- Os autores do ZTales **não vendem, revendem, recolhem, intermediam nem controlam** o uso de IA.
  Nunca vemos a sua chave nem a sua fatura. **Não nos responsabilizamos** pelo que a IA custar,
  por quedas ou limites do provedor, pelo conteúdo que a IA gerar, nem por mudanças de preço ou
  de política do provedor. Você usa o provedor por sua conta.
- **Você escolhe os modelos** (opções sandbox do jogo, página ZTales) e **você define os
  limites**. Configure sempre um limite mensal de gasto (ou use créditos pré-pagos com recarga
  automática desligada) no painel do provedor. Esse é o único limite que nada consegue furar.

Proteções embutidas no bridge (em `wrangler.toml`, ajuste como quiser):

| Configuração | Padrão | O que faz |
|---|---|---|
| `MAX_USD_PER_DAY` | `1` (US$1) | Quando as chamadas das últimas 24 h chegam a esse valor, o bridge para de pedir até o dia virar. Chamadas que falharam também contam. |
| `MAX_CALLS_PER_DAY` | `48` | Teto de chamadas por dia, custe o que custar. |
| `AI_MAX_TOKENS_*` | 12000 / 8000 / 1500 / 2000 | Limita o tamanho de cada resposta (história / capítulo / sonho / acompanhamento), para uma resposta descontrolada não custar caro. |
| sem `AI_KEY` ou `AI_MODEL` | — | O bridge **não** faz nenhuma chamada à IA. O mod continua rodando; nenhuma história é escrita. |

Custo típico, medido num servidor real (outubro de 2026):

| Modelos (história + capítulos) | Custo por história |
|---|---|
| Opus 5.5 + Haiku 5.5 (padrão) | cerca de **US$0,65** |
| Sonnet 5.5 + Haiku 5.5 | cerca de **US$0,35** |
| Opus 5.5 + Sonnet 5.5 | cerca de US$1,2–1,8 |

Somam-se chamadas pequenas enquanto um capítulo está aberto (uma por jogador a cada 12 horas de
jogo real, cerca de US$0,01 cada com Haiku) e um sonho depois de uma morte (cerca de US$0,01).
São estimativas: os preços são do provedor e podem mudar; o custo real é o que o provedor cobrar.
O painel de admin no jogo mostra o custo medido pelo bridge.

---

## O que você precisa

1. **Os dados de FTP do servidor do jogo**: host (endereço), porta (geralmente 21), usuário e
   senha. Ficam no painel da sua hospedagem (4netplayers, G-Portal, Nitrado... todas têm uma
   página "FTP").
2. **Uma conta gratuita na Cloudflare**: <https://dash.cloudflare.com/sign-up>.
3. **Uma chave de API de IA**, uma das duas:
   - **Anthropic** (direto, criadores do Claude): <https://console.anthropic.com> → *Settings →
     Billing* (adicione créditos) → *API Keys* → *Create Key*. Defina um limite em *Settings →
     Limits*.
   - **OpenRouter** (vários provedores, uma conta): <https://openrouter.ai> → *Credits* (adicione
     créditos) → *Keys* → *Create Key*. Dá para pôr um limite de crédito na própria chave.
4. **Node.js** (versão LTS) no seu PC, só para a instalação: <https://nodejs.org>. Instale com as
   opções padrão.
5. **Os arquivos do ZTales**: baixe este repositório em ZIP (botão verde *Code* → *Download ZIP*)
   e descompacte onde quiser, por exemplo `C:\ztales`.

O mod ZTales precisa estar instalado no servidor (item da Workshop, `Mods=ZTales`) e o servidor
precisa ter sido iniciado ao menos uma vez com ele, para o mod criar a pasta dele.

---

## Passo a passo

Todos os comandos são digitados num terminal **dentro da pasta descompactada** (a que tem o
`wrangler.toml`). No Windows: abra essa pasta, clique na barra de endereço, digite `cmd` e aperte
Enter. Abre uma janela preta já na pasta certa.

### 1. Instalar as ferramentas e entrar na Cloudflare

```bash
npm install
npx wrangler login
```

Abre uma página no navegador: clique em *Allow*. Feche e volte ao terminal.

### 2. Criar o banco de dados

```bash
npx wrangler d1 create ztales
```

Ele mostra um bloco com `database_id = "..."`. Abra `wrangler.toml` no Bloco de Notas, ache
a linha `database_id = "PUT-YOUR-D1-ID-HERE"` e **troque pelo seu id**. Salve. Depois crie as tabelas:

```bash
npx wrangler d1 execute ztales --remote --file=schema.sql
```

### 3. Dizer ao bridge onde fica a pasta do mod

Ainda no `wrangler.toml`, em `[vars]`:

- `ZTALES_ROOT`: a pasta do mod **como a sua conta FTP enxerga**. Na maioria das hospedagens é
  `/Zomboid/Lua/ZTales` (o padrão). O passo 6 confere isso para você.
- `FTP_PORT`: geralmente `"21"`. `FTP_TLS`: `"1"` só se a hospedagem exigir FTP com TLS (FTPS).
- `TZ_OFFSET_HOURS`: o fuso dos jogadores (Brasília `"-3"`).

### 4. Escolher o provedor e o modelo padrão

Ainda em `[vars]`:

| Você usa | `AI_PROVIDER` | Exemplo de `AI_MODEL` |
|---|---|---|
| Anthropic | `"anthropic"` | `"claude-haiku-5-5"` |
| OpenRouter | `"openrouter"` | `"anthropic/claude-haiku-5.5"` |

`AI_MODEL` **não pode ficar vazio**, senão o bridge nunca chama a IA. `AI_STORY_MODEL` (opcional)
é o modelo mais forte, que desenha cada história, por exemplo `"claude-opus-5-5"`. Pode deixar os
dois num modelo barato aqui e escolher por tarefa no jogo (passo 8). Ponha em `MAX_USD_PER_DAY` o
quanto aceita gastar num dia. Salve o arquivo.

### 5. Digitar os segredos e publicar

Cada comando pede para digitar (ou colar) um valor. Nada aparece na tela e nada fica salvo nos
arquivos.

```bash
npx wrangler secret put FTP_HOST
npx wrangler secret put FTP_USER
npx wrangler secret put FTP_PASS
npx wrangler secret put TOKEN
npx wrangler secret put AI_KEY
npx wrangler secret put BIBLE_KEY
npx wrangler deploy
```

- `FTP_HOST`: só o endereço, sem `ftp://` e sem a porta (ex.: `123.45.67.89`).
- `TOKEN`: uma senha **que você inventa** (20+ letras e números). Protege as páginas do bridge.
- `AI_KEY`: a chave da Anthropic ou da OpenRouter.
- `BIBLE_KEY`: outro texto longo e aleatório **que você inventa** (no mínimo 16 caracteres). Ele
  criptografa os segredos da história no banco, para nem você estragar o final abrindo o banco.
  **Guarde uma cópia e nunca troque** enquanto uma história estiver rodando: com outra chave o
  bridge não consegue ler a história atual.

`npx wrangler deploy` mostra o endereço do seu bridge, algo como
`https://ztales-bridge.<seu-nome>.workers.dev`. Guarde.

(Se algum passo perguntar se quer criar o segredo num Worker que ainda não existe, responda sim.)

### 6. Conferir a conexão

Abra no navegador (o seu endereço e o seu TOKEN):

```
https://ztales-bridge.<seu-nome>.workers.dev/probe?token=<TOKEN>
```

Resposta boa: `"ok": true` e, em `parent`, `"has_ztales": true`. O bridge entrou por FTP e achou a
pasta do mod. Não escreve nada.

### 7. Conferir no jogo

Entre no servidor como admin, clique com o botão direito no chão → painel **ZTales**. Em poucos
minutos o bridge aparece como **conectado**. Também dá para abrir `.../status?token=<TOKEN>`:
`last_poll` deve ser um horário recente.

### 8. Escolher os modelos no jogo

Configurações do servidor → **Opções sandbox** → página **ZTales**:

| Opção | Escreve | Padrão |
|---|---|---|
| Modelo de IA: a história | a história inteira, uma vez quando ela começa | Opus 5.5 |
| Modelo de IA: os capítulos | cada capítulo, vários por história | Haiku 5.5 |
| Modelo de IA: o sonho | o sonho de uma nova vida depois de uma morte | Haiku 5.5 |

Cada uma pode ser *Padrão (configuração do bridge)*, Haiku 5.5, Sonnet 5.5 ou Opus 5.5. Haiku é o
mais barato, Opus o mais forte. Reinicie o servidor depois de mudar opções sandbox.

Pronto. A primeira história começa quando houver jogadores online.

---

## Problemas comuns

| O que aparece | Por quê, e o que fazer |
|---|---|
| `{"error":"unauthorized"}` | O `token=` do endereço não é o seu `TOKEN`. Digite de novo, ou redefina com `npx wrangler secret put TOKEN`. |
| `/probe` dá `"ok": false` com erro de login ou timeout | Host, usuário, senha ou porta do FTP errados. Confira no painel da hospedagem e digite de novo (passo 5). Se a hospedagem exigir FTPS, ponha `FTP_TLS = "1"` e rode `npx wrangler deploy`. |
| `/probe` funciona mas `"has_ztales": false` | `ZTALES_ROOT` aponta para o lugar errado, ou o mod ainda não rodou. Veja `parent.sample` (as pastas que ele achou), corrija o caminho no `wrangler.toml` e rode `npx wrangler deploy`. Inicie o servidor uma vez com o mod. |
| O painel diz que o bridge não está conectado | Espere 10 minutos (servidor vazio é verificado a cada 10). Veja `/status`: `last_poll` antigo quer dizer que o FTP está falhando; veja `/probe`. Depois de várias falhas de FTP o bridge espera mais entre tentativas, de propósito. |
| Conectado, mas nenhuma história começa | `AI_MODEL` vazio, ou faltou `AI_KEY` / `BIBLE_KEY`. Ou: sem créditos no provedor, ou o `MAX_USD_PER_DAY` / `MAX_CALLS_PER_DAY` do dia já foi atingido (volta no dia seguinte). Precisa haver jogadores online. |
| Quero ver o que o bridge está fazendo | `npx wrangler tail` mostra o log ao vivo. O painel da Cloudflare → *Workers* → *ztales-bridge* → *Logs* mostra o mesmo. |
| Mudei algo no `wrangler.toml` | Só vale depois de `npx wrangler deploy`. Segredos valem na hora. |
| Quero parar todo gasto de IA agora | `npx wrangler secret delete AI_KEY`, ou revogue a chave no painel do provedor. O mod continua rodando; a história espera. |
| Quero remover o bridge | Painel da Cloudflare → *Workers* → *ztales-bridge* → *Settings* → *Delete*, e apague o banco D1 `ztales`. |

O plano gratuito da Cloudflare basta: o bridge roda uma tarefa curta por minuto, bem dentro dos
limites gratuitos.
