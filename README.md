# pogotracker — shiny 100% IV spawn monitor

Watches the pogocoordinates.com API for shiny + perfect-IV spawns and pushes
them to your phone via [ntfy](https://ntfy.sh). Runs on a GitHub Actions cron,
so it keeps scanning 24/7 whether or not your computer is on.

## how it works

Every 5 minutes a runner checks `POST /search` for your target species with a
shiny + IV filter. The shiny roll is computed **for your linked Pokemon GO
account** — the site's `shiny_only` filter is trainer-gated and returns
`403 trainer_not_linked` without a session whose trainer is linked.

Each new match (deduped by `encounter_id`) triggers **two** pushes:

1. **detail** — species, IVs, CP, level, despawn timer, maps link
2. **coords** — `lat lng` on a single line, ready to long-press copy

## setup

### 1. secrets (hidden — never committed)

`Settings → Secrets and variables → Actions → Secrets → New repository secret`

| name | value |
|---|---|
| `POGO_JWT` | your pogocoordinates session token — grab it from `localStorage['jwt']` while logged into the site |
| `NTFY_TOPIC` | your ntfy.sh topic name |

### 2. variables (editable in the web form — no code changes needed)

`Settings → Secrets and variables → Actions → Variables → New repository variable`

| name | default | notes |
|---|---|---|
| `SPECIES_IDS` | `4,1,7` | comma-separated dex ids. 4=Charmander, 1=Bulbasaur, 7=Squirtle |
| `MIN_IV` | `100` | lower to `98` for far more hits |
| `SHINY` | `true` | set `false` to drop the shiny requirement |

change these any time and the next cron tick picks them up. no rebuild, no code.

### 3. run it

`Actions → pogo-monitor → Run workflow`. check the run log, then your phone.

## editing without git

you never have to touch the workflow file. species, IV floor, and shiny toggle
are all **Variables**, which live in a plain web form. only the JWT and topic
are **Secrets**, and those never need changing unless the session expires.

## gotchas

- **scheduled workflows disable after 60 days** with no repo activity. commit
  anything periodically, or re-enable it from the Actions tab (GitHub emails
  you first).
- **cron is UTC** and GitHub may run it a minute or two late under load.
- **JWT expiry** — when your pogocoordinates session expires, runs will start
  failing with `401` / `Invalid token`. refresh `POGO_JWT` in Secrets.
- **rate limits** — each run gets a fresh IP from GitHub's runner pool, which
  makes long penalty boxes far less likely than polling from a home IP. the
  script still honors the server's `retry_after` if one hits.

## files

```
.github/workflows/pogo-monitor.yml   cron schedule + run steps
cloud/cloud-monitor.mjs              the single-shot monitor
seen.json                            dedupe store, committed by the workflow
```

`seen.json` is written back by each run so the same spawn never alerts twice.
Entries older than 4 hours are pruned automatically.
