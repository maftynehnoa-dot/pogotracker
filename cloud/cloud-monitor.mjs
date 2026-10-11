#!/usr/bin/env node
// cloud-monitor.mjs — single-shot spawn watcher for GitHub Actions
//
// DIFFERENCE FROM monitor.mjs
//   monitor.mjs runs forever in a loop on your PC. This one runs ONCE per
//   invocation and exits, because GitHub Actions gives you a fresh container
//   each time on a cron schedule. The schedule IS the loop.
//
// DEDUPE WITHOUT A DATABASE
//   Seen encounter_ids are persisted to seen.json, which the workflow commits
//   back to the repo after each run. Entries older than PRUNE_MS are dropped
//   so the file never grows unbounded.
//
// CONFIG — all via environment (set these as GitHub Actions Secrets/vars)
//   POGO_JWT      required. your site session. trainer must be linked or the
//                 shiny filter returns 403 trainer_not_linked.
//   NTFY_TOPIC    required. ntfy.sh topic for push notifications.
//   SPECIES_IDS   comma-separated dex ids. default: 4,1,7
//   MIN_IV        default 100
//   SHINY         "true" (default) or "false"
//   SEEN_FILE     default "seen.json"
//   PRUNE_MS      drop seen entries older than this. default 4h in ms.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://coordinates-api.pokemongopro.com";

const JWT = process.env.POGO_JWT;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const SPECIES_IDS = (process.env.SPECIES_IDS || "4,1,7")
  .split(",").map(Number).filter(Boolean);
const MIN_IV = Number(process.env.MIN_IV || 100);
const WANT_SHINY = (process.env.SHINY || "true").toLowerCase() !== "false";
const SEEN_FILE = process.env.SEEN_FILE || "seen.json";
const PRUNE_MS = Number(process.env.PRUNE_MS || 4 * 60 * 60 * 1000);

if (!JWT || !NTFY_TOPIC) {
  console.error("[!] missing POGO_JWT or NTFY_TOPIC. set them as repo secrets.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ------------------------------------------------------------------ spec
function buildSpec() {
  return {
    pokemon_ids: SPECIES_IDS,
    iv_mode: "percent",
    iv_percent_min: MIN_IV,
    shiny_only: WANT_SHINY,
    sort: "DSP",
    // nulls mirror the site's own defaults (chunk 3133 module 6603 `r`)
    location: null, gender: null, sizes: [], forms: [],
    cp_min: null, cp_max: null, level_min: null, level_max: null,
    iv_percent_max: null, raw_iv_atk: null, raw_iv_def: null, raw_iv_sta: null,
    boosted: null, weather_id: null, min_ttl: null,
    center_lat: null, center_lng: null, radius_km: null,
    shiny_account: null, background_only: false, pvp_mode: false,
    pvp_league: "great", pvp_top_rank: null, pvp_include_pre_evolutions: true,
    pvp_min_cp: null, species_forms: [],
    blacklist_pokemon_ids: [], blacklist_species_forms: [], blacklist_forms: [],
  };
}

// ------------------------------------------------------------------ api
// Each Actions run gets a fresh IP from GitHub's pool, so the long penalty
// boxes you hit locally are far less likely here. Still honor retry_after.
async function withRetry(fn, tag) {
  for (let i = 0; i < 4; i++) {
    try {
      const out = await fn();
      if (out && out.__retry) {
        log(`    ${tag}: 429, waiting ${out.__retry}s`);
        await sleep(out.__retry * 1000);
        continue;
      }
      return out;
    } catch (e) {
      log(`    ${tag} error: ${e.message}`);
      await sleep(8000);
    }
  }
  return null;
}

const search = () => withRetry(async () => {
  const res = await fetch(`${API}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify(buildSpec()),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429) {
    const d = await res.json().catch(() => ({}));
    return { __retry: d?.detail?.retry_after ?? 30 };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    log(`    search HTTP ${res.status}: ${t.slice(0, 200)}`);
    return null;
  }
  return res.json();
}, "search");

const reveal = (code) => withRetry(async () => {
  const res = await fetch(`${API}/reveal/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${JWT}` },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429) {
    const d = await res.json().catch(() => ({}));
    return { __retry: d?.detail?.retry_after ?? 30 };
  }
  if (!res.ok) return null;
  return res.json();
}, "reveal");

// ------------------------------------------------------------------ notify
// Two pushes per hit. Headers MUST be plain ASCII — an em-dash (U+2014) in a
// header throws "Cannot convert argument to a ByteString". Keep titles clean.
async function notify(hit) {
  const text = [
    `SHINY ${WANT_SHINY ? "+" : ""}${MIN_IV}% IV`,
    `${hit.pokemon_name}${hit.form ? ` (${hit.form})` : ""}  iv=${hit.raw_iv}`,
    `cp=${hit.cp}  lvl=${hit.level}${hit.size ? "  size=" + hit.size : ""}`,
    hit.coords ? `https://www.google.com/maps?q=${hit.lat},${hit.lng}` : hit.location,
    `despawns ~${hit.minsLeft} min`,
  ].join("\n");

  const push = async (title, body, tags) => {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: tags },
      body,
      signal: AbortSignal.timeout(25000),
    });
    return res.ok;
  };

  const ok1 = await push(`Pokemon GO: ${hit.pokemon_name} ${MIN_IV}% IV`, text, "sparkles,boom");
  log(`    -> push 1 (full): ${ok1 ? "ok" : "FAILED"}`);

  if (hit.lat != null && hit.lng != null) {
    await sleep(1500); // avoid ntfy-side throttling on the pair
    const ok2 = await push(
      `${hit.pokemon_name} - coords`,
      `${hit.lat} ${hit.lng}`,
      "round_pushpin",
    );
    log(`    -> push 2 (coords): ${ok2 ? "ok" : "FAILED"}`);
  }
}

// ------------------------------------------------------------------ main
function loadSeen() {
  if (!existsSync(SEEN_FILE)) return {};
  try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); } catch { return {}; }
}

function pruneSeen(seen) {
  const cutoff = Date.now() - PRUNE_MS;
  let kept = 0;
  for (const [id, ts] of Object.entries(seen)) {
    if (ts >= cutoff) kept++;
    else delete seen[id];
  }
  return kept;
}

async function main() {
  log("====================================================");
  log("  PoGo cloud monitor (GitHub Actions)");
  log(`  species  : ${SPECIES_IDS.join(",")}`);
  log(`  filter   : ${WANT_SHINY ? "shiny " : ""}${MIN_IV}%+ IV`);
  log(`  region   : ${process.env.GITHUB_ACTIONS ? "github runner" : "local"}`);
  log("====================================================");

  const seen = loadSeen();
  const before = pruneSeen(seen);
  log(`[+] seen store: ${before} live entries (pruned to last ${PRUNE_MS / 3600000}h)`);

  const res = await search();
  if (!res || !Array.isArray(res.results)) {
    log("[!] no results payload — bailing. seen store left unchanged.");
    return;
  }

  const rows = res.results;
  const fresh = rows.filter((r) => r.encounter_id && seen[r.encounter_id] === undefined);
  log(`[+] ${rows.length} row(s), ${fresh.length} new  (cap=${res.cap}, tier=${res.tier})`);

  let alerts = 0;
  for (const r of fresh) {
    seen[r.encounter_id] = Date.now();

    const when = r.despawn_at ? Date.parse(r.despawn_at) : NaN;
    const minsLeft = Number.isFinite(when) ? Math.round((when - Date.now()) / 60000) : null;
    if (minsLeft !== null && minsLeft <= 0) {
      log(`    skip #${r.pokemon_id} ${r.pokemon_name} — already despawned`);
      continue;
    }

    log(`    HIT #${r.pokemon_id} ${r.pokemon_name} iv=${r.raw_iv} cp=${r.cp} lvl=${r.level} ~${minsLeft}m`);

    const c = await reveal(r.reveal_code);
    if (c) log(`      ${c.coords}`);
    else log(`      coords unavailable (reveal failed/expired)`);

    await notify({
      ...r,
      coords: c?.coords || null,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
      minsLeft: minsLeft ?? "?",
    });
    alerts++;

    // Small gap between multi-hit runs so ntfy doesn't throttle the burst.
    await sleep(1500);
  }

  writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 0));
  log(`[+] seen store written (${Object.keys(seen).length} entries)`);
  log(`[+] alerts sent: ${alerts}`);

  // Exit non-zero if the API itself failed, so the Actions run shows red and
  // you notice. Zero alerts is a perfectly normal outcome, not an error.
  if (!res) process.exit(1);
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
