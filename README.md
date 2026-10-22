# ZTales Bridge — setup guide for server owners

> This is the public, deploy-only copy of the ZTales bridge. It is exported from the ZTales
> project; changes are made there and pushed here. The mod itself is on the Steam Workshop.
>
> No license file is included: all rights reserved. You may deploy it for your own server.
>
> There is no one-click "Deploy to Cloudflare" button on purpose: it would create the Worker but
> not the database tables, the FTP settings or the AI limits you should choose. Follow the steps.

ZTales is a Project Zomboid Build 42 mod that runs an AI-written mystery on a multiplayer server.
The mod itself never goes online. This **bridge** is the small program that does: it reads the
mod's files from your game server over **FTP**, asks the **AI** for the next part of the story,
checks the answer with fixed rules, and writes it back for the mod to place in the world.

The bridge is a **Cloudflare Worker**: it runs on Cloudflare's servers, on the **free plan**,
every minute, by itself. You don't keep any PC on. You set it up once (about 20 minutes) and
then forget about it.

You don't need to be a programmer. You will copy and paste a few commands into a terminal.

Portuguese version: [README.pt-BR.md](README.pt-BR.md).

---

## Before you start: AI costs (please read)

- ZTales uses an AI provider **you** choose (Anthropic or OpenRouter) with **your own API key**.
  Every AI call is billed by that provider **to your account**, under the provider's own terms
  of service, usage policies and prices.
- The authors of ZTales **do not sell, resell, collect, proxy or control** AI usage. We never see
  your key or your bill. We are **not responsible** for what the AI costs you, for provider
  outages or rate limits, for the content the AI generates, or for changes to a provider's
  prices or policies. You use the provider at your own discretion.
- **You choose the models** (game sandbox options, page ZTales) and **you set the limits**.
  Always set a monthly spending limit (or use prepaid credits with auto-reload off) in your
  provider's console. That is the only limit that can never be bypassed.

Built-in safeguards in the bridge (in `wrangler.toml`, change them to suit you):

| Setting | Default | What it does |
|---|---|---|
| `MAX_USD_PER_DAY` | `1` (US$1) | When the AI calls of the last 24 h reach this, the bridge stops asking until the day rolls over. Failed calls count too. |
| `MAX_CALLS_PER_DAY` | `48` | Hard cap on AI calls per day, whatever they cost. |
| `AI_MAX_TOKENS_*` | 12000 / 8000 / 1500 / 2000 | Caps the length of each answer (story / chapter / dream / watch), so one runaway answer can't cost much. |
| no `AI_KEY` or `AI_MODEL` | — | The bridge makes **no** AI call at all. The mod keeps running; no story is written. |

Typical cost, measured on a live server (October 2026):

| Models (story + chapters) | Cost per story |
|---|---|
| Opus 5.5 + Haiku 5.5 (default) | about **US$0.65** |
| Sonnet 5.5 + Haiku 5.5 | about **US$0.35** |
| Opus 5.5 + Sonnet 5.5 | about US$1.2–1.8 |

On top of that come small calls while a chapter is open (one per player per 12 hours of real
play, about US$0.01 each with Haiku) and a dream after a death (about US$0.01). These are
estimates: prices are set by the provider and can change; your real cost is what the provider
bills. The admin panel in game shows the cost the bridge measured.

---

## What you need

1. **Your game server's FTP details**: host (address), port (usually 21), username, password.
   They are in your host's control panel (4netplayers, G-Portal, Nitrado... all have an "FTP"
   page).
2. **A free Cloudflare account**: <https://dash.cloudflare.com/sign-up>.
3. **An AI API key**, one of:
   - **Anthropic** (direct, the makers of Claude): <https://console.anthropic.com> → *Settings →
     Billing* (add credits) → *API Keys* → *Create Key*. Set a limit in *Settings → Limits*.
   - **OpenRouter** (many providers, one account): <https://openrouter.ai> → *Credits* (add
     credits) → *Keys* → *Create Key*. You can give the key its own credit limit.
4. **Node.js** (LTS version) on your PC, only for the setup: <https://nodejs.org>. Install it with
   the default options.
5. **The ZTales files**: download this repository as a ZIP (green *Code* button → *Download ZIP*)
   and unzip it anywhere, for example `C:\ztales`.

The ZTales mod must be installed on the game server (Workshop item, `Mods=ZTales`) and the server
started at least once, so the mod has created its folder.

---

## Step by step

All commands are typed in a terminal **inside the unzipped folder** (the one with
`wrangler.toml` in it). On Windows: open that folder, click the address bar, type `cmd` and
press Enter. A black window opens already in the right folder.

### 1. Install the tools and log in to Cloudflare

```bash
npm install
npx wrangler login
```

A browser page opens: click *Allow*. Close it and go back to the terminal.

### 2. Create the database

```bash
npx wrangler d1 create ztales
```

It prints a block with `database_id = "..."`. Open `wrangler.toml` in Notepad, find the
line `database_id = "PUT-YOUR-D1-ID-HERE"` and **replace the placeholder with your id**. Save. Then create the tables:

```bash
npx wrangler d1 execute ztales --remote --file=schema.sql
```

### 3. Tell the bridge where the mod's folder is

Still in `wrangler.toml`, under `[vars]`:

- `ZTALES_ROOT`: the mod's folder **as your FTP account sees it**. On most hosts this is
  `/Zomboid/Lua/ZTales` (the default). Step 6 checks it for you.
- `FTP_PORT`: usually `"21"`. `FTP_TLS`: `"1"` only if your host requires FTP over TLS (FTPS).
- `TZ_OFFSET_HOURS`: your players' time zone (Brazil `"-3"`, UK `"0"`, US East `"-5"`).

### 4. Choose the AI provider and default model

Still in `[vars]`:

| You use | `AI_PROVIDER` | `AI_MODEL` example |
|---|---|---|
| Anthropic | `"anthropic"` | `"claude-haiku-5-5"` |
| OpenRouter | `"openrouter"` | `"anthropic/claude-haiku-5.5"` |

`AI_MODEL` **must not be empty**, or the bridge never calls the AI. `AI_STORY_MODEL` (optional) is
the stronger model for designing each story, e.g. `"claude-opus-5-5"`. You can leave both as a
cheap model here and choose per task in the game (step 8). Set `MAX_USD_PER_DAY` to what you
accept to spend in a day. Save the file.

### 5. Type the secrets and deploy

Each command asks you to type (or paste) a value. Nothing is shown and nothing is saved in the
files.

```bash
npx wrangler secret put FTP_HOST
npx wrangler secret put FTP_USER
npx wrangler secret put FTP_PASS
npx wrangler secret put TOKEN
npx wrangler secret put AI_KEY
npx wrangler secret put BIBLE_KEY
npx wrangler deploy
```

- `FTP_HOST`: the address only, without `ftp://` and without the port (e.g. `123.45.67.89`).
- `TOKEN`: a password **you invent** (20+ letters and numbers). It protects the bridge's pages.
- `AI_KEY`: the Anthropic or OpenRouter key from "What you need".
- `BIBLE_KEY`: another long random text **you invent** (at least 16 characters). It encrypts the
  story's secrets in the database, so not even you spoil the ending by opening it. **Keep a copy
  and never change it** while a story runs: with a different key the bridge can't read the
  current story.

`npx wrangler deploy` prints your bridge's address, like
`https://ztales-bridge.<your-name>.workers.dev`. Keep it.

(If a step asks "create the secret on a Worker that doesn't exist yet?", answer yes.)

### 6. Check the connection

Open in your browser (your address and your TOKEN):

```
https://ztales-bridge.<your-name>.workers.dev/probe?token=<TOKEN>
```

Good answer: `"ok": true`, and under `parent`, `"has_ztales": true`. The bridge logged in over FTP
and found the mod's folder. It writes nothing.

### 7. Check it in the game

Join your server as admin, right-click the ground → **ZTales** panel. Within a few minutes the
bridge shows as **connected**. You can also open `.../status?token=<TOKEN>`: `last_poll` should be
a recent time.

### 8. Choose the models in the game

Server settings → **Sandbox options** → page **ZTales**:

| Option | Writes | Default |
|---|---|---|
| AI model: the story | the whole story, once when it begins | Opus 5.5 |
| AI model: the chapters | each chapter, several per story | Haiku 5.5 |
| AI model: the dream | a new life's dream after a death | Haiku 5.5 |

Each can be *Default (the bridge's setting)*, Haiku 5.5, Sonnet 5.5 or Opus 5.5. Haiku is the
cheapest, Opus the strongest. The bridge accepts only these three models from the game and maps
them to your provider's id. Restart the server after changing sandbox options.

That's it. The first story begins once players are online.

---

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| `{"error":"unauthorized"}` | The `token=` in the address is not your `TOKEN`. Retype it, or set it again with `npx wrangler secret put TOKEN`. |
| `/probe` gives `"ok": false` with a login or timeout error | FTP host, user, password or port wrong. Check them in your host's panel and type them again (step 5). If the host requires FTPS, set `FTP_TLS = "1"` and `npx wrangler deploy`. |
| `/probe` works but `"has_ztales": false` | `ZTALES_ROOT` points at the wrong place, or the mod hasn't run yet. Look at `parent.sample` (the folders it found) and fix the path in `wrangler.toml`, then `npx wrangler deploy`. Start the server once with the mod on. |
| Panel says the bridge is not connected | Wait 10 minutes (an empty server is checked every 10). Check `/status`: an old `last_poll` means the FTP is failing; see `/probe`. After several FTP failures the bridge waits longer between tries, on purpose. |
| Connected, but no story starts | `AI_MODEL` empty, or `AI_KEY` / `BIBLE_KEY` missing. Also: no credits at the provider, or today's `MAX_USD_PER_DAY` / `MAX_CALLS_PER_DAY` already reached (it resumes the next day). Players must be online. |
| Want to see what the bridge is doing | `npx wrangler tail` shows its log live (one line per tick: what it pulled and pushed). The Cloudflare dashboard → *Workers* → *ztales-bridge* → *Logs* shows the same. |
| Changed something in `wrangler.toml` | It only takes effect after `npx wrangler deploy`. Secrets take effect at once. |
| Want to stop all AI spending now | `npx wrangler secret delete AI_KEY`, or revoke the key in the provider's console. The mod keeps running; the story waits. |
| Want to remove the bridge | Cloudflare dashboard → *Workers* → *ztales-bridge* → *Settings* → *Delete*, and delete the `ztales` D1 database. |

Cloudflare's free plan is enough: the bridge runs one short task per minute, well inside the free
limits.

---

## How it works (for the curious)

### Each minute

1. Decides without connecting whether to poll: every minute while players are online, every
   10 minutes while the server is empty, at once when something is waiting to be sent.
2. Reads `outbox/seq.json` (one small file). Unchanged: done.
3. Otherwise pulls `events-*` and `journal-*` into D1, deletes them, deletes inbox files the mod
   acknowledged, notes a new catalog version, and adds revealed facts to the ledger.
4. Sends queued directives through the gates (`src/gates.js`) into `inbox/`, and writes
   `inbox/bridge-heartbeat.json` so the admin panel shows the bridge as connected.

The Worker bundles `docs/04-brain-handoff.md` and `docs/09-lore-digest.md` as the AI's
instructions; keep them where they are.

### Pages (all need the TOKEN, as `?token=` or `Authorization: Bearer`)

- `GET /probe`: logs in over FTP, counts the files in `outbox/`, `inbox/`, `catalog/`; writes nothing.
- `GET /status`: last poll, players online, catalog version, facts known, batches waiting. Never
  story text, never the server address.
- `POST /tick-now`: one tick right away.

### Models

The bridge's own models are `AI_MODEL` (chapters, dreams) and `AI_STORY_MODEL` (the story's
bible). The game's sandbox choice overrides them per task; *Default* keeps them. The game names
only `claude-haiku-5-5`, `claude-sonnet-5-5` or `claude-opus-5-5` (never any other name from a
game file); the bridge maps them to `claude-sonnet-5-5` on Anthropic or
`anthropic/claude-sonnet-5.5` on OpenRouter. `AI_FALLBACK_MODELS` still applies. The `calls`
table records the model that answered each call. `AI_MODELS_LOCKED` (local tests) makes the
bridge's models win over the game's.

### Paid answers are never thrown away

Every answer's text, usable or not, is kept in the `calls` table (`raw`, sealed with `BIBLE_KEY`
like the bible; `note` says "repaired" or why it failed). A reply that is not valid JSON is
repaired first (stray quotes, missing or extra commas, a cut tail) and used if the gates accept
it. With `AI_PROVIDER = "anthropic"` the answer comes as one tool call the API parses
(`AI_STRUCTURED`, on by default), and its cost is estimated from Anthropic's list prices, so a
direct key counts in `MAX_USD_PER_DAY` too (OpenRouter reports the cost itself). A failed call is
not asked again at once: the back-off holds, and the next ask tells the AI what failed.

### Tests

```bash
npm test                                   # pure logic, a fake FTP server, D1 on node:sqlite
node test/local-workerd.mjs <wrangler>     # the real Worker in Cloudflare's local runtime
```

Neither touches the network or a Cloudflare account.
