# HANDOFF — pogotracker

> Dense state dump for a fresh session. Read this first; it is self-contained.
> Last updated **2026-10-14**, live on GitHub Actions.

---

## 1. What this is

A shiny + 100%-IV Pokemon GO spawn monitor for **pogocoordinates.com**.
Started as a cap-bypass reverse-engineering exercise (see `CAP-BYPASS.md`),
evolved into a notifier, now running 24/7 on GitHub Actions.

**Goal state achieved:** phone receives two ntfy pushes per qualifying spawn.

---

## 2. The API

```
base   https://coordinates-api.pokemongopro.com
site   https://pogocoordinates.com          (Next.js, client-rendered)
       module 2437 = API base, 960 = fetch helper, 6603 = spec builder (chunk 3133)
backend Hetzner 46.225.53.252, Nuremberg, nginx/1.28.3 / Ubuntu, FastAPI
        /docs /openapi.json /redoc all DISABLED
```

| method | path | notes |
|---|---|---|
| POST | `/search` | the main query. auth raises cap 5 → 10 |
| GET | `/nests/pokemon` | free, uncapped, no auth, no trainer gate (`POST` = 405) |
| GET | `/reveal/{code}` | resolves `reveal_code` → raw lat/lng |
| POST | `/trainer/lookup` | **requires** `Authorization` header |
| POST | `/trainer/confirm` | **requires** `Authorization` header |
| GET | `/users/me` | JWT validity check |
| GET | `/health` | liveness |

### Cap behavior (the core finding)

- Cap is **server-side and per-QUERY**, not per-account and not client-side.
- `limit`, `offset`, `page`, `cursor` in the body are **all ignored**.
- anon = 5 rows, JWT = 10 rows (`tier=logged_in`).
- **Bypass:** each query returns top-N of *whatever filter you supply*, and the
  filters ARE honored server-side. So union top-N across many filtered slices
  and dedupe on `encounter_id` — total becomes unbounded. That is
  `pogo-harvest.mjs`.

### Rate limit — important

Rolling window, ~1 req/6s. On breach:

```json
{"detail":{"error":"rate_limited","retry_after":N}}
```

`N` is **SECONDS**. Honor it verbatim and **stop** — retrying into the box makes
it worse. (Kovak once got `retry_after: 2501` ≈ 42 min.) Each GitHub Actions
run gets a fresh IP, so cloud polling rarely trips this.

### Shiny semantics

`shiny` in the public feed is **the scanner bot's own roll, not yours**. Your
shiny is rolled per-account server-side. Therefore:

- `{"pokemon_ids":[4],"shiny_only":true}` needs `Authorization` + a **linked**
  trainer, else `403 trainer_not_linked`.
- With JWT: returns `n=10 cap=10 tier=logged_in`, rows genuinely `shiny=true`.

Confirmed working specimens:

```json
{"pokemon_ids":[4],"shiny_only":true,"sort":"DSP"}
{"pokemon_ids":[4],"iv_mode":"percent","iv_percent_min":100,"sort":"DSP"}
```

Shiny **+** hundo combined is genuinely rare: 0 for Charmander alone, 3–4
across all species at any moment.

---

## 3. Account state

| item | value |
|---|---|
| site login | Discord — handle deliberately unpublished; it lives in `jwt.txt` |
| JWT | `jwt.txt` (143 b) → GitHub Secret `POGO_JWT` |
| trainer | name + numeric ID live in `trainer_id.txt` (gitignored). Not published. |
| team / level | Valor, L44 |
| linked? | **ALREADY linked**, `linked_at 2026-10-09`. No action needed. |
| `trainer_cap` | 1 **per site account** — a 2nd trainer needs a 2nd site account |

GitHub account: **`maftynehnoa-dot`**, already authed on this machine via `gh`
CLI with scopes `gist, read:org, repo, workflow`. (`workflow` is what permits
pushing Actions files.) Other repo: `pencarian-pokemon` (private) — an iOS
WKWebView shell wrapping this same site, built with Actions.

---

## 4. Notification contract (final — do not redesign without asking)

Channel: **ntfy app**, topic = **see local `ntfy_topic.txt`** (gitignored — the
topic is deliberately NOT written into this file because the repo is public and
ntfy topics are unauthenticated). Mirrored into GitHub Secret `NTFY_TOPIC`.
Priority 5 / urgent.

**Push 1 — detail:**

```
SHINY +100% IV
Name  iv=x/x/x
cp=… lvl=… size=…
<maps link>
despawns ~N min
```

**Push 2 — coords only:**

```
<lat> <lng>
```

Bare, **ONE line, space-separated**, for long-press copy.

### Hard rules learned the hard way

- **HTTP headers to ntfy MUST be ASCII/Latin-1.** Any char > 255 throws
  `Cannot convert argument to a ByteString because the character at index N has
  a value of 8212 which is greater than 255` — that was an em-dash (U+2014) in
  a `Title:` header. Both `Title:` lines are swept to strip non-ASCII.
  **Bodies may be UTF-8**; only headers are constrained.
- Kovak confirmed the format: *"i receive it perfectly."* Preserve it.

---

## 5. GitHub Actions deployment

Repo: **https://github.com/maftynehnoa-dot/pogotracker** — PUBLIC, branch `main`.

```
.github/workflows/pogo-monitor.yml   cron + run steps
cloud/cloud-monitor.mjs              single-shot monitor (env-driven)
seen.json                            dedupe store, committed back by the run
README.md                            end-user setup guide
CAP-BYPASS.md                        the reverse-engineering notes
```

| kind | name | value |
|---|---|---|
| Secret | `POGO_JWT` | from `jwt.txt` |
| Secret | `NTFY_TOPIC` | value of `ntfy_topic.txt` (never inline it here) |
| Variable | `SPECIES_IDS` | `4,1,7,133` — **pass A**, the shiny watch (Charmander/Bulbasaur/Squirtle + **Eevee**, added 2026-10-15). Shiny + 100% IV, so a hundo Eevee only. |
| Variable | `SHINY` | `true` — pass A shiny toggle |
| Variable | `HUNDO_IDS` | *(deleted 2026-10-11)* — **pass B off**; was `92` (Gastly hundo test) |
| Variable | `MIN_IV` | `100` — shared by both passes |

### Two watch passes

`cloud-monitor.mjs` runs up to two independent queries per tick:

- **pass A** `SPECIES_IDS` + `SHINY` — the original shiny watch.
- **pass B** `HUNDO_IDS` — a second filter that sets `shiny_only:false` and
  watches for perfect IV regardless of shininess.

Pass B exists because shiny **+** hundo together is genuinely rare (probe on
2026-10-11: shiny Gastly hundo = 0 live, plain Gastly hundo = **7 live**). If
you want the notification path to actually fire while testing, point
`HUNDO_IDS` at a common species.

Dedupe is **global on `encounter_id`** across both passes — a spawn satisfying
both alerts exactly once.

**Bug fixed 2026-10-11:** `seen.json` had never actually persisted — the file
was untracked (allowlist .gitignore) and `git diff` ignores untracked files,
so the persist step no-op'd every run and cloud dedupe lived only within a
single tick. Now `seen.json` is force-tracked and the persist step uses
`git add -f` + `git status --porcelain`. Effect of the fix: a live hit no
longer re-alerts on every 5-min tick until despawn.

**Volume warning:** a common species at 100% IV is a *firehose*. Gastly hundos
run ~7 live at any moment with 15–30 min despawns, so expect on the order of
15–25 alerts/hour. Pass B is **currently OFF** — `HUNDO_IDS` was deleted from
Repo Variables on 2026-10-11 after testing finished. Pass A keeps running.
Re-enable with `gh variable set HUNDO_IDS --body "92"`.

- Cron: `2-57/5 * * * *` — **UTC** phase offset (:02,:07,:12…). Round minutes
  (`*/5`) are where GitHub's scheduler piles up and ticks drift 10–20 min; the
  offset dodges the worst of it. Remaining drift under platform load is
  GitHub-side and not fixable from our end.
- Trigger: `workflow_dispatch` for manual runs.
- `permissions: contents: write` so the run can commit `seen.json`.
- `concurrency: pogo-monitor`, `cancel-in-progress: false` — no overlap.
- Node **22** (20 is deprecated on runners).
- Public repo ⇒ **unlimited free minutes**. Private would cap at 2,000 min/mo.

**Verified:** run `38145730184` green, log line
`[+] 0 row(s), 0 new  (cap=10, tier=logged_in)` — JWT valid on the runner.

### Failure modes to expect

1. **60-day auto-disable.** Scheduled workflows stop after 60 days with no repo
   activity. GitHub emails first. Commit *anything* to reset the clock.
   *This is the #1 way it dies silently.*
2. **JWT expiry.** Runs start failing `401` / `Invalid token` → refresh
   `POGO_JWT`.
3. **Cron lag** is normal, not a bug.
4. **Fresh runner IP per run** ⇒ far fewer penalty boxes than home-IP polling.

---

## 5b. Instance 2 — `pogotracker2`

A 1:1 second deployment on the **same GitHub account** (`maftynehnoa-dot`),
separate repo `pogotracker2`, for a second trainer — its own site account,
its own ntfy topic, its own dedupe store. Built **2026-10-11**.

| item | value |
|---|---|
| repo | https://github.com/maftynehnoa-dot/pogotracker2 (PUBLIC) |
| workbench clone | `G:\AI\poketracker2` — separate directory, identical layout |
| trainer | 2nd site account; ID lives in `G:\AI\poketracker2\trainer_id.txt` (gitignored). Not published. |
| site JWT | 2nd site account (`trainer_cap`=1 forces a separate login); mirrored to that repo's `POGO_JWT` secret |
| ntfy topic | NEW topic, local `G:\AI\poketracker2\ntfy_topic.txt` + secret `NTFY_TOPIC` |
| vars | `SHINY=true` `MIN_IV=100`, pass B (`HUNDO_IDS`) off. **Pass A = shiny + 100% IV** on `SPECIES_IDS=4,1,7,374,375,111,112,529,530` — starters + Beldum/Metang/Rhyhorn/Rhydon/Roggenrola/Boldore (2026-10-12 correction: Kovak wanted shiny+hundo, not plain hundo). |
| seen.json | **independent** dedupe store, seeded empty at creation |
| cron | `4-59/5 * * * *` (:04,:09,… UTC) — same 5-min cadence, offset phase vs instance 1 so the two don't land on the same minute |

**State: LIVE** since 2026-10-11. JWT captured (2nd site account, Google
login), secret set, workflow enabled. Verified: run `38152598315` green,
`tier=logged_in` cap 10, first alert delivered, `seen.json` persisted by the
fixed step (`chore: update seen store` commit `3137d9f`).

**Sync note:** once both repos run once, their `seen.json` histories diverge
independently — code changes must be pushed to each repo separately. If
merging across, always keep each side's own `seen.json`.

---

## 5c. Instance 3 — `pogotracker3`

A third deployment under a **separate GitHub account** (`StellaNoxFleurette`),
Kovak's explicit call — this repo must NOT live under `maftynehnoa-dot`.
Own site account, own ntfy topic, own dedupe store. Built **2026-10-13**.

| item | value |
|---|---|
| repo | https://github.com/StellaNoxFleurette/pogotracker3 (PUBLIC) |
| workbench clone | `G:\AI\poketracker3` — separate directory, identical layout |
| GitHub auth | the account's own PAT, classic, **no expiration**, scopes `gist, repo, workflow`, note `pogotracker3-ci`. `gh` CLI on this machine is STILL authed as `maftynehnoa-dot` — never re-login it. Drive this repo with `GH_TOKEN=<pat>` env override instead. |
| push auth | remote URL embeds the PAT (`.git/config`, untracked). If push/`ls-remote` returns 401 → PAT revoked/rotated: mint a new one at the account's `settings/tokens` (scopes `repo workflow gist`, no expiration), then `git remote set-url origin https://x-access-token:<pat>@github.com/StellaNoxFleurette/pogotracker3.git` |
| GitHub session | lives in a throwaway Chrome profile (`%LOCALAPPDATA%\Temp\opencode\gh3_profile`, CDP port 9333) — main Chrome never touched. Login itself was done by hand in that window; scripted POSTs to github.com/login are WAF-blocked (422 "browser did something unexpected"), so don't retry script login. |
| site login | 3rd site account; sub/name/ID live in `jwt.txt` + `trainer_id.txt` (gitignored). Not published. |
| site JWT | 3rd site account (`trainer_cap`=1 forces a separate login) → secret `POGO_JWT` |
| ntfy topic | NEW topic, local `G:\AI\poketracker3\ntfy_topic.txt` + secret `NTFY_TOPIC`. Kovak must subscribe to it in the ntfy app. |
| vars | `SPECIES_IDS=any` `SHINY=true` `MIN_IV=100`, pass B (`HUNDO_IDS`) off. **2026-10-14: track list REMOVED** (Kovak's call) — watch is now Shiny + 100% IV on ALL species, not just 4,1,7. `SPECIES_IDS=any` (sentinel, also accepts `all`/blank) → `pokemon_ids:[]` = no species filter server-side (same primitive as `monitor.mjs --any-species`). Was `MIN_IV=0` (any IV) + 7 species `25,4,7,1,58,37,133` before this change. |
| seen.json | **independent** dedupe store, seeded `{}` and **force-added in the root commit** — the allowlist gitignore hides it, and the persist step's `git status --porcelain` never sees ignored files (the exact silent-failure documented in §5a's step comment) |
| cron | `6-59/5 * * * *` (:06,:11,… UTC) — 5-min cadence, phase-offset vs instance 1 (:02) and 2 (:04) |

**State: LIVE** since 2026-10-13. Manual dispatch run `38350559593` green
(8/8 steps), `tier=logged_in` cap 10, shiny pass `[4,1,7]`, seen store
persisted. Same 60-day auto-disable caveat as the other two (§10).

**Token hygiene:** exactly ONE PAT exists for this account
(`pogotracker3-ci`). A cleanup pass during setup deleted an earlier keeper by
mismatching token rows — if `gh`/push ever 401s, mint per the push-auth row
above rather than assuming the JWT is broken.

---

## 6. Local files (workbench, NOT all tracked)

This folder `G:\AI\poketracker` is a git clone of the repo with an **allowlist
`.gitignore`** — only `*.mjs`, `.github/**`, and the four markdown docs track.
Everything else (scraped chunks, HTML, probe JSON, logs, dumps, credentials) is
deliberately ignored.

| file | status | purpose |
|---|---|---|
| `monitor.mjs` | tracked | local persistent loop (now **stopped** — cloud took over) |
| `pogo-harvest.mjs` | tracked | slice-union cap-bypass harvester |
| `reveal.mjs` | tracked | one-off search + reveal + table. **Reads spec from a file** |
| `cloud/cloud-monitor.mjs` | tracked | the cloud single-shot |
| `CAP-BYPASS.md` | tracked | full cap analysis, slice axes, endpoint map |
| `jwt.txt` / `ntfy_topic.txt` / `trainer_id.txt` | **ignored** | secrets/IDs |
| `monitor_seen.json` | ignored | local dedupe state |
| `monitor_log.txt`, `*_log.txt` | ignored | run logs |
| `pogo_live/spawns.{csv,json}` | ignored | harvested dump |
| `*.js`, `*.html`, `q*.json` | ignored | scrape artifacts / query probes |

Local monitor command (stopped, kept for reference):

```powershell
$env:NTFY_TOPIC = (Get-Content -Raw ntfy_topic.txt).Trim()
node monitor.mjs --ids 4,1,7 --interval 180 > monitor_log.txt 2>&1
```

---

## 7. Environment gotchas (this machine)

- **PowerShell strips double quotes from CLI args.** Never pass JSON specs
  inline — write to a file and have the script read it (that is why
  `reveal.mjs` takes a spec path). Use `;` not `&&`.
- **PowerShell splits `gh api` / `--jq` arguments** on `?`, `=`, and spaces.
  Build the URL in a variable, or avoid `--jq` and `ConvertFrom-Json` instead.
- git + gh are installed; `git config --global user.name/email` are unset —
  each clone has **repo-local** identity instead (`maftynehnoa-dot` /
  noreply address).
- Node 20+ available locally.

---

## 8. Sensitivity

The site's ToS forbids automated access. Everything here talks to a
third-party API without permission. **Repo is PUBLIC** — `POGO_JWT` and
`NTFY_TOPIC` are GitHub Secrets (never exposed, masked in logs), and the
allowlist gitignore keeps `jwt.txt` out of history. Keep it that way.

---

## 9. Open threads (not started)

- [x] Two-trainer variant — **instance 2 LIVE 2026-10-11** (repo
      `pogotracker2`, clone `G:\AI\poketracker2`, separate topic). See §5b.
- [x] Third-trainer variant — **instance 3 LIVE 2026-10-13** (separate GitHub
      account `StellaNoxFleurette`, repo `pogotracker3`, clone
      `G:\AI\poketracker3`, separate topic, cron :06 phase). See §5c.
- [ ] Local monitor permanently retired vs kept as fallback — currently stopped.
- [ ] Old folder shell `G:\AI\site hack` still locked by the opencode process;
      deletes after reboot / opencode close. Harmless.

## 10. Immediately on load

1. Confirm cron still `active`:
   `gh api repos/maftynehnoa-dot/pogotracker/actions/workflows`
2. Confirm no failing runs:
   `gh run list --repo maftynehnoa-dot/pogotracker --limit 5`
3. If failing with 401 → JWT expired, refresh `POGO_JWT`.
4. If no runs at all → hit the **60-day auto-disable**; re-enable in Actions.
