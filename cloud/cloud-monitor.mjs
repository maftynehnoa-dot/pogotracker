#!/usr/bin/env node
// cloud-monitor.mjs — single-shot spawn watcher for GitHub Actions
//
// DIFFERENCE FROM monitor.mjs
//   monitor.mjs runs forever in a loop on your PC. This one runs ONCE per
//   invocation and exits, because GitHub Actions gives you a fresh container
//   each time on a cron schedule. The schedule IS the loop.
//
// TWO WATCH PASSES
//   Pass A  SPECIES_IDS + SHINY   the original shiny watch
//   Pass B  HUNDO_IDS             a SECOND filter that ignores shiny entirely
//                                 and just watches for perfect IV
//   Pass B exists because shiny + hundo together is genuinely rare. If you want
//   a filter that actually fires while you test the notification path, point
//   HUNDO_IDS at a common species. Both passes share MIN_IV.
//
// DEDUPE WITHOUT A DATABASE
//   Seen encounter_ids are persisted to seen.json, which the workflow commits
//   back to the repo after each run. Entries older than PRUNE_MS are dropped
//   so the file never grows unbounded. Dedupe is GLOBAL across passes, so a
//   spawn matching both filters alerts exactly once.
//
// CONFIG — all via environment (set these as GitHub Actions Secrets/vars)
//   POGO_JWT      required. your site session. trainer must be linked or the
//                 shiny filter returns 403 trainer_not_linked.
//   NTFY_TOPIC    required. ntfy.sh topic for push notifications.
//   SPECIES_IDS   pass A dex ids. default: 4,1,7
//   SHINY         pass A shiny toggle. "true" (default) or "false"
//   HUNDO_IDS     pass B dex ids, watched for plain 100% IV. default: "" (off)
//   MIN_IV        shared IV floor. default 100
//   SEEN_FILE     default "seen.json"
//   PRUNE_MS      drop seen entries older than this. default 4h in ms.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://coordinates-api.pokemongopro.com";

const JWT = process.env.POGO_JWT;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const SHINY_IDS = (process.env.SPECIES_IDS || "4,1,7")
  .split(",").map(Number).filter(Boolean);
const HUNDO_IDS = (process.env.HUNDO_IDS || "")
  .split(",").map(Number).filter(Boolean);
const MIN_IV = Number(process.env.MIN_IV || 100);
const WANT_SHINY = (process.env.SHINY || "true").toLowerCase() !== "false";
const SEEN_FILE = process.env.SEEN_FILE || "seen.json";
const PRUNE_MS = Number(process.env.PRUNE_MS || 4 * 60 * 60 * 1000);

if (!JWT || !NTFY_TOPIC) {
  console.error("[!] missing POGO_JWT or NTFY_TOPIC. set them as repo secrets.");
  process.exit(1);
}

// Each pass is one API call. Backwards compatible: with HUNDO_IDS empty this
// is exactly the old single-pass behaviour.
const PASSES = [];
if (SHINY_IDS.length) {
  PASSES.push({ tag: WANT_SHINY ? "shiny" : "hundo", ids: SHINY_IDS, shiny: WANT_SHINY });
}
if (HUNDO_IDS.length) {
  PASSES.push({ tag: "hundo+", ids: HUNDO_IDS, shiny: false });
}
if (!PASSES.length) {
  console.error("[!] no watch passes configured — set SPECIES_IDS and/or HUNDO_IDS.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ------------------------------------------------------------------ spec
function buildSpec(ids, wantShiny) {
  return {
    pokemon_ids: ids,
    iv_mode: "percent",
    iv_percent_min: MIN_IV,
    shiny_only: wantShiny,
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

const search = (spec, tag) => withRetry(async () => {
  const res = await fetch(`${API}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429) {
    const d = await res.json().catch(() => ({}));
    return { __retry: d?.detail?.retry_after ?? 30 };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    log(`    search[${tag}] HTTP ${res.status}: ${t.slice(0, 200)}`);
    return null;
  }
  return res.json();
}, `search[${tag}]`);

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
//
// The label is derived from the ROW's own shiny flag, not from config. A shiny
// hit says "SHINY +100% IV"; a plain hundo says "100% IV". Getting this from
// the data means one code path covers both passes correctly.
async function notify(hit) {
  const label = hit.shiny ? `SHINY +${MIN_IV}% IV` : `${MIN_IV}% IV`;

  const body = [
    label,
    `${hit.pokemon_name}${hit.form ? ` (${hit.form})` : ""}  iv=${hit.raw_iv}`,
    `cp=${hit.cp}  lvl=${hit.level}${hit.size ? "  size=" + hit.size : ""}`,
    hit.coords ? `https://www.google.com/maps?q=${hit.lat},${hit.lng}` : hit.location,
    `despawns ~${hit.minsLeft} min`,
  ].join("\n");

  const push = async (title, text, tags) => {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: tags },
      body: text,
      signal: AbortSignal.timeout(25000),
    });
    return res.ok;
  };

  const ok1 = await push(
    `Pokemon GO: ${hit.pokemon_name} ${label}`,
    body,
    hit.shiny ? "sparkles,boom" : "star,boom",
  );
  log(`    -> push 1 (${label}): ${ok1 ? "ok" : "FAILED"}`);

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
  for (const p of PASSES) {
    log(`  pass ${p.tag.padEnd(7)}: [${p.ids.join(",")}] ${p.shiny ? "shiny " : ""}${MIN_IV}%+ IV`);
  }
  log(`  region   : ${process.env.GITHUB_ACTIONS ? "github runner" : "local"}`);
  log("====================================================");

  const seen = loadSeen();
  const before = pruneSeen(seen);
  log(`[+] seen store: ${before} live entries (pruned to last ${PRUNE_MS / 3600000}h)`);

  let alerts = 0;

  for (const pass of PASSES) {
    const res = await search(buildSpec(pass.ids, pass.shiny), pass.tag);
    if (!res || !Array.isArray(res.results)) {
      // One failing pass should not abort the whole run — the other pass may
      // still have live spawns worth reporting.
      log(`[!] pass ${pass.tag}: no results payload — skipping`);
      continue;
    }

    // Dedupe globally on encounter_id. A spawn that satisfies two passes is
    // collected once by whichever pass saw it first.
    const fresh = res.results.filter(
      (r) => r.encounter_id && seen[r.encounter_id] === undefined,
    );
    log(`[+] pass ${pass.tag}: ${res.results.length} row(s), ${fresh.length} new  (cap=${res.cap}, tier=${res.tier})`);

    for (const r of fresh) {
      seen[r.encounter_id] = Date.now();

      const when = r.despawn_at ? Date.parse(r.despawn_at) : NaN;
      const minsLeft = Number.isFinite(when) ? Math.round((when - Date.now()) / 60000) : null;
      if (minsLeft !== null && minsLeft <= 0) {
        log(`    skip #${r.pokemon_id} ${r.pokemon_name} — already despawned`);
        continue;
      }

      log(`    HIT #${r.pokemon_id} ${r.pokemon_name} iv=${r.raw_iv} shiny=${r.shiny} cp=${r.cp} lvl=${r.level} ~${minsLeft}m`);

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

    // Gap between passes: the rate limiter is ~1 req/6s on a rolling window.
    if (PASSES.indexOf(pass) < PASSES.length - 1) await sleep(6000);
  }

  writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 0));
  log(`[+] seen store written (${Object.keys(seen).length} entries)`);
  log(`[+] alerts sent: ${alerts}`);
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
