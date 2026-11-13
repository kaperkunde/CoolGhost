# traffic-stats

A small [Fastify](https://fastify.dev) service that emulates the [Tinybird](https://www.tinybird.co) query API that Ghost 6 expects for its analytics dashboard, backed by a **self-hosted ClickHouse** instead of Tinybird Cloud.

It lets the Ghost Admin "Analytics" views (visitor KPIs, Top content, Sources, Locations, active visitors) work entirely within your own infrastructure.

## How it fits in

```
Ghost Admin ──▶ Caddy /.ghost/stats/* ──▶ traffic-stats ──▶ ClickHouse
```

- Ghost sends Tinybird-style pipe requests (`/v0/pipes/<name>.json`) with a signed JWT.
- `traffic-stats` verifies the token, maps the pipe to a ClickHouse query, and returns the Tinybird-compatible JSON envelope (`{meta, data, rows, statistics}`).
- Ingest is handled separately by the official `traffic-analytics` service, which forwards page hits to `traffic-stats`' `/v0/events` and on into ClickHouse.

## API

| Route                       | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `GET /v0/health`            | Health check: `{"status":"ok"}`, or `503` when ClickHouse is unreachable. |
| `GET /v0/pipes/<name>.json` | Run a named pipe. Auth via `Authorization: Bearer <jwt>` or `?token=`.   |
| `POST /v0/events`           | Ingest endpoint (used by `traffic-analytics`), with `Authorization: Bearer <TRAFFIC_STATS_INGEST_TOKEN>`. |

Only `/v0/pipes/*` needs to be public; the root `Caddyfile` sends nothing else there.

### Supported pipes

`api_kpis`, `api_active_visitors`, `api_top_pages`, `api_top_sources`, `api_top_locations` (and their `*_v2` variants). Unimplemented pipes return an empty result set so the dashboard degrades gracefully.

## Configuration

Set via environment variables (defaults shown):

| Variable                    | Default                   | Description                          |
| --------------------------- | ------------------------- | ------------------------------------ |
| `PORT`                      | `3000`                    | Listen port.                         |
| `LISTEN_HOST`               | `0.0.0.0`                 | Listen address.                      |
| `CLICKHOUSE_URL`            | `http://clickhouse:8123`  | ClickHouse HTTP endpoint.            |
| `CLICKHOUSE_DATABASE`       | `ghost_analytics`         | Database holding the analytics tables. |
| `CLICKHOUSE_USER`           | `default`                 | ClickHouse user.                     |
| `CLICKHOUSE_PASSWORD`       | _(empty)_                 | That user's password.                |
| `TINYBIRD_EVENTS_DATASOURCE`| `analytics_events`        | Datasource name for ingested events. |
| `TRUST_PROXY`               | `true`                    | Trust `X-Forwarded-*` from Caddy.    |
| `TRAFFIC_STATS_INGEST_TOKEN`| _(required)_              | Bearer token `POST /v0/events` requires; `traffic-analytics`' `TINYBIRD_TRACKER_TOKEN`. At least 32 characters. |
| `TINYBIRD_ADMIN_TOKEN`      | _(required, or the next)_ | Secret Ghost signs stats tokens with (its `tinybird__adminToken`). At least 32 characters. |
| `TINYBIRD_WORKSPACE_ID`     | `DUMMY_WORKSPACE_ID`      | The workspace those tokens name (Ghost's `tinybird__workspaceId`). |
| `STATS_MASTER_KEY`          | _(unset)_                 | Several sites on one `traffic-stats`: each workspace's secret is derived from this (below). At least 32 characters. |
| `STATS_SITE_LOOKUP_URL`     | _(unset)_                 | With `STATS_MASTER_KEY`: where to look up the one site a workspace may read (below). |
| `STATS_SITE_LOOKUP_TOKEN`   | _(unset)_                 | Bearer token sent to that lookup.    |
| `STATS_ALLOW_LEGACY_DUMMY_TOKEN` | `false`              | `true` also accepts tokens signed with `DUMMY_TOKEN`, whatever workspace they name, for moving sites off that value. |

The service refuses to start without a signing secret (`TINYBIRD_ADMIN_TOKEN` or `STATS_MASTER_KEY`) and an ingest token, or with `DUMMY_TOKEN` as the secret unless `STATS_ALLOW_LEGACY_DUMMY_TOKEN=true`.

### Stats tokens

Ghost signs each stats request as an HS256 JWT with `workspace_id`, an expiry and one `PIPES:READ` scope per pipe, each naming the site's `site_uuid` in its fixed params. `traffic-stats` accepts a token only when:

- it is HS256, signed with the workspace's secret, and has an expiry no more than a day ahead;
- it names the pipe being asked for;
- every scope names the same `site_uuid`, which is the only site the request reads.

**One site** (the root `docker-compose.yaml`): Ghost's `tinybird__adminToken` and `TINYBIRD_ADMIN_TOKEN` are the same secret.

**Several sites on one `traffic-stats`**: give each Ghost its own `tinybird__workspaceId` (letters, digits and `_`, at most 64) and, as `tinybird__adminToken`, the key derived for it from `STATS_MASTER_KEY`:

```
gs1_ + base64url(HMAC-SHA256(STATS_MASTER_KEY, "ghost-stats-v1:" + workspace_id))
```

With `STATS_SITE_LOOKUP_URL` set, a derived-key token must also name the right site: `traffic-stats` asks `GET <STATS_SITE_LOOKUP_URL>/<workspace_id>` (with `STATS_SITE_LOOKUP_TOKEN` as a Bearer token), expects `{"siteUuid": "…"}` or a `404`, and refuses a token naming any other `site_uuid`. Answers are cached for a minute; while the lookup is unreachable, requests get `503`.

## Development

```bash
npm ci
npm run dev      # tsx watch on src/server.ts
npm test         # unit tests
npm run build    # tsc -> dist/
npm start        # node dist/server.js
```

The service is built and run as part of the root `docker-compose.yaml` (`build: ./traffic-stats`); you normally don't run it directly.

`npm test` runs the unit tests (Node's test runner, through `tsx`); CI (`.github/workflows/ci.yml`) runs them, type-checks and builds it, and builds its image.
