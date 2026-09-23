// District (district.in, India) collector: same logic as the Chrome extension.
// One server-rendered page per city and date carries every show with per-category
// total seats, seats available and price. Show times are UTC without a zone marker
// and are shifted to IST. Gross = (total - available) x price per category.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

function walk(obj, visit, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 14) return;
  if (visit(obj) === true) return;
  for (const v of Object.values(obj)) walk(v, visit, depth + 1);
}

/**
 * @param {{url:string, date:string}} opts  url: district movie page for the city; date: YYYY-MM-DD
 */
export async function collectDistrict({ url, date }) {
  const u = new URL(url); u.search = ""; u.searchParams.set("fromdate", date);
  const res = await fetch(u.toString(), { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`District HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("District page has no data");
  const data = JSON.parse(m[1])?.props?.pageProps?.data || {};
  const title = data.movieName || (html.match(/<title>Book (.*?) Tickets/i) || [])[1] || "";
  const city = data.cityLabel || data.cityName || "";
  const venues = [];
  walk(data, (o) => { if (Array.isArray(o.sessions) && o.cinemaInfo) { venues.push(o); return true; } });

  const shows = [];
  for (const v of venues) {
    const name = v.cinemaInfo.name || v.cinemaInfo.label || String(v.id);
    for (const s of [...(v.sessions || []), ...(v.extraSessions || [])]) {
      const ist = s.showTime ? new Date(Date.parse(s.showTime + "Z") + 330 * 60000) : null;
      const istStr = ist ? ist.toISOString().slice(0, 16) : "";
      if (istStr && !istStr.startsWith(date)) continue;
      const hm = istStr.match(/T(\d{2}):(\d{2})/);
      const showTime = hm ? `${String(((+hm[1] + 11) % 12) + 1).padStart(2, "0")}:${hm[2]} ${+hm[1] >= 12 ? "PM" : "AM"}` : "";
      let sold = 0, cap = 0, gross = 0;
      const cats = {};
      for (const a of s.areas || []) {
        const total = a.sTotal ?? a.seatsTotal, avail = a.sAvail ?? a.seatsAvail, price = a.price;
        if (total == null || avail == null || price == null) continue;
        const so = Math.max(0, total - avail);
        cats[a.label || a.code] = { price, sold: so, total };
        sold += so; cap += total; gross += so * price;
      }
      shows.push({ sessionId: String(s.sid || s.id || ""), venueId: "D" + v.id, venueName: name, showTime, screen: s.audi || "", format: s.scrnFmt || "", sold, cap, gross, cats, ...(cap ? {} : { error: "no seat data" }) });
    }
  }
  return { title, city, venues: venues.map((v) => ({ id: "D" + v.id, name: v.cinemaInfo.name })), shows };
}
