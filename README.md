# boxoffice-data

Advance-booking data for tracked films, refreshed hourly by GitHub Actions.

- `data/usa/<movie>/<date>.json` — Fandango (USA): per-show rows + summary + history
- `data/district/<movie>/<city>/<date>.json` — District (India city): per-show rows + summary + history
- `data/bms/<movie>/<city>/<date>.json` — BookMyShow (India city), published from the Chrome extension
- `data/index.json` — what exists, with latest summaries

Configure tracked films in `config/movies.json`. Run locally with `npm run collect`.

Gross = seats taken × base ticket price (no convenience fee). Taken includes seats on hold.
