// Find a film's Fandango id and District URLs by name, and add it to config/movies.json.
//
//   npm run add -- "The Paradise" --release 2026-09-24 --cities hyderabad,bengaluru,chennai
//   npm run add -- "Haiwaan" --release 2026-09-25 --usa-only
//   npm run add -- --list                      # show what Fandango and District have now
//
// Fandango's in-theaters and coming-soon pages carry every film's slug and numeric id.
// District's movie list carries every film's slug and MV id; a city page is the same
// slug with "-in-<city>" before the id.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const CONFIG = path.join(ROOT, "config", "movies.json");
const DEFAULT_CITIES = ["hyderabad", "bengaluru", "chennai", "mumbai", "delhi-ncr", "pune", "kolkata", "vijayawada", "visakhapatnam"];

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

/** Every film Fandango currently lists: {slug, id, name} */
export async function fandangoCatalog() {
  const pages = ["https://www.fandango.com/movies-in-theaters", "https://www.fandango.com/movies-coming-soon"];
  const out = new Map();
  for (const p of pages) {
    let html = ""; try { html = await getText(p); } catch { continue; }
    for (const m of html.matchAll(/\/([a-z0-9-]+?)-(\d{5,7})\/movie-overview/g)) {
      const [, slug, id] = m;
      const name = slug.replace(/-(19|20)\d{2}$/, "").replace(/-/g, " ");
      if (!out.has(id)) out.set(id, { id, slug: `${slug}-${id}`, name });
    }
  }
  return [...out.values()];
}

/** Every film District currently lists: {mv, slug, name} */
export async function districtCatalog() {
  const html = await getText("https://www.district.in/movies/");
  const out = new Map();
  for (const m of html.matchAll(/\/movies\/([a-z0-9-]+?)-MV(\d{4,7})/g)) {
    const [, rawSlug, mv] = m;
    const slug = rawSlug.replace(/-in-[a-z0-9-]+$/, "").replace(/-movie-tickets$/, "");
    if (!out.has(mv)) out.set(mv, { mv, slug, name: slug.replace(/-/g, " ") });
  }
  return [...out.values()];
}

function bestMatch(title, items) {
  const want = norm(title);
  const scored = items.map((it) => {
    const have = norm(it.name);
    let score = 0;
    if (have === want) score = 1;
    else if (have.startsWith(want) || want.startsWith(have)) score = 0.9;
    else {
      const a = new Set(want.split(" ")), b = new Set(have.split(" "));
      let common = 0; for (const x of a) if (b.has(x)) common++;
      score = common / Math.max(a.size, b.size);
    }
    return { ...it, score };
  }).sort((x, y) => y.score - x.score);
  return scored[0]?.score >= 0.6 ? scored[0] : null;
}

/** Keep only the cities where District actually has this film listed. */
async function districtCityUrls(slug, mv, cities) {
  const found = {};
  await Promise.all(cities.map(async (city) => {
    const url = `https://www.district.in/movies/${slug}-movie-tickets-in-${city}-MV${mv}`;
    try {
      const html = await getText(url);
      if (/__NEXT_DATA__/.test(html) && !/This page doesnt exist/i.test(html)) found[city] = url;
    } catch { /* city not listed */ }
  }));
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const has = (name) => args.includes(`--${name}`);
  const title = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") === false) || args.find((a) => !a.startsWith("--"));

  const [fand, dist] = await Promise.all([fandangoCatalog().catch(() => []), districtCatalog().catch(() => [])]);

  if (has("list") || !title) {
    console.log(`\nFandango now listing ${fand.length} films:`);
    for (const f of fand) console.log(`  ${f.id.padEnd(8)} ${f.name}`);
    console.log(`\nDistrict now listing ${dist.length} films:`);
    for (const d of dist.slice(0, 80)) console.log(`  MV${d.mv.padEnd(8)} ${d.name}`);
    console.log(`\nAdd one with:  npm run add -- "Film Name" --release 2026-09-24\n`);
    return;
  }

  const cities = (flag("cities", DEFAULT_CITIES.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
  const release = flag("release", new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10));
  const slug = flag("slug", slugify(title));

  const f = has("india-only") ? null : bestMatch(title, fand);
  const d = has("usa-only") ? null : bestMatch(title, dist);
  console.log(`Fandango: ${f ? `${f.name} (id ${f.id})` : "no match"}`);
  console.log(`District: ${d ? `${d.name} (MV${d.mv})` : "no match"}`);
  if (!f && !d) { console.log("Nothing to track; is the film listed yet?"); process.exit(1); }

  const district = d ? await districtCityUrls(d.slug, d.mv, cities) : {};
  if (d) console.log(`District cities with showtimes: ${Object.keys(district).join(", ") || "none yet"}`);

  const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
  const entry = { slug, title, release, until: flag("until", undefined), ...(f ? { fandangoId: f.id } : {}), ...(Object.keys(district).length ? { district } : {}) };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  const i = cfg.movies.findIndex((m) => m.slug === slug);
  if (i >= 0) cfg.movies[i] = { ...cfg.movies[i], ...entry }; else cfg.movies.push(entry);
  await writeFile(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`\n${i >= 0 ? "Updated" : "Added"} "${title}" in config/movies.json. Commit and push; the hourly job picks it up.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
