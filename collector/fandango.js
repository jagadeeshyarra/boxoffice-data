// Fandango (USA) collector: same logic as the Chrome extension, run from Node.
//  1. Visit the movie page once to obtain Fandango's session cookie.
//  2. Showtimes API per zip (15-mile radius) with a self-expanding crawl from seed zips
//     plus the zip of every theater found plus theaters remembered from earlier runs.
//  3. Seat-map API per show: seats taken x general-admission price (base, no fee).
//     Sold-out shows (HTTP 410) are priced as full houses from the theater's other shows;
//     general-admission shows (HTTP 400) have no seat map and are reported separately.

import { SEED_ZIPS } from "./seeds.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const BASE = "https://www.fandango.com";
const ZIP_CONCURRENCY = 6;
const SEAT_CONCURRENCY = 6;
const SEAT_MIN_GAP_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- session ----------

class Session {
  constructor() { this.cookies = new Map(); this.referer = BASE + "/"; }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(res) {
    const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of set) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  }
  async get(url, accept = "application/json") {
    for (let i = 0; ; i++) {
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept, Referer: this.referer, Cookie: this.cookieHeader() }, redirect: "follow" });
      } catch (e) { if (i >= 2) throw e; await sleep(1500 * (i + 1)); continue; }
      this.absorb(res);
      if ((res.status === 429 || res.status >= 500) && i < 3) { await sleep(2000 * (i + 1)); continue; }
      return res;
    }
  }
}

class HttpError extends Error { constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; } }

async function getJson(session, url) {
  const res = await session.get(url);
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
  return res.json();
}

// ---------- helpers ----------

export function formatLabel(header, amenityString, filmFormat) {
  const text = [amenityString, Array.isArray(filmFormat) ? filmFormat.join(" ") : filmFormat, header].filter(Boolean).join(" ");
  const known = [["IMAX", /imax/i], ["XD", /\bxd\b/i], ["RPX", /\brpx\b/i], ["Dolby Cinema", /dolby cinema/i], ["ScreenX", /screenx/i], ["4DX", /4dx/i], ["PXL", /\bpxl\b/i], ["UltraScreen", /ultrascreen/i], ["Prime", /\bprime\b/i]];
  for (const [label, re] of known) if (re.test(text)) return label;
  return /premium/i.test(header || "") ? "Other PLF" : "Standard";
}

function adultPrice(area) {
  const infos = area.ticketInfo || [];
  const pick = infos.find((t) => /general|adult/i.test(t.desc || "")) || infos.reduce((a, b) => (!a || +b.price > +a.price ? b : a), null);
  return pick ? +pick.price : 0;
}

// ---------- step 1: crawl ----------

async function crawl(session, movieId, date, knownZips, log) {
  const queue = [...new Set([...SEED_ZIPS, ...knownZips])];
  const seenZip = new Set(queue);
  const theaters = new Map();
  let i = 0, done = 0;
  const worker = async () => {
    while (i < queue.length) {
      const zip = queue[i++];
      try {
        const j = await getJson(session, `${BASE}/napi/theaterShowtimeGroupings/${movieId}/${date}?isdesktop=true&postalCode=${zip}&zip=${zip}&isDesktopMOP=false`);
        for (const t of j?.theaterShowtimes?.theaters || []) {
          if (!theaters.has(t.id)) {
            theaters.set(t.id, { theater: { id: t.id, name: t.name, chain: t.chainCode || "", state: t.state, city: t.city, zip: t.zip }, shows: [] });
            if (t.zip && !seenZip.has(t.zip)) { seenZip.add(t.zip); queue.push(t.zip); }
          }
          const entry = theaters.get(t.id);
          for (const v of t.variants || []) for (const g of v.amenityGroups || []) for (const s of g.showtimes || []) {
            if (entry.shows.some((x) => x.hash === s.showtimeHashCode)) continue;
            entry.shows.push({ hash: s.showtimeHashCode, id: String(s.id), time: s.screenReaderTime || s.date, dateLocal: s.dateLocal, format: formatLabel(v.filmFormatHeader, g.amenityString, s.filmFormat), reserved: !!g.hasReservedSeating, soldOut: !!s.isSoldOut });
          }
        }
      } catch (e) { /* zip without data */ }
      done++;
      if (done % 50 === 0) log(`  zips ${done}/${queue.length}: ${theaters.size} theaters`);
    }
  };
  await Promise.all(Array.from({ length: ZIP_CONCURRENCY }, worker));
  return { theaters, zipsQueried: queue.length };
}

// ---------- step 2: seat maps ----------

let nextSlot = 0;
async function pace() { const now = Date.now(); const at = Math.max(now, nextSlot); nextSlot = at + SEAT_MIN_GAP_MS; if (at > now) await sleep(at - now); }

async function readSeatMap(session, show) {
  await pace();
  const m = await getJson(session, `${BASE}/napi/seatMap/${show.hash}`);
  if (m == null || m.totalSeatCount == null) throw new Error("no seat map");
  let sold = 0, cap = 0, gross = 0, price = 0;
  for (const a of m.areas || []) {
    const p = adultPrice(a);
    const total = a.totalSeatCount ?? 0, avail = a.availableSeatCount ?? 0;
    const s = Math.max(0, total - avail);
    sold += s; cap += total; gross += s * p; if (!price) price = p;
  }
  if (!cap) { cap = m.totalSeatCount; sold = Math.max(0, cap - (m.totalAvailableSeatCount ?? 0)); price = adultPrice(m.areas?.[0] || {}); gross = sold * price; }
  return { sold, cap, gross, price };
}

// ---------- main ----------

/**
 * @param {{movieId:string, date:string, knownTheaters?:Record<string,{zip:string}>, previous?:Record<string,object>, log?:Function}} opts
 * @returns {{theaters:object[], shows:object[], zipsQueried:number}}
 */
export async function collectFandango({ movieId, date, knownTheaters = {}, previous = {}, log = console.log }) {
  const session = new Session();
  const slugRes = await session.get(`${BASE}/movie-overview?id=${movieId}`, "text/html").catch(() => null); // any page sets the session cookie
  session.referer = slugRes?.url || BASE + "/";
  log(`Fandango ${movieId} ${date}: crawling...`);
  const { theaters, zipsQueried } = await crawl(session, movieId, date, Object.values(knownTheaters).map((t) => t.zip).filter(Boolean), log);
  const shows = [];
  for (const { theater, shows: ss } of theaters.values()) for (const s of ss) shows.push({ ...s, theaterId: theater.id, theater: theater.name, chain: theater.chain, state: theater.state, city: theater.city });
  log(`  ${theaters.size} theaters, ${shows.length} shows from ${zipsQueried} zips. Reading seat maps...`);

  const results = {};
  const soldOutShows = [];
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: SEAT_CONCURRENCY }, async () => {
    while (i < shows.length) {
      const s = shows[i++];
      try { results[s.hash] = { ...s, ...(await readSeatMap(session, s)) }; }
      catch (e) {
        if (e instanceof HttpError && e.status === 410) soldOutShows.push(s);
        else if (e instanceof HttpError && e.status === 400 && /GeneralAdmission/i.test(e.body)) results[s.hash] = { ...s, ga: true, error: "general admission" };
        else if (previous[s.hash] && !previous[s.hash].error) results[s.hash] = { ...previous[s.hash], stale: true };
        else results[s.hash] = { ...s, error: String(e.message || e) };
      }
      done++;
      if (done % 200 === 0) log(`  seat maps ${done}/${shows.length}`);
    }
  }));
  for (const s of soldOutShows) {
    const same = Object.values(results).filter((r) => r.theaterId === s.theaterId && r.cap > 0);
    const pool = same.filter((r) => r.format === s.format).length ? same.filter((r) => r.format === s.format) : same;
    if (!pool.length) { results[s.hash] = { ...s, error: "sold out; capacity unknown" }; continue; }
    const caps = pool.map((r) => r.cap).sort((a, b) => a - b);
    const cap = caps[Math.floor(caps.length / 2)];
    const price = pool.map((r) => r.price).sort((a, b) => a - b)[Math.floor(pool.length / 2)] || 0;
    results[s.hash] = { ...s, sold: cap, cap, gross: cap * price, price, soldOut: true, estimated: true };
  }
  return { theaters: [...theaters.values()].map((t) => t.theater), shows: Object.values(results), zipsQueried };
}
