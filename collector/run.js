// Collector entry point. Reads config/movies.json, collects Fandango (USA) and District
// (India cities) for each tracked movie and date, and writes JSON under data/.
//
//   data/usa/<slug>/<date>.json          per-show rows + summary (Fandango)
//   data/district/<slug>/<city>/<date>.json
//   data/index.json                      what exists, with latest timestamps
//
// BookMyShow files (data/bms/<slug>/<city>/<date>.json) are written by the Chrome
// extension's Publish button, never by this job.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { collectFandango } from "./fandango.js";
import { collectDistrict } from "./district.js";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const DATA = path.join(ROOT, "data");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function readJson(p, fallback) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; } }
async function writeJson(p, obj) { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(obj)); }

const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST calendar day
function datesFor(movie) {
  // release date and the two days before it, then every day until the tracking window ends
  const out = [];
  const start = new Date(movie.release + "T00:00:00Z"); start.setUTCDate(start.getUTCDate() - 2);
  const end = new Date(movie.until || movie.release + "T00:00:00Z");
  if (!movie.until) end.setUTCDate(end.getUTCDate() + 14);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = d.toISOString().slice(0, 10);
    if (s >= today() || s >= movie.release) out.push(s); // keep past release days for history, skip stale pre-release days
  }
  return out;
}

function summarize(shows) {
  const ok = shows.filter((s) => !s.error);
  return {
    gross: Math.round(ok.reduce((n, s) => n + s.gross, 0)),
    sold: ok.reduce((n, s) => n + s.sold, 0),
    cap: ok.reduce((n, s) => n + s.cap, 0),
    shows: ok.length,
    unread: shows.length - ok.length,
    locations: new Set(ok.map((s) => s.theaterId || s.venueId)).size,
  };
}

async function main() {
  const cfg = await readJson(path.join(ROOT, "config", "movies.json"), { movies: [] });
  const index = await readJson(path.join(DATA, "index.json"), { movies: {} });
  const now = new Date().toISOString();

  for (const movie of cfg.movies) {
    const entry = (index.movies[movie.slug] = index.movies[movie.slug] || { title: movie.title, usa: {}, district: {}, bms: {} });
    entry.title = movie.title; entry.release = movie.release;

    // ---- USA (Fandango) ----
    if (movie.fandangoId) {
      const memPath = path.join(DATA, "usa", movie.slug, "_theaters.json");
      const known = await readJson(memPath, {});
      for (const date of datesFor(movie)) {
        if (date > today() && new Date(date) - new Date(today()) > 3 * 86400000) continue; // at most 3 days ahead
        const outPath = path.join(DATA, "usa", movie.slug, `${date}.json`);
        const prev = await readJson(outPath, null);
        const previous = prev ? Object.fromEntries(prev.shows.map((s) => [s.hash, s])) : {};
        try {
          const r = await collectFandango({ movieId: movie.fandangoId, date, knownTheaters: known, previous, log });
          for (const t of r.theaters) known[t.id] = { zip: t.zip, name: t.name };
          const summary = summarize(r.shows);
          const history = [...(prev?.history || []), { at: now, ...summary }].slice(-500);
          await writeJson(outPath, { source: "fandango", movie: movie.slug, date, updatedAt: now, summary, history, theaters: r.theaters, shows: r.shows });
          entry.usa[date] = { updatedAt: now, ...summary };
          log(`USA ${movie.slug} ${date}: $${summary.gross} ${summary.sold} tickets ${summary.shows} shows ${summary.locations} locations`);
        } catch (e) { log(`USA ${movie.slug} ${date} failed: ${e.message}`); }
      }
      await writeJson(memPath, known);
    }

    // ---- India (District) ----
    for (const [city, url] of Object.entries(movie.district || {})) {
      for (const date of datesFor(movie)) {
        if (date > today() && new Date(date) - new Date(today()) > 3 * 86400000) continue;
        const outPath = path.join(DATA, "district", movie.slug, city, `${date}.json`);
        const prev = await readJson(outPath, null);
        try {
          const r = await collectDistrict({ url, date });
          const summary = summarize(r.shows);
          const history = [...(prev?.history || []), { at: now, ...summary }].slice(-500);
          await writeJson(outPath, { source: "district", movie: movie.slug, city, date, updatedAt: now, summary, history, venues: r.venues, shows: r.shows });
          entry.district[`${city}/${date}`] = { updatedAt: now, ...summary };
          log(`District ${movie.slug} ${city} ${date}: ₹${summary.gross} ${summary.sold} seats ${summary.shows} shows`);
        } catch (e) { log(`District ${movie.slug} ${city} ${date} failed: ${e.message}`); }
      }
    }

    // ---- BookMyShow files written by the extension: index them ----
    const bmsDir = path.join(DATA, "bms", movie.slug);
    if (existsSync(bmsDir)) {
      for (const city of await readdir(bmsDir)) {
        const cityDir = path.join(bmsDir, city);
        for (const f of (await readdir(cityDir)).filter((x) => x.endsWith(".json"))) {
          const j = await readJson(path.join(cityDir, f), null);
          if (j?.summary) entry.bms[`${city}/${f.replace(".json", "")}`] = { updatedAt: j.updatedAt, ...j.summary };
        }
      }
    }
  }
  index.updatedAt = now;
  await writeJson(path.join(DATA, "index.json"), index);
  log("done");
}

main().catch((e) => { console.error(e); process.exit(1); });
