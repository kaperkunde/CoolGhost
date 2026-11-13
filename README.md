# CoolGhost

Fully self-hosted [Ghost 6](https://ghost.org) with self-hosted analytics, packaged as a single Docker Compose stack for [Coolify](https://coolify.io) (or plain Docker Compose).

## Why

Ghost 6 ships a great analytics dashboard (Top content, Sources, Locations, visitor KPIs), but it expects [Tinybird](https://www.tinybird.co) — a cloud-hosted ClickHouse service — for storage and queries. The official [TryGhost/ghost-docker](https://github.com/TryGhost/ghost-docker) setup still relies on that third‑party cloud dependency, which is awkward to wire up in Coolify and means the instance isn't *truly* self-hosted.

CoolGhost removes the cloud dependency by running **ClickHouse locally** and mapping the Tinybird ingest/query API that Ghost expects onto that local instance — so analytics work end to end with nothing leaving your server.

## Architecture

```
Browser ──▶ Caddy :80 ──┬─▶ ghost :2368           (site and Admin)
                        ├─▶ traffic-analytics :3000 (/.ghost/analytics/*  — official ingest)
                        └─▶ traffic-stats :3000     (/.ghost/stats/*      — Tinybird-compatible query API)

ghost ──▶ mysql :3306                  (posts, members, settings)
traffic-analytics ──▶ traffic-stats /v0/events ──▶ clickhouse :8123   (page hits)
```

| Service             | Image                                    | Role                                                                                  |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `caddy`             | built from [`caddy/`](caddy/)            | The one public entry point. Routes by path to the three services behind it.           |
| `ghost`             | `ghost:6.72.0-alpine` (pinned by digest) | Ghost 6, the site and Admin.                                                          |
| `mysql`             | `mysql:8` (pinned by digest)             | Ghost's database.                                                                     |
| `clickhouse`        | built from [`clickhouse/`](clickhouse/)  | The analytics store (replaces Tinybird Cloud), sized for a small server.              |
| `traffic-analytics` | `ghost/traffic-analytics:1.0.497` (pinned by digest) | Ghost's official ingest service; forwards page hits to `traffic-stats`.   |
| `traffic-stats`     | built from [`traffic-stats/`](traffic-stats/) | A small Fastify service that speaks Ghost's Tinybird API and queries ClickHouse. See [`traffic-stats/README.md`](traffic-stats/README.md). |

Only Caddy is meant to be reachable from outside; nothing else publishes a port. Every service has a healthcheck, `ghost` waits for `mysql`, `caddy` for `ghost`, and the analytics services for each other in order. Data lives in three named volumes: `ghost-content-data`, `ghost-mysql-data` and `ghost-clickhouse-data`.

## Prerequisites

- A server with Docker, and [Coolify](https://coolify.io) on it if you deploy that way. **2 GB of RAM** is enough for a small site: ClickHouse is configured to stay small ([`clickhouse/config.d/low-memory.xml`](clickhouse/config.d/low-memory.xml)).
- An **amd64** (x86-64) server. `ghost/traffic-analytics` is published for `linux/amd64` only; on ARM it runs under emulation if the host has it, and not at all otherwise.
- A domain (or subdomain) pointing at the server.
- **SMTP credentials** for transactional mail, e.g. a [Mailgun](https://www.mailgun.com) account. Ghost starts without them, but staff invites, password resets and member sign-in links need mail. (Newsletters, Ghost's bulk email, are configured separately in Ghost and are not set up by this stack.)

## Deploying on Coolify

1. In Coolify, **add a new resource → Public Repository**, and give it `https://github.com/kaperkunde/CoolGhost`, branch `main`.
2. Choose the **Docker Compose** build pack, with `/docker-compose.yaml` as the compose file. (`docker-compose.local.yaml` is for running it on your own machine; leave it out.) See [Coolify's Docker Compose docs](https://coolify.io/docs/knowledge-base/docker/compose).
3. Under the resource's services, give **`caddy`** your domain, e.g. `https://blog.example.com`. That is the only service that needs one: Ghost's Admin (`/ghost`), the analytics ingest (`/.ghost/analytics`) and the stats endpoint (`/.ghost/stats`) are all paths on the same domain, routed by Caddy. Coolify puts its own proxy (Traefik) and the certificate in front, and forwards to Caddy's port 80.
4. Set the **environment variables**. Coolify generates the `SERVICE_*` ones when it reads the compose file (its magic environment variables), so you only fill in mail:

   | Variable                      | Set by        | Description                                                                 |
   | ----------------------------- | ------------- | --------------------------------------------------------------------------- |
   | `SERVICE_URL_CADDY`           | Coolify       | Public URL of the site, from the domain you gave `caddy`. Ghost's `url`.    |
   | `SERVICE_USER_MYSQL`          | Coolify       | MySQL user for Ghost.                                                       |
   | `SERVICE_PASSWORD_MYSQL`      | Coolify       | That user's password.                                                       |
   | `SERVICE_PASSWORD_MYSQLROOT`  | Coolify       | MySQL root password.                                                        |
   | `SERVICE_PASSWORD_CLICKHOUSE` | Coolify       | Password of ClickHouse's `default` user, read by `clickhouse` and `traffic-stats`. |
   | `MAIL_FROM`                   | you           | From address, e.g. `Ghost <noreply@blog.example.com>`.                      |
   | `MAIL_OPTIONS_HOST`           | you           | SMTP host, e.g. `smtp.eu.mailgun.org`.                                      |
   | `MAIL_OPTIONS_AUTH_USER`      | you           | SMTP user name.                                                             |
   | `MAIL_OPTIONS_AUTH_PASS`      | you           | SMTP password.                                                              |
   | `MAIL_OPTIONS_PORT`           | optional      | SMTP port (default `465`).                                                  |
   | `MAIL_OPTIONS_SECURE`         | optional      | Connect with TLS (default `true`; use `false` with port `587`).             |
   | `MAIL_OPTIONS_SERVICE`        | optional      | Nodemailer service name (default `Mailgun`).                                |
   | `GHOST_DATABASE`              | optional      | Database name (default `ghost`).                                            |
   | `MYSQL_HOST`, `MYSQL_PORT`    | optional      | Point Ghost at another MySQL (default `mysql`, `3306`). The `mysql` service still runs. |
   | `LABS_PUBLIC_API`             | optional      | Ghost's `labs.publicAPI` (default `false`).                                 |
   | `CADDY_LOG_OUTPUT`            | optional      | Caddy's access log: `discard` (default), `stdout` or `stderr`.              |
   | `CADDY_PORT`                  | optional      | Port Caddy listens on inside the network (default `80`).                    |
   | `GHOST_VERSION`, `MYSQL_VERSION`, `TRAFFIC_ANALYTICS_VERSION` | optional | Image tags, to upgrade or hold back (see [Upgrading](#upgrading)). |

   MySQL reads its credentials only when its volume is first created: change them once the site is running and Ghost can no longer sign in, so keep them as Coolify generated them. (ClickHouse's password is applied on every start.)

5. **Deploy.** The first start takes a few minutes: Ghost creates its database before it reports healthy, and Caddy waits for it. Then open your domain and set up your site at `/ghost`.

### How the analytics are wired

Ghost's analytics talk to Tinybird's API; here every piece of that API is on your own domain:

- **Page hits.** Ghost's tracker script in the visitor's browser posts each hit to `tinybird__tracker__endpoint`, `<your URL>/.ghost/analytics/api/v1/page_hit`. Caddy sends it to `traffic-analytics`, which enriches it and forwards it (`PROXY_TARGET`) to `traffic-stats`' `/v0/events`, which writes it to ClickHouse.
- **The dashboard.** Ghost Admin in your browser queries `tinybird__stats__endpointBrowser`, `<your URL>/.ghost/stats`, and the Ghost server queries `tinybird__stats__endpoint`, the same URL, for Top content. Caddy sends both to `traffic-stats`, which runs the matching ClickHouse query.
- **No Tinybird account.** Ghost signs its stats requests with `tinybird__adminToken`, and `traffic-stats` checks them with the same fixed value (`DUMMY_TOKEN`, `DUMMY_WORKSPACE_ID`). There is nothing to sign up for.

All of this is set in `docker-compose.yaml` from `SERVICE_URL_CADDY`; there is nothing to configure. Two things follow from it:

- The Ghost server reaches its own stats through the **public URL**: Ghost refuses requests to private addresses in production, so it cannot be pointed at `traffic-stats` inside the network. The server must be able to reach its own domain, which on Coolify it normally can. If Top content stays empty while visitors are counted, check that first (see [Troubleshooting](#troubleshooting)).
- Because the signing token is the fixed value above, the stats endpoint does not keep your **aggregate** analytics (visitor counts, top pages, sources, countries) private from someone who knows how to ask for them. It holds no content, member data or credentials.

The ClickHouse schema (an events table and a materialized view) is created on the first start from [`clickhouse/init/01_schema.sql`](clickhouse/init/01_schema.sql). ClickHouse's own `system.*_log` tables, which stock ClickHouse keeps for ever and which reach gigabytes long before a small site's page hits do, are switched off, and a volume created before that has them dropped on its next start ([`clickhouse/config.d/system-logs.xml`](clickhouse/config.d/system-logs.xml)). Analytics are kept without a time limit.

## Running it locally

With Docker and Docker Compose v2:

```bash
git clone https://github.com/kaperkunde/CoolGhost.git
cd CoolGhost
cp .env.example .env          # defaults target http://localhost:3000
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d --build
```

Open **http://localhost:3000** for the site and **http://localhost:3000/ghost** for Admin and its analytics. `docker compose ... ps` shows each service's health while it starts.

`docker-compose.local.yaml` publishes Caddy on host port `CADDY_PORT` (3000) and runs Ghost with `NODE_ENV=development`. That is what lets the Ghost server reach the stats API inside the network: from inside the container `localhost` is not Caddy, and only development mode lets Ghost call a private address (`http://caddy:3000`) instead. Don't use the local override on a server.

## Upgrading

**Ghost.** The image is pinned to a version and digest in `docker-compose.yaml`. To move to another release, set `GHOST_VERSION` to a tag from [Docker Hub](https://hub.docker.com/_/ghost/tags), e.g. `6.73.0-alpine` (append `@sha256:…` to pin the digest too), and redeploy. Ghost migrates its database on start, and a migrated database cannot go back to the older version, so take a [backup](#backups) first, and read the [changelog](https://ghost.org/changelog/) before a major version. Unset `GHOST_VERSION` to go back to the version this repository pins.

**The rest of the stack.** `MYSQL_VERSION` and `TRAFFIC_ANALYTICS_VERSION` work the same way. Caddy, ClickHouse and Node for `traffic-stats` are pinned in their Dockerfiles, so they move with this repository: redeploy after pulling (on Coolify, redeploy the resource) and the images are rebuilt.

## Backups

Three named volumes hold everything (Coolify prefixes their names with the resource's ID; `docker volume ls` shows them):

| Volume                  | Holds                                                         |
| ----------------------- | ------------------------------------------------------------- |
| `ghost-mysql-data`      | Ghost's database: posts, pages, members, settings. **Essential.** |
| `ghost-content-data`    | `/var/lib/ghost/content`: uploaded images and files, themes.  |
| `ghost-clickhouse-data` | The analytics. Optional: Ghost runs without its history.      |

Dump the database while it runs, as a consistent snapshot (from the checkout, or with `docker exec <mysql container>` in place of `docker compose exec mysql` on Coolify):

```bash
docker compose exec -T mysql sh -c \
  'exec mysqldump --single-transaction --no-tablespaces -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  > ghost-$(date +%F).sql
```

and restore it, with `ghost` stopped and `mysql` running, with:

```bash
docker compose exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < ghost-2026-01-01.sql
```

Copy the content volume with any container that can read it, e.g.:

```bash
docker run --rm -v <volume name>:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/ghost-content-$(date +%F).tgz -C /data .
```

For ClickHouse, copy its volume the same way with the `clickhouse` service stopped. Ghost Admin's **Settings → Import/Export** also exports the content as JSON and the members as CSV, which is a useful extra copy but not a full backup (no images or themes).

## Troubleshooting

- **The site answers with an error for a few minutes after deploying.** Ghost is still creating or migrating its database; its healthcheck allows two minutes before it counts failures, and Caddy only starts once Ghost is healthy. Watch `ghost`'s logs.
- **Ghost never gets healthy and logs `ER_ACCESS_DENIED_ERROR`.** The MySQL credentials changed after the volume was created; MySQL keeps the ones it was first started with. Put the old values back, or change the user's password inside MySQL.
- **Staff invites, password resets or sign-in links never arrive.** Mail is not set, or the SMTP settings are wrong: Ghost logs the SMTP error when it tries to send. Port `465` needs `MAIL_OPTIONS_SECURE=true`, port `587` needs `false`.
- **Too many redirects.** Ghost's `url` is `https://` but it is told the request came over plain HTTP. Coolify's proxy sends `X-Forwarded-Proto`, and Caddy passes it on from private addresses (`trusted_proxies` in the [`Caddyfile`](caddy/Caddyfile)); a proxy in front of Coolify must send it too.
- **No visitors at all in analytics.** Check that `traffic-analytics`, `traffic-stats` and `clickhouse` are healthy, and that `<your URL>/.ghost/stats/v0/health` answers `{"status":"ok"}` (a `503` means `traffic-stats` cannot reach ClickHouse). Visits from a browser with an ad or tracker blocker are not counted.
- **Visitors are counted but Top content is empty.** The Ghost server cannot reach its own public URL (see [How the analytics are wired](#how-the-analytics-are-wired)). From the `ghost` container, `wget -qO- <your URL>/.ghost/stats/v0/health` should answer `{"status":"ok"}`.
- **`clickhouse` exits, or the host runs out of memory.** ClickHouse is limited to a small footprint, but the whole stack still wants about 2 GB. Its file log (warnings and errors) is in the container at `/var/log/clickhouse-server/`.
- **Analytics tables are missing.** The schema is created only when ClickHouse's volume is empty. If that first start failed partway, remove the `ghost-clickhouse-data` volume (losing any analytics in it) and start again.
- **`traffic-analytics` fails with `exec format error`.** The server is not amd64 (see [Prerequisites](#prerequisites)).

## License

[MIT](LICENSE)
