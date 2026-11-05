# OpiTv BDIX — Nuvio addon

A [Nuvio](https://github.com/NuvioMedia/NuvioTV) addon (implementing the Stremio addon
protocol) that turns a BDIX / ISP media catalog into browsable Netflix-style rows with
posters, metadata and direct playback links.

It ships as a Cloudflare Worker with the catalog pre-built as static assets, so the
Worker only slices small files per request and stays inside the free plan's CPU budget.

- **27 catalogues** — Hindi Dubbed (movies + series) first, then Trending, Popular,
  Action, Thriller, Horror, Comedy, Romance, Sci-Fi, Fantasy, Indian, Korean, Japanese,
  Recently Added, K-Dramas, Crime, Indian TV, and the complete OpiTv rows at the bottom.
- **~37,500 movies** and the Hindi / Bangla / Hindi-dubbed series set.
- Posters, backdrops, ratings and descriptions enriched from TMDB.

## What this is, and what it is not

This addon serves **an index and metadata only**. It does not host, copy, proxy or
transcode any media.

Playback URLs point straight at the file hosts the catalog material was indexed from.
Those hosts are only reachable from the same ISP network (BDIX) as the catalog, so:

- on that network, rows browse and streams play;
- off it, rows still load but nothing plays.

## Deploy to Cloudflare Workers

Requirements: a Cloudflare account and Node 18+ (for `npx wrangler`).

```bash
# from the release zip
unzip opitv-worker.zip -d opitv-addon
cd opitv-addon
npx wrangler login
npx wrangler deploy
```

Wrangler prints the deployed URL. To deploy from a clone of this repo instead, run
`npx wrangler deploy` in the repo root — `wrangler.toml` already points at
`./data` as the assets directory.

### Automatic deploys (optional)

In the Cloudflare dashboard: **Workers & Pages → your Worker → Settings → Builds &
deployments → Connect Git**, pick this repository and branch. After that every push
redeploys the Worker, which is the safest way to update it — copying files by hand is
how a half-merged `data/` folder once shipped and broke every row.

## Add it to Nuvio

1. **Settings → Addons → Add addon**, and enter the manifest URL:
   `https://<your-worker>.<your-subdomain>.workers.dev/manifest.json`
2. Each catalogue appears as its own home row, and **See All** pages through the row.

Two client behaviours worth knowing:

- **The client caches the manifest.** After adding, renaming or removing rows, re-add or
  refresh the addon, or the home screen keeps showing the old set.
- **The client stores its own row order** per profile. If the row order here and on the
  home screen disagree, open the catalogue-order screen and enable **"Follow addons
  order"**; otherwise the saved order (and any row added later, appended at the bottom)
  wins.

## Routes

Standard addon protocol, all plain JSON:

```
GET /manifest.json
GET /catalog/{type}/{catalogId}.json
GET /catalog/{type}/{catalogId}/skip=N.json
GET /catalog/{type}/{catalogId}/search=term.json
GET /meta/{type}/{id}.json
GET /stream/{type}/{id}.json
GET /health
```

## Repository layout

| Path | What it is |
| --- | --- |
| `src/index.js` | The Worker: routes each request to the right pre-built asset |
| `data/rows.json` | Catalogue list: id, type, name, item count, page count |
| `data/c/<catalog>/p<N>.json` | One page (100 ordered previews) per catalogue |
| `data/c/<catalog>/s.txt` | Search index for that catalogue |
| `data/m/<n>.json`, `data/s/<n>.json` | Per-title shards: metadata, episodes, streams |
| `data/alias.json` | IMDb / TMDB id → catalog id, so the client can resolve outside ids |
| `data/shards.json` | Shard sizes, plus the series id → shard map |
| `wrangler.toml` | Worker name and the `./data` assets binding |
| `opitv-worker.zip` | The same tree, ready to unzip and deploy |

## Rebuilding the data (for the catalog owner)

The free plan allows roughly 10 ms of CPU per request, which is far too little to parse
a multi-megabyte catalog, so everything is pre-built offline:

```bash
python3 build_worker_data.py    # crawler caches -> cloudflare/data
python3 verify_sources.py --from-data   # probe every stream URL, resumable
python3 build_worker_data.py    # rebuild with dead sources dropped
python3 test_data.py           # 27 catalogues + several hundred item lookups
python3 bundle.py              # refresh opitv-worker.zip
```

`build_worker_data.py` reads the per-category crawler caches in `tools/cache/` (not
included in this repository) rather than one large merged file, which keeps memory use
in the low hundreds of MB instead of gigabytes.

## Why the data is trustworthy

Several hosts in this catalog are single-page apps: a request for a file they do not
have is answered with the site's HTML shell and **HTTP 200/206**. A "206 Partial
Content" therefore proves nothing, and a dead link looks healthy until it hangs the
player on "loading".

So `verify_sources.py` probes every URL the build ships — a ranged request, the
`Content-Type`, and the first bytes — and caches the verdict per URL. The build then:

- drops every source that is not real video, **before** applying per-title caps, so a
  working mirror takes the slot instead of a dead one;
- drops titles left with nothing playable;
- lists only episodes that have a file (a portal entry can advertise 19 episodes while
  a single one exists).

Series are additionally limited to Hindi, Bangla and Hindi-dubbed.

## Limits

- Search reads the largest asset (`data/c/opitv-movies/s.txt`, ~6 MB) — the heaviest
  route on the free plan. If you see Cloudflare error 1102, either move to the paid
  Workers plan or split that index.
- This build ships well under the free plan's 20,000-asset limit.
- Playback requires the ISP network described above; on an addon that browses fine but
  plays nothing, check the network before blaming the Worker.

## Credits

Catalog, crawling, addon and Worker: personal project. Addon protocol by Stremio,
consumed by NuvioTV. Metadata from TMDB. No media files are stored in this repository.
