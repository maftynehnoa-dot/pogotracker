# HANDOFF — pogotracker

> Dense state dump for a fresh session. Read this first; it is self-contained.
> Last updated **2026-10-11**, live on GitHub Actions.

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
| Variable | `SPECIES_IDS` | `4,1,7` — **pass A**, the shiny watch (Charmander/Bulbasaur/Squirtle) |
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

**Volume warning:** a common species at 100% IV is a *firehose*. Gastly hundos
run ~7 live at any moment with 15–30 min despawns, so expect on the order of
15–25 alerts/hour. Pass B is **currently OFF** — `HUNDO_IDS` was deleted from
Repo Variables on 2026-10-11 after testing finished. Pass A keeps running.
Re-enable with `gh variable set HUNDO_IDS --body "92"`.

- Cron: `*/5 * * * *` — **UTC**, may lag a minute or two under load.
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
| vars | same as instance 1: `SPECIES_IDS=4,1,7` `SHINY=true` `MIN_IV=100`, no `HUNDO_IDS` |
| seen.json | **independent** dedupe store, seeded empty at creation |
| cron | identical `*/5 * * * *` |

**Current state: workflow DISABLED** — the monitor `exit(1)`s without
`POGO_JWT`, and red runs are noise. To bring instance 2 live:

1. Capture the 2nd site account's JWT (same flow as CAP-BYPASS: log in on
   pogocoordinates.com, grab `localStorage["jwt"]` from devtools).
2. `Get-Content jwt2.txt | gh secret set POGO_JWT --repo maftynehnoa-dot/pogotracker2`
3. `gh workflow enable pogo-monitor --repo maftynehnoa-dot/pogotracker2`
4. Subscribe the new topic in the ntfy app (topic is in the p2 clone's
   `ntfy_topic.txt`).

**Sync note:** once both repos run once, their `seen.json` histories diverge
independently — code changes must be pushed to each repo separately. If
merging across, always keep each side's own `seen.json`.

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

- [x] Two-trainer variant — **instance 2 built 2026-10-11** (repo
      `pogotracker2`, clone `G:\AI\poketracker2`). Workflow disabled until the
      2nd site account's JWT is captured — see §5b.
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
