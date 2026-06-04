# CoolGhost

Fully self-hosted [Ghost 6](https://ghost.org) with self-hosted analytics, packaged as a single Docker Compose stack for [Coolify](https://coolify.io) (or plain Docker Compose).

## Why

Ghost 6 ships a great analytics dashboard (Top content, Sources, Locations, visitor KPIs), but it expects [Tinybird](https://www.tinybird.co) — a cloud-hosted ClickHouse service — for storage and queries. The official [TryGhost/ghost-docker](https://github.com/TryGhost/ghost-docker) setup still relies on that third‑party cloud dependency, which is awkward to wire up in Coolify and means the instance isn't *truly* self-hosted.

CoolGhost removes the cloud dependency by running **ClickHouse locally** and mapping the Tinybird ingest/query API that Ghost expects onto that local instance — so analytics work end to end with nothing leaving your server.

## Architecture

```
Browser ──▶ Caddy :3000 ──┬─▶ Ghost  :2368        (CMS + Admin)
                          ├─▶ traffic-analytics    (/.ghost/analytics/*  — official ingest)
                          └─▶ traffic-stats        (/.ghost/stats/*      — Tinybird-compatible query API)
                                   │
                                   ▼
                              ClickHouse :8123  ◀── MySQL :3306 (Ghost content)
```

| Service             | Role                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `caddy`             | Reverse proxy / single public entrypoint on port `3000`.                              |
| `ghost`             | Ghost 6 CMS and Admin.                                                                 |
| `mysql`             | Ghost's primary database.                                                             |
| `clickhouse`        | Self-hosted analytics store (replaces Tinybird Cloud).                                 |
| `traffic-analytics` | Official Ghost ingest service; forwards page hits to `traffic-stats`.                  |
| `traffic-stats`     | Custom Fastify service that speaks Ghost's Tinybird API and queries ClickHouse. See [`traffic-stats/README.md`](traffic-stats/README.md). |

## Quick deployment (Coolify)

1. **Create a [Mailgun](https://www.mailgun.com) account** (or have your SMTP credentials ready) — Ghost needs email for staff invites, password resets, and member magic links.
2. In the Coolify UI, **add a new resource → Docker Compose** and point it at this repository (`https://github.com/kaperkunde/CoolGhost.git`) — see [Coolify's Docker Compose docs](https://coolify.io/docs/applications/docker-compose).
3. Set the **environment variables** (Coolify → your resource → Environment Variables):

   | Variable                | Required | Description                                                            |
   | ----------------------- | -------- | ---------------------------------------------------------------------- |
   | `SERVICE_URL_CADDY`     | ✅        | Public URL of your Ghost site, e.g. `https://blog.example.com`.        |
   | `SERVICE_HOST_CADDY`    | ✅        | Bare hostname of the URL above, e.g. `blog.example.com` (see Analytics notes). |
   | `SERVICE_USER_MYSQL`    | ✅        | MySQL user for Ghost.                                                  |
   | `SERVICE_PASSWORD_MYSQL`| ✅        | MySQL password for Ghost.                                              |
   | `SERVICE_PASSWORD_MYSQLROOT` | ✅   | MySQL root password.                                                   |
   | `MAIL_FROM`             | ✅        | Default from address, e.g. `Ghost <noreply@blog.example.com>`.         |
   | `MAIL_OPTIONS_AUTH_USER`| ✅        | Mailgun SMTP username.                                                 |
   | `MAIL_OPTIONS_AUTH_PASS`| ✅        | Mailgun SMTP password.                                                 |
   | `MAIL_OPTIONS_HOST`     | ✅        | SMTP host, e.g. `smtp.eu.mailgun.org`.                                 |
   | `MAIL_OPTIONS_PORT`     |          | SMTP port (default `465`).                                             |
   | `MAIL_OPTIONS_SECURE`   |          | Use TLS (default `true`).                                              |
   | `MAIL_OPTIONS_SERVICE`  |          | Mail service name (default `Mailgun`).                                 |
   | `GHOST_DATABASE`        |          | Database name (default `ghost`).                                       |
   | `CADDY_LOG_OUTPUT`      |          | Caddy access log target (default `discard`).                           |

4. **Launch** — and you're good to go. Open `SERVICE_URL_CADDY` and finish setup at `/ghost`.

## Local deployment

```bash
git clone https://github.com/kaperkunde/CoolGhost.git
cd CoolGhost
cp .env.example .env          # defaults already target http://localhost:3000
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d
```

Then open **http://localhost:3000** for the site and **http://localhost:3000/ghost** for Admin (and analytics). The `docker-compose.local.yaml` override publishes Caddy on host port `3000` and runs Ghost in development mode (see below).

## Analytics notes

Ghost makes analytics requests two ways, and both must reach `traffic-stats` through Caddy:

- **Browser-side** (Sources, Locations) hit the public URL directly — no special handling needed.
- **Server-side** (Top content) go through Ghost's SSRF-protected HTTP client, which rejects single-label hostnames (like `caddy`) and private Docker IPs. The only production-safe bypass is making the request host **string-match the site URL host**.

That's why:

- In **production**, `tinybird__stats__endpoint` points at the public URL and `SERVICE_HOST_CADDY` is added as a Caddy network alias, so the public hostname resolves to Caddy *inside* the Docker network.
- **Locally**, `localhost` can't be routed to Caddy from inside the container, so the override runs Ghost with `NODE_ENV=development` (which skips the SSRF checks) and points the server-side endpoint straight at `http://caddy:3000`.

The ClickHouse schema (events table + materialized view) is created automatically on first boot from [`clickhouse/init/01_schema.sql`](clickhouse/init/01_schema.sql).

## License

[MIT](LICENSE)
