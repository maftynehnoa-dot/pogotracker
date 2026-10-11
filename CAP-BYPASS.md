# pogocoordinates.com — 10-spawn cap bypass

## TL;DR

The cap is **server-side**, not client-side. `limit`, `offset`, `page`, `cursor`
in the request body are **all ignored** — `limit:500` still returns `cap` rows.
So you cannot raise it by patching the JS.

But the cap is **per-query, not per-account**. Every query returns the top-N
rows of *whatever filter you give it*, and the filters ARE honored server-side.
So you union the top-N of many different slices, dedupe by `encounter_id`,
and the total is unbounded. That's what `pogo-harvest.mjs` does.

## The endpoint

```
POST https://coordinates-api.pokemongopro.com/search
Content-Type: application/json
Authorization: Bearer <jwt>          # optional, from localStorage["jwt"]
```

Base URL lives in webpack module `2437`. The fetch helper is module `960`.
The spec builder is module `6603` in chunk `3133`.

Response shape:

```json
{ "results": [...], "cap": 5, "tier": "non_logged_in", "total_matches": 0 }
```

### Caps by tier (measured)

| tier          | cap |
|---------------|-----|
| non_logged_in | 5   |
| logged_in     | 10  |
| VIP           | higher (advertised) |

`total_matches` always came back `0` in anon testing — the server does not
tell you the true match count.

### Rate limit

Rolling window, roughly **1 request / 4s sustained**. Exceed it and you get:

```json
{ "detail": { "error": "rate_limited", "retry_after": 2501 } }
```

`retry_after` is **seconds**. Hammering it during a penalty makes it worse —
I burned a ~42min box probing. The tool now honors `retry_after` verbatim and
stops instead of retrying into the wall.

## Verified facts

- `limit` / `offset` / `page` / `cursor` / `skip` in body → **ignored**
- tier headers (`X-Tier: vip`, `X-Plan: vip`, etc.) → **ignored**, server uses the JWT
- filters **are** honored: `iv_percent_min:90, max:100` returned only 91–97% rows
- `sort` partitions the space: DSP / CP / IV / LEVEL each returned disjoint sets
- `GET /reveal/{reveal_code}` → `{"coords":"48.944821,8.487838","lat":...,"lng":...}`
  and it works **without auth** (own rate limit)

## The bypass — slice axes

Each slice returns its own `cap` rows. Union them:

| axis        | values used                                                        |
|-------------|--------------------------------------------------------------------|
| sort        | DSP, CP, IV, LEVEL                                                  |
| IV %        | 0-24, 25-49, 50-74, 75-84, 85-93, 94-99, 100                        |
| raw IV      | atk/def/sta buckets (13-15, 10-12, 0-9)                             |
| CP          | 0-300, 301-800, 801-1500, 1501-2500, 2501-4000, 4001-9999           |
| level       | 1-10, 11-20, 21-30, 31-35, 36-50                                    |
| size        | XXS XS S M L XL XXL                                                  |
| gender      | Male, Female, Genderless                                            |
| min_ttl     | 5, 10, 15, 30, 60, 120                                              |
| flags       | shiny_only, boosted, weather 1-7                                    |
| geo         | 20 dense hubs (Central Park, Shibuya, Hyde Park, ...) lat/lng+radius |
| species     | optional, `--species 25,150,133` chunked by 25                      |

Full sweep = **76 slices**. At 4s pacing that's ~5-7 min.

## Usage

```bash
# connectivity check — ONE request, reports cap/tier/latency
node pogo-harvest.mjs --probe

# small run
node pogo-harvest.mjs --top 60 --max-slices 15 --out pogo_test

# full sweep, anonymous (cap 5 per query)
node pogo-harvest.mjs --out pogo_out

# logged-in (cap 10 per query) — grab jwt from localStorage["jwt"]
node pogo-harvest.mjs --jwt "eyJ..." --out pogo_out

# targeted species only (cheap)
node pogo-harvest.mjs --species 25,150,133 --out pogo_out

# also resolve coordinates (slower, extra request per row)
node pogo-harvest.mjs --jwt "eyJ..." --reveal --out pogo_out
```

## Output

```
pogo_out/spawns.csv
pogo_out/spawns.json
```

Columns: `pokemon_id, pokemon_name, form, cp, level, iv_percent, raw_iv, size,
gender, weather_boosted, shiny, fast_move, charge_move, despawn_at, distance_km,
location, lat, lng, encounter_id, reveal_code`

Sorted soonest-despawn first. Summary prints unique count, shiny count,
100% IV count, and top species.

## OPSEC / practical notes

- Don't drop `--delay` below 4000. The penalty box scales hard.
- A logged-in JWT both raises the per-query cap AND gives you `distance_km`
  (needs `center_lat`/`center_lng` from the geo slices).
- `reveal_code` expires — rows despawn. Reveal promptly or accept `location`
  (city-level) only.
- The site's own UI does exactly one query per search. Running 76 is a
  different traffic shape. Use a JWT you don't mind losing, and space it out.
- `--species-all` walks the whole dex (1025 ids ≈ 41 extra batches). Off by
  default for that reason.

## Files

- `pogo-harvest.mjs` — the tool
- `search_page.js`, `3133-*.js`, `6129-*.js`, ... — the decompiled chunks
