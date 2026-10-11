// reveal.mjs — search a spec, reveal coords, print a table
// usage: node reveal.mjs <spec.json> [label]      (spec read from file; avoids shell quoting)
import { readFileSync } from "node:fs";

const API = "https://coordinates-api.pokemongopro.com";
const JWT = readFileSync(new URL("./jwt.txt", import.meta.url), "utf8").trim();
const spec = readFileSync(process.argv[2], "utf8").trim();
const label = process.argv[3] || "results";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  for (let i = 0; i < 6; i++) {
    await sleep(6000);
    const res = await fetch(`${API}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      await sleep((d?.detail?.retry_after ?? 10) * 1000);
      continue;
    }
    if (!res.ok) return { error: res.status };
    return await res.json();
  }
  return { error: "rate_limited" };
}

async function reveal(code) {
  for (let i = 0; i < 4; i++) {
    await sleep(6000);
    const res = await fetch(`${API}/reveal/${encodeURIComponent(code)}`, {
      headers: { Authorization: `Bearer ${JWT}` },
    });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      await sleep((d?.detail?.retry_after ?? 15) * 1000);
      continue;
    }
    if (!res.ok) return null;
    return await res.json();
  }
  return null;
}

const j = await post(JSON.parse(spec));
if (!j.results || !j.results.length) {
  console.log(`${label}: 0 results`);
  process.exit(0);
}

console.log(`${label}: ${j.results.length} result(s)\n`);
for (const r of j.results) {
  const c = await reveal(r.reveal_code);
  const when = r.despawn_at ? new Date(r.despawn_at) : null;
  const mins = when ? Math.round((when.getTime() - Date.now()) / 60000) : "?";
  console.log(
    `${r.pokemon_name}${r.form ? ` (${r.form})` : ""}  ` +
      `iv=${r.raw_iv} (${r.iv_percent}%)  cp=${r.cp}  lvl=${r.level}` +
      `${r.size ? "  size=" + r.size : ""}${r.shiny ? "  SHINY" : ""}`,
  );
  console.log(`   ${r.location}`);
  console.log(`   ${c ? c.coords : "coords unavailable"}`);
  console.log(`   despawns in ~${mins} min  (${r.despawn_at})\n`);
}
