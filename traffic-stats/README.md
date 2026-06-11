# traffic-stats

A small [Fastify](https://fastify.dev) service that emulates the [Tinybird](https://www.tinybird.co) query API that Ghost 6 expects for its analytics dashboard, backed by a **self-hosted ClickHouse** instead of Tinybird Cloud.

It lets the Ghost Admin "Analytics" views (visitor KPIs, Top content, Sources, Locations, active visitors) work entirely within your own infrastructure.

## How it fits in

```
Ghost Admin ──▶ Traefik /.ghost/stats/* ──▶ traffic-stats ──▶ ClickHouse
```

- Ghost sends Tinybird-style pipe requests (`/v0/pipes/<name>.json`) with a signed JWT.
- `traffic-stats` verifies the token, maps the pipe to a ClickHouse query, and returns the Tinybird-compatible JSON envelope (`{meta, data, rows, statistics}`).
- Ingest is handled separately by the official `traffic-analytics` service, which forwards page hits to `traffic-stats`' `/v0/events` and on into ClickHouse.

## API

| Route                       | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `GET /v0/health`            | Liveness check (`{"status":"ok"}`).                                      |
| `GET /v0/pipes/<name>.json` | Run a named pipe. Auth via `Authorization: Bearer <jwt>` or `?token=`.   |
| `POST /v0/events`           | Ingest endpoint (used by `traffic-analytics`).                           |

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
| `TINYBIRD_EVENTS_DATASOURCE`| `analytics_events`        | Datasource name for ingested events. |
| `TRUST_PROXY`               | `true`                    | Trust `X-Forwarded-*` from Traefik.  |

> JWTs are accepted using Ghost's local dummy workspace/token (`DUMMY_TOKEN` / `DUMMY_WORKSPACE_ID`); the `site_uuid` is taken from the token's fixed params so each request is scoped to one site.

## Development

```bash
npm install
npm run dev      # tsx watch on src/server.ts
npm run build    # tsc -> dist/
npm start        # node dist/server.js
```

The service is built and run as part of `docker-compose.analytics.yaml`; you normally don't run it directly.
