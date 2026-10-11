#!/usr/bin/env node
// monitor.mjs — persistent shiny/hundo spawn watcher for pogocoordinates.com
//
// WHAT IT DOES
//   Polls POST /search on a timer for a target spec (default: shiny + 100% IV
//   Charmander). Dedupes by encounter_id, reveals coords the instant a new
//   match appears, and fires a notification to your phone.
//
//   The cap bypass is not needed here — a narrow spec usually returns few
//   enough rows to fit under the per-query cap. This is a watcher, not a harvester.
//
// NOTIFICATION CHANNELS (set one via env / CLI)
//   NTFY_TOPIC      -> ntfy.sh push. Easiest: install the "ntfy" app on your
//                      phone, subscribe to the same topic name, done. No signup.
//   DISCORD_WEBHOOK -> Discord webhook URL. Post it in a channel you own:
//                      Server Settings -> Integrations -> Webhooks -> New -> Copy URL.
//
// ASSUMPTIONS
//   - Node 18+ (global fetch). Verified on v26.
//   - jwt.txt sits next to this file (your site session). Required: the
//     shiny filter is trainer-gated (403 trainer_not_linked without it).
//   - Rate limit is a rolling window ~1 req / 6s sustained. Default poll
//     interval is 180s, which sits comfortably under it. Do NOT go below 60s.
//
// USAGE
//   node monitor.mjs                                  # shiny 100% Charmander
//   node monitor.mjs --ids 4,158                     # shiny 100% on those species
//   node monitor.mjs --any-species                   # any species, shiny 100%
//   node monitor.mjs --no-shiny                      # 100% IV only, shiny or not
//   node monitor.mjs --interval 120                  # poll every 120s
//   NTFY_TOPIC=pogomine node monitor.mjs             # push to phone via ntfy
//   DISCORD_WEBHOOK="https://discord.com/api/webhooks/..." node monitor.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://coordinates-api.pokemongopro.com";
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (n) => argv.includes(n);

const JWT = flag("--jwt") || process.env.POGO_JWT ||
  (existsSync(new URL("./jwt.txt", import.meta.url))
    ? readFileSync(new URL("./jwt.txt", import.meta.url), "utf8").trim()
    : null);

const INTERVAL = Number(flag("--interval") || 180) * 1000;
const NTFY_TOPIC = flag("--ntfy") || process.env.NTFY_TOPIC || null;
const DISCORD_WEBHOOK = flag("--webhook") || process.env.DISCORD_WEBHOOK || null;
const ANY_SPECIES = has("--any-species");
const WANT_SHINY = !has("--no-shiny");
const MIN_IV = Number(flag("--min-iv") || 100);
const STATE = flag("--state") || "monitor_seen.json";

if (!JWT) {
  console.log("[!] no JWT. shiny filter is trainer-gated. put it in jwt.txt or pass --jwt.");
  process.exit(1);
}

// ------------------------------------------------------------------ the spec
function buildSpec() {
  const s = {
    pokemon_ids: [],
    iv_mode: "percent",
    iv_percent_min: MIN_IV,
    sort: "DSP",
    shiny_only: WANT_SHINY,
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
  if (!ANY_SPECIES) {
    const raw = flag("--ids") || "4"; // 4 = Charmander
    s.pokemon_ids = raw.split(",").map(Number).filter(Boolean);
  }
  return s;
}

// ------------------------------------------------------------------ rate limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function paced(fn, tag = "call") {
  for (let i = 0; i < 6; i++) {
    const wait = Math.max(0, lastCall + 6500 - Date.now());
    if (wait) await sleep(wait);
    lastCall = Date.now();
    try {
      const out = await fn();
      if (out && out.__retry) {
        await sleep((out.__retry || 15) * 1000);
        continue;
      }
      return out;
    } catch (e) {
      console.log(`    ${tag} net error: ${e.message}`);
      await sleep(8000);
    }
  }
  return null;
}

async function search(spec) {
  const r = await paced(async () => {
    const res = await fetch(`${API}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      return { __retry: d?.detail?.retry_after ?? 20 };
    }
    if (!res.ok) return { __retry: 15 };
    return res.json();
  }, "search");
  return r && !r.__retry ? r : null;
}

async function reveal(code) {
  const r = await paced(async () => {
    const res = await fetch(`${API}/reveal/${encodeURIComponent(code)}`, {
      headers: { Authorization: `Bearer ${JWT}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      return { __retry: d?.detail?.retry_after ?? 20 };
    }
    if (!res.ok) return null;
    return res.json();
  }, "reveal");
  return r && !r.__retry ? r : null;
}

// ------------------------------------------------------------------ notify
function googleMapsLink(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

async function notify(hit) {
  const lines = [
    `SHINY ${WANT_SHINY ? "+" : ""}${MIN_IV}% IV`,
    `${hit.pokemon_name}${hit.form ? ` (${hit.form})` : ""}  iv=${hit.raw_iv}`,
    `cp=${hit.cp}  lvl=${hit.level}${hit.size ? "  size=" + hit.size : ""}`,
    hit.coords ? googleMapsLink(hit.lat, hit.lng) : hit.location,
    `despawns ~${hit.minsLeft} min`,
  ];
  // Bare coords on their own lines at the very end so you can long-press copy
  // each straight into your spoofing app.
  if (hit.lat != null && hit.lng != null) {
    lines.push(String(hit.lat), String(hit.lng));
  }
  const text = lines.join("\n");

  // ntfy.sh — zero signup. topic name is the whole "auth".
  if (NTFY_TOPIC) {
    try {
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: "POST",
        headers: {
          Title: `Pokemon GO: ${hit.pokemon_name} ${MIN_IV}% IV`,
          Priority: "high",
          Tags: "sparkles,boom",
        },
        body: text,
      });
      console.log(`    -> ntfy.sh/${NTFY_TOPIC} sent (full)`);

      // Second push: bare coords only. The ntfy app long-press-copies the whole
      // body, so keeping this to just lat/lng means one long-press grabs exactly
      // the two values and nothing else.
      if (hit.lat != null && hit.lng != null) {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
          method: "POST",
          headers: {
            Title: `${hit.pokemon_name} - coords`,
            Priority: "high",
            Tags: "round_pushpin",
          },
          // Single line, "lat lng" — one long-press copies both, ready to paste.
          body: `${hit.lat} ${hit.lng}`,
        });
        console.log(`    -> ntfy.sh/${NTFY_TOPIC} sent (coords)`);
      }
    } catch (e) {
      console.log(`    -> ntfy failed: ${e.message}`);
    }
  }

  // Discord webhook
  if (DISCORD_WEBHOOK) {
    try {
      await fetch(DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `@here ${text}`,
          username: "PoGo Monitor",
        }),
      });
      console.log("    -> discord webhook sent");
    } catch (e) {
      console.log(`    -> discord failed: ${e.message}`);
    }
  }

  if (!NTFY_TOPIC && !DISCORD_WEBHOOK) {
    console.log("    (no channel configured — printed only)");
  }
}

// ------------------------------------------------------------------ main
const spec = buildSpec();
const seen = new Set();
try {
  if (existsSync(STATE)) {
    for (const id of JSON.parse(readFileSync(STATE, "utf8"))) seen.add(id);
    console.log(`[+] resumed ${seen.size} previously-seen spawns from ${STATE}`);
  }
} catch {}

const describe = () => {
  const parts = [];
  if (WANT_SHINY) parts.push("shiny");
  parts.push(`${MIN_IV}%+ IV`);
  parts.push(ANY_SPECIES ? "ANY species" : `ids ${spec.pokemon_ids.join(",")}`);
  return parts.join(" + ");
};

console.log("====================================================");
console.log(`  PoGo spawn monitor`);
console.log(`  watching : ${describe()}`);
console.log(`  poll     : ${INTERVAL / 1000}s`);
console.log(`  ntfy     : ${NTFY_TOPIC ? "ntfy.sh/" + NTFY_TOPIC : "off"}`);
console.log(`  discord  : ${DISCORD_WEBHOOK ? "configured" : "off"}`);
console.log(`  account  : ${JWT ? "authenticated (cap 10)" : "anon"}`);
console.log("====================================================");
if (!NTFY_TOPIC && !DISCORD_WEBHOOK) {
  console.log("\n[!] no phone channel set. for push notifications run one of:\n");
  console.log("    NTFY_TOPIC=pogomine_8f3k node monitor.mjs");
  console.log("      ^ install the free 'ntfy' app, subscribe to pogomine_8f3k\n");
  console.log("    DISCORD_WEBHOOK=\"https://discord.com/api/webhooks/...\" node monitor.mjs");
  console.log("\n");
}

let tick = 0;
let hits = 0;

async function loop() {
  while (true) {
    tick++;
    const t0 = Date.now();
    const res = await search(spec);

    if (!res) {
      console.log(`[${tick}] search unavailable (rate limited / down). backing off.`);
      await sleep(INTERVAL);
      continue;
    }

    const rows = res.results || [];
    const fresh = rows.filter((r) => r.encounter_id && !seen.has(r.encounter_id));

    console.log(`[${tick}] ${rows.length} row(s), ${fresh.length} new  (cap=${res.cap}, tier=${res.tier})`);

    for (const r of fresh) {
      seen.add(r.encounter_id);
      const when = r.despawn_at ? Date.parse(r.despawn_at) : NaN;
      const minsLeft = Number.isFinite(when) ? Math.round((when - Date.now()) / 60000) : "?";

      // dead-on-arrival spawns aren't worth a push
      if (typeof minsLeft === "number" && minsLeft <= 0) {
        console.log(`    skip #${r.pokemon_id} — already despawned`);
        continue;
      }

      console.log(`    HIT #${r.pokemon_id} ${r.pokemon_name} iv=${r.raw_iv} cp=${r.cp} lvl=${r.level} ~${minsLeft}m`);
      const c = await reveal(r.reveal_code);
      const hit = {
        ...r,
        coords: c?.coords || null,
        lat: c?.lat ?? null,
        lng: c?.lng ?? null,
        minsLeft,
      };
      if (hit.coords) console.log(`      ${hit.coords}`);
      await notify(hit);
      hits++;
      try { writeFileSyncState(); } catch {}
    }

    // persist seen-set so restarts don't re-notify
    try { writeFileSyncState(); } catch {}

    const took = Date.now() - t0;
    const pause = Math.max(INTERVAL - took, 15000);
    await sleep(pause);
  }
}

function writeFileSyncState() {
  writeFileSync(STATE, JSON.stringify([...seen]));
}

loop().catch((e) => {
  console.log(`fatal: ${e.message}`);
  process.exit(1);
});
