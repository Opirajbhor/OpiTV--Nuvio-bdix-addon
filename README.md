# OpiTv addon on Cloudflare Workers

Same Stremio-protocol addon as `../addon.py`, but running on Cloudflare's edge
instead of your phone. It serves an HTTPS URL that works from any network.

## Why the data is pre-built

The free plan allows ~10 ms of CPU per request, and parsing the 6 MB
`js/sources.js` takes far longer than that. So `../build_worker_data.py`
flattens the catalog into static assets — ordered pages, search indexes and
per-item shards — and the Worker only slices them:

    data/rows.json          catalogId -> {type, name, count, pages} + row order
    data/c/<cid>/p<N>.json  page N (100 previews, already ordered)
    data/c/<cid>/s.txt      search index: id, folded names, preview JSON
    data/m/<n>.json         movie shards, 200 items each
    data/s/<n>.json         series shards, 40 items each (episodes + streams)
    data/alias.json         imdb/tmdb id -> catalog id
    data/shards.json        shard sizes

## Deploy

```bash
# 1. on the phone: rebuild the assets after any catalog/enrichment change
python3 ../build_worker_data.py     # writes cloudflare/data/
python3 ../bundle.py               # writes cloudflare/opitv-worker.zip

# 2. on a machine with Node (or a GitHub runner):
npx wrangler login
npx wrangler deploy
```

Wrangler prints the URL, e.g. `https://opitv-addon.<your-subdomain>.workers.dev`.
Add `.../manifest.json` in NuvioTV → Settings → Addons.

Local check before deploying: `npx wrangler dev`.

## Data flow to keep in mind

- Update the catalog → re-run `build_worker_data.py` → re-deploy. The Worker
  serves whatever was in `data/` at deploy time.
- `/health` reports row counts, handy to confirm a deploy.
- Playback is unaffected: stream URLs still point at the BDIX host, so the
  device watching must be able to reach `103.112.150.230`.

## Limits

- Search requests read the largest asset (`c/opitv-movies/s.txt`, ~2.5 MB) —
  the only route that could brush the free CPU budget. Everything else is a
  small parse. If you hit error 1102, either move to the $5 Workers plan or
  reduce `PAGE`/split that index further.
- 497 asset files, ~30 MB total — inside the free plan's 20,000 files.
