#!/usr/bin/env node
// pogo-harvest.mjs â€” pogocoordinates.com spawn harvester (cap bypass)
//
// WHAT THIS SOLVES
//   The site's UI shows you `cap` results (5 logged out, 10 logged in, more for VIP).
//   That cap is enforced SERVER-SIDE in POST /search on coordinates-api.pokemongopro.com.
//   It is NOT a client-side slice â€” I verified limit=500 still returns `cap` rows,
//   and the body `limit` / `offset` / `page` / `cursor` fields are ignored entirely.
//
//   HOWEVER: the cap is PER-QUERY, not per-account or per-session. The API honors the
//   filter fields (verified: iv_percent_min=90&max=100 returned only 91-97% rows).
//   So we union the top-N of many DIFFERENT slices and dedupe by encounter_id.
//   Each slice legitimately returns its own `cap` rows; the union is unbounded.
//
// SLICE AXES USED
//   sort(DSP/CP/IV/LEVEL) Â· IV% buckets Â· CP buckets Â· level buckets Â· size Â· gender
//   Â· min_ttl Â· geo grid (lat/lng + radius) Â· species batches
//   These partition the result space, so overlap between slices is small and the
//   deduped union grows roughly linearly with requests.
//
// ASSUMPTIONS
//   - Node 18+ (global fetch). Verified on v26.
//   - Public API, no auth needed for cap=5. Drop your JWT in --jwt to get cap=10
//     (grab it from localStorage['jwt'] while logged into the site) or VIP cap.
//   - Rate limit is a rolling window, ~1 req / 4s sustained. We adapt on 429 and
//     honor the server's retry_after. Do NOT tighten this or you'll get temp-banned.
//   - Coords are behind GET /reveal/{reveal_code}; reveal has its own tighter limit.
//     Off by default. Enable with --reveal.
//
// USAGE
//   node pogo-harvest.mjs                        # sweep everything, dedupe, save
//   node pogo-harvest.mjs --species 25,150,133   # sweep only those pokemon_ids
//   node pogo-harvest.mjs --jwt "eyJ..." --reveal
//   node pogo-harvest.mjs --out my_feed --top 200
//
// NOTE (Kovak, not a warning â€” an economics note): the full sweep is ~90 requests.
// At the enforced pacing that's ~6 min. --species mode is far cheaper when you know
// what you want.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = "https://coordinates-api.pokemongopro.com";

// ---------------------------------------------------------------- cli args
const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(name);

const JWT = getFlag("--jwt") || process.env.POGO_JWT || null;
const OUT = getFlag("--out") || "pogo_out";
const TOP = Number(getFlag("--top") || 1000);
const DO_REVEAL = has("--reveal");
const SPECIES = (getFlag("--species") || "").split(",").map(Number).filter(Boolean);
const LATENCY = Number(getFlag("--delay") || 4000); // ms between requests, floor
const MAX_SLICES = Number(getFlag("--max-slices") || Infinity);
const PROBE = has("--probe"); // single connectivity test, no sweep
const SHINY = has("--shiny"); // shiny_for_you mode (requires linked trainer)

// ---------------------------------------------------------------- defaults
// Mirrors the site's own spec defaults (chunk 3133 module 6603 `r`).
const baseSpec = () => ({
  shiny_only: SHINY, // only meaningful with a linked trainer (your JWT)
  shiny_account: null,
  background_only: false,
  pvp_mode: false,
  pvp_league: "great",
  pvp_top_rank: null,
  pvp_include_pre_evolutions: true,
  pvp_min_cp: null,
  pokemon_ids: [],
  species_forms: [],
  location: null,
  cp_min: null,
  cp_max: null,
  level_min: null,
  level_max: null,
  iv_mode: "percent",
  iv_percent_min: null,
  iv_percent_max: null,
  raw_iv_atk: null,
  raw_iv_def: null,
  raw_iv_sta: null,
  sizes: [],
  forms: [],
  gender: null,
  boosted: null,
  weather_id: null,
  min_ttl: null,
  sort: "DSP",
  center_lat: null,
  center_lng: null,
  radius_km: null,
  blacklist_pokemon_ids: [],
  blacklist_species_forms: [],
  blacklist_forms: [],
});

// ---------------------------------------------------------------- rate limit
// Rolling-window limiter. Starts at LATENCY, backs off on 429 using the server's
// own retry_after, and relaxes back down after a run of clean responses.
class Pacer {
  constructor(minGap) {
    this.minGap = minGap;
    this.last = 0;
    this.backoff = 0;
  }
  async wait() {
    const now = Date.now();
    const due = this.last + this.minGap + this.backoff;
    if (due > now) await new Promise((r) => setTimeout(r, due - now));
    this.last = Date.now();
  }
  // Back off by AT LEAST what the server asked for. Never clamp below the
  // server's retry_after â€” that was the bug that spun us into a harder ban.
  penalize(ms) {
    this.backoff = Math.max(this.backoff * 1.6, ms, this.backoff);
  }
  // Once we're in a long penalty box, stop burning requests against it.
  inCooldown() {
    return this.backoff > 120000;
  }
  reward() {
    this.backoff *= 0.5;
    if (this.backoff < 1000) this.backoff = 0;
  }
}

const pacer = new Pacer(LATENCY);

// ---------------------------------------------------------------- api call
async function postSearch(spec) {
  const headers = { "Content-Type": "application/json" };
  if (JWT) headers.Authorization = `Bearer ${JWT}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    // If the server put us in a long penalty box, don't burn retries against it.
    if (pacer.inCooldown()) {
      return { error: `cooldown_${Math.round(pacer.backoff / 1000)}s` };
    }
    await pacer.wait();
    let res;
    try {
      res = await fetch(`${API}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(spec),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      // network blip / timeout â€” back off and retry
      pacer.penalize(5000);
      continue;
    }

    if (res.status === 429) {
      // server tells us exactly how long to hold off
      let retry = 10;
      try {
        const d = await res.json();
        retry = d?.detail?.retry_after ?? 10;
      } catch {}
      pacer.penalize(retry * 1000);
      continue;
    }

    if (res.status >= 500) {
      pacer.penalize(10000);
      continue;
    }

    if (!res.ok) {
      // 4xx other than 429 = bad spec, not retryable
      return { error: res.status, body: await res.text().catch(() => "") };
    }

    pacer.reward();
    return await res.json();
  }
  return { error: "exhausted" };
}

async function revealCoords(code) {
  const headers = {};
  if (JWT) headers.Authorization = `Bearer ${JWT}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    await pacer.wait();
    let res;
    try {
      res = await fetch(`${API}/reveal/${encodeURIComponent(code)}`, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      pacer.penalize(5000);
      continue;
    }
    if (res.status === 429) {
      let retry = 15;
      try {
        const d = await res.json();
        retry = d?.detail?.retry_after ?? 15;
      } catch {}
      pacer.penalize(retry * 1000);
      continue;
    }
    if (res.status === 404 || res.status === 410) return null; // expired
    if (!res.ok) return null;
    pacer.reward();
    try {
      return await res.json(); // { coords, lat, lng }
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- slice plan
// Each entry is one full query. Union + dedupe beats the per-query cap.
function buildSlices() {
  const slices = [];
  const push = (label, patch) => slices.push({ label, patch });

  // ---- SHINY MODE ---------------------------------------------------------
  // Shiny spawns are rare, so the generic IV/CP/level buckets mostly return
  // the same few rows. Partition on the axes that actually vary instead:
  // geography (where the scanner bots are), species, size, gender, and sort.
  if (SHINY) {
    // sort axis: 4 different orderings over the shiny set
    for (const sort of ["DSP", "CP", "IV", "LEVEL"]) push(`sort:${sort}`, { sort });

    // geo axis â€” the big one. Each hub surfaces its own local shinies.
    const HUBS = [
      ["central_park_nyc", 40.7829, -73.9654, 4],
      ["manhattan", 40.7580, -73.9855, 6],
      ["times_sq", 40.7580, -73.9855, 3],
      ["brooklyn_bridge", 40.7061, -73.9969, 4],
      ["santa_monica", 34.0195, -118.4912, 6],
      ["disney_la", 33.8121, -117.9190, 4],
      ["san_francisco", 37.7749, -122.4194, 6],
      ["chicago", 41.8781, -87.6298, 6],
      ["toronto", 43.6532, -79.3832, 6],
      ["london_hyde", 51.5073, -0.1657, 6],
      ["london_eye", 51.5033, -0.1196, 3],
      ["paris_centre", 48.8566, 2.3522, 5],
      ["amsterdam", 52.3676, 4.9041, 4],
      ["berlin", 52.5200, 13.4050, 6],
      ["madrid", 40.4168, -3.7038, 6],
      ["rome", 41.9028, 12.4964, 6],
      ["sydney_cbd", -33.8688, 151.2093, 6],
      ["melbourne", -37.8136, 144.9631, 6],
      ["brisbane", -27.4698, 153.0251, 6],
      ["auckland", -36.8485, 174.7633, 6],
      ["tokyo_shibuya", 35.6595, 139.7005, 6],
      ["tokyo_disney", 35.6329, 139.8804, 4],
      ["osaka", 34.6937, 135.5023, 6],
      ["seoul", 37.5665, 126.9780, 6],
      ["singapore", 1.3521, 103.8198, 6],
      ["hong_kong", 22.3193, 114.1694, 6],
      ["taipei", 25.0330, 121.5654, 6],
      ["bangkok", 13.7563, 100.5018, 6],
      ["dubai", 25.2048, 55.2708, 6],
      ["saopaulo", -23.5505, -46.6333, 6],
      ["buenos_aires", -34.6037, -58.3816, 6],
      ["mexico_city", 19.4326, -99.1332, 6],
    ];
    for (const [name, lat, lng, rad] of HUBS) {
      push(`geo:${name}`, { center_lat: lat, center_lng: lng, radius_km: rad, sort: "DSP" });
    }

    // size axis â€” costume/rare-size shinies are the prized ones
    for (const size of ["XXS", "XS", "S", "M", "L", "XL", "XXL"]) {
      push(`size:${size}`, { sizes: [size] });
    }

    // gender + ttl
    for (const gender of ["Male", "Female"]) push(`gender:${gender}`, { gender });
    for (const ttl of [10, 20, 30, 60]) push(`min_ttl:${ttl}m`, { min_ttl: ttl });

    // species axis: explicit list, or chunked across the dex with --species-all
    const batches = [];
    if (SPECIES.length) {
      for (let i = 0; i < SPECIES.length; i += 25) batches.push(SPECIES.slice(i, i + 25));
    } else if (has("--species-all")) {
      for (let i = 1; i <= 1025; i += 25) {
        batches.push(Array.from({ length: Math.min(25, 1026 - i) }, (_, k) => i + k));
      }
    }
    for (const b of batches) push(`species[${b[0]}..${b[b.length - 1]}]`, { pokemon_ids: b });

    return slices;
  }

  // ---- DEFAULT (non-shiny) MODE ------------------------------------------

  // --- species axis (explicit list, or chunked across the dex) -------------
  const speciesBatches = [];
  if (SPECIES.length) {
    for (let i = 0; i < SPECIES.length; i += 25) {
      speciesBatches.push(SPECIES.slice(i, i + 25));
    }
  } else {
    // No species given: skip the full-dex sweep by default (1025 ids in ~41
    // batches is a lot of requests). Only do it with --species-all.
    if (has("--species-all")) {
      for (let i = 1; i <= 1025; i += 25) {
        speciesBatches.push(
          Array.from({ length: Math.min(25, 1026 - i) }, (_, k) => i + k),
        );
      }
    }
  }
  for (const batch of speciesBatches) {
    push(`species[${batch[0]}..${batch[batch.length - 1]}]`, {
      pokemon_ids: batch,
    });
  }

  // --- sort axis: 4 disjoint top-N views ----------------------------------
  for (const sort of ["DSP", "CP", "IV", "LEVEL"]) {
    push(`sort:${sort}`, { sort });
  }

  // --- IV% axis: bucketed ranges (verified honored server-side) -----------
  const ivBuckets = [
    [0, 24], [25, 49], [50, 74], [75, 84], [85, 93], [94, 99], [100, 100],
  ];
  for (const [lo, hi] of ivBuckets) {
    push(`iv:${lo}-${hi}`, { iv_mode: "percent", iv_percent_min: lo, iv_percent_max: hi });
  }
  // raw-IV axis for the min/max hunters (atk/def/sta = 0..15)
  for (const stat of ["raw_iv_atk", "raw_iv_def", "raw_iv_sta"]) {
    for (const [lo, hi] of [[13, 15], [10, 12], [0, 9]]) {
      push(`${stat}:${lo}-${hi}`, { [stat]: lo, iv_mode: "raw" });
      void hi; // hi is advisory; server filters on the >= floor for raw stats
    }
  }

  // --- CP axis -------------------------------------------------------------
  const cpBuckets = [[0, 300], [301, 800], [801, 1500], [1501, 2500], [2501, 4000], [4001, 9999]];
  for (const [lo, hi] of cpBuckets) {
    push(`cp:${lo}-${hi}`, { cp_min: lo, cp_max: hi });
  }

  // --- level axis ----------------------------------------------------------
  const lvBuckets = [[1, 10], [11, 20], [21, 30], [31, 35], [36, 50]];
  for (const [lo, hi] of lvBuckets) {
    push(`lvl:${lo}-${hi}`, { level_min: lo, level_max: hi });
  }

  // --- size axis -----------------------------------------------------------
  for (const size of ["XXS", "XS", "S", "M", "L", "XL", "XXL"]) {
    push(`size:${size}`, { sizes: [size] });
  }

  // --- gender axis ---------------------------------------------------------
  for (const gender of ["Male", "Female", "Genderless"]) {
    push(`gender:${gender}`, { gender });
  }

  // --- TTL axis: only spawns with life left -------------------------------
  for (const ttl of [5, 10, 15, 30, 60, 120]) {
    push(`min_ttl:${ttl}m`, { min_ttl: ttl });
  }

  // --- shiny / boosted / weather ------------------------------------------
  push("shiny_only", { shiny_only: true });
  push("boosted", { boosted: true });
  for (const w of [1, 2, 3, 4, 5, 6, 7]) push(`weather:${w}`, { weather_id: w });

  // --- geo axis: radius windows around dense scan hubs --------------------
  // These partition the globe; each hub returns its own cap of local spawns.
  const HUBS = [
    ["central_park_nyc", 40.7829, -73.9654, 3],
    ["manhattan", 40.7580, -73.9855, 4],
    ["times_sq", 40.7580, -73.9855, 2],
    ["santa_monica", 34.0195, -118.4912, 4],
    ["disney_la", 33.8121, -117.9190, 3],
    ["london_hyde", 51.5073, -0.1657, 5],
    ["paris_centre", 48.8566, 2.3522, 4],
    ["sydney_cbd", -33.8688, 151.2093, 5],
    ["tokyo_shibuya", 35.6595, 139.7005, 5],
    ["tokyo_disney", 35.6329, 139.8804, 3],
    ["singapore", 1.3521, 103.8198, 5],
    ["hong_kong", 22.3193, 114.1694, 5],
    ["seoul", 37.5665, 126.9780, 5],
    ["toronto", 43.6532, -79.3832, 5],
    ["chicago", 41.8781, -87.6298, 5],
    ["san_francisco", 37.7749, -122.4194, 5],
    ["rio", -22.9068, -43.1729, 6],
    ["london_eye", 51.5033, -0.1196, 2],
    ["dubai", 25.2048, 55.2708, 6],
    ["amsterdam", 52.3676, 4.9041, 3],
  ];
  for (const [name, lat, lng, rad] of HUBS) {
    push(`geo:${name}`, { center_lat: lat, center_lng: lng, radius_km: rad, sort: "DSP" });
  }

  return slices;
}

// ---------------------------------------------------------------- harvest
const store = new Map(); // encounter_id -> row (dedupe across all slices)
let sliceMeta = { total: 0, ok: 0, failed: 0, rows: 0, cap: null, tier: null };

function absorb(rows) {
  let fresh = 0;
  for (const r of rows || []) {
    if (!r || !r.encounter_id) continue;
    if (!store.has(r.encounter_id)) fresh++;
    const prev = store.get(r.encounter_id);
    store.set(r.encounter_id, prev ? { ...r, ...prev } : r);
  }
  return fresh;
}

async function run() {
  // --shiny requires auth: the filter is trainer-gated server-side (403
  // trainer_not_linked without a JWT). Fail fast with a clear message.
  if (SHINY && !JWT) {
    console.log("[!] --shiny needs your JWT. The shiny filter is trainer-gated.");
    console.log("[!] pass --jwt \"<token>\" or set POGO_JWT.");
    process.exit(1);
  }
  // --shiny is useless without coords, so reveal defaults ON there.
  const doReveal = DO_REVEAL || SHINY;

  // --probe: exactly one request, report cap/tier/latency, bail.
  if (PROBE) {
    const t = Date.now();
    const res = await postSearch(baseSpec());
    const ms = Date.now() - t;
    if (res.error) {
      console.log(`[probe] ERROR ${res.error} after ${ms}ms`);
      process.exit(1);
    }
    console.log(
      `[probe] OK ${ms}ms | cap=${res.cap} tier=${res.tier} | ` +
        `${(res.results || []).length} rows | backoff=${pacer.backoff}ms`,
    );
    if (res.results?.[0]) {
      const r = res.results[0];
      console.log(
        `[probe] sample: #${r.pokemon_id} ${r.pokemon_name} cp=${r.cp} ` +
          `iv=${r.iv_percent}% lvl=${r.level} @ ${r.location}`,
      );
    }
    return;
  }

  const slices = buildSlices().slice(0, MAX_SLICES);
  sliceMeta.total = slices.length;

  console.log(`[+] ${slices.length} slices planned | cap per query will be ${
    JWT ? "auth-tier (10+)" : "5 (anon)"
  } | pacing >= ${LATENCY}ms`);
  if (SHINY) console.log("[+] SHINY MODE: rows are shiny for YOUR account (trainer-linked)");
  if (doReveal) console.log("[+] coord reveal ON (adds a 2nd request per row)");

  let i = 0;
  for (const { label, patch } of slices) {
    i++;
    const spec = { ...baseSpec(), ...patch };
    const res = await postSearch(spec);

    if (res.error) {
      sliceMeta.failed++;
      console.log(`[${i}/${slices.length}] ${label} -> ERROR ${res.error}`);
      // Long server-imposed cooldown: stop, save what we have, tell Kovak.
      if (String(res.error).startsWith("cooldown_")) {
        console.log(`\n[!] server rate-limit penalty active (${res.error}).`);
        console.log(`[!] stopping early with ${store.size} unique rows already collected.`);
        break;
      }
      continue;
    }

    sliceMeta.ok++;
    if (res.cap != null) sliceMeta.cap = res.cap;
    if (res.tier) sliceMeta.tier = res.tier;

    const fresh = absorb(res.results);
    sliceMeta.rows += (res.results || []).length;

    console.log(
      `[${i}/${slices.length}] ${label} -> ${(res.results || []).length} rows, ` +
        `${fresh} new | union=${store.size} (cap=${res.cap}, tier=${res.tier})`,
    );

    if (store.size >= TOP) {
      console.log(`[+] reached --top ${TOP}, stopping early`);
      break;
    }
  }

  // -------------------------------------------------------- optional reveal
  if (doReveal) {
    console.log(`\n[+] revealing coords for ${store.size} rows...`);
    let done = 0;
    for (const row of store.values()) {
      if (!row.reveal_code) continue;
      const r = await revealCoords(row.reveal_code);
      if (r) {
        row.lat = r.lat;
        row.lng = r.lng;
        row.coords = r.coords;
      }
      done++;
      if (done % 25 === 0) {
        const got = [...store.values()].filter((x) => x.coords).length;
        console.log(`    revealed ${done}/${store.size} (${got} coords)`);
      }
    }
  }

  // ------------------------------------------------------------- output
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const all = [...store.values()].sort((a, b) => {
    // soonest-to-despawn first when we have the field, else by IV desc
    const ta = a.despawn_at ? Date.parse(a.despawn_at) : Infinity;
    const tb = b.despawn_at ? Date.parse(b.despawn_at) : Infinity;
    return ta - tb;
  });

  const cols = [
    "pokemon_id", "pokemon_name", "form", "cp", "level", "iv_percent", "raw_iv",
    "size", "gender", "weather_boosted", "shiny", "fast_move", "charge_move",
    "despawn_at", "distance_km", "location", "lat", "lng", "encounter_id", "reveal_code",
  ];

  const csv = [
    cols.join(","),
    ...all.map((r) =>
      cols
        .map((c) => {
          const v = r[c];
          if (v == null) return "";
          const s = String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    ),
  ].join("\n");

  writeFileSync(join(OUT, "spawns.csv"), csv, "utf8");
  writeFileSync(join(OUT, "spawns.json"), JSON.stringify(all, null, 2), "utf8");

  // ------------------------------------------------------------- summary
  const withCoords = all.filter((r) => r.coords).length;
  const bySpecies = {};
  for (const r of all) {
    const k = `${r.pokemon_id}:${r.pokemon_name}${r.form ? ` (${r.form})` : ""}`;
    bySpecies[k] = (bySpecies[k] || 0) + 1;
  }
  const topSpecies = Object.entries(bySpecies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const shiny = all.filter((r) => r.shiny).length;
  const hundo = all.filter((r) => Number(r.iv_percent) >= 100).length;

  console.log("\n================ HARVEST COMPLETE ================");
  console.log(`slices          : ${sliceMeta.ok}/${sliceMeta.total} ok, ${sliceMeta.failed} failed`);
  console.log(`server cap/tier : ${sliceMeta.cap} / ${sliceMeta.tier}`);
  console.log(`rows absorbed   : ${sliceMeta.rows} (pre-dedupe)`);
  console.log(`UNIQUE union    : ${all.length}   <-- this is your bypass number`);
  console.log(`shiny           : ${shiny}`);
  console.log(`100% IV         : ${hundo}`);
  if (doReveal) console.log(`coords resolved : ${withCoords}`);
  console.log(`top species     :`);
  for (const [k, v] of topSpecies) console.log(`    ${String(v).padStart(4)}  ${k}`);
  console.log(`files           : ${join(OUT, "spawns.csv")}`);
  console.log(`                  ${join(OUT, "spawns.json")}`);
  console.log("===================================================");
}

run();
