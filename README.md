# CoolGhost — shared infrastructure

This branch splits CoolGhost into **shared** and **per-site** compose stacks for running multiple Ghost blogs on one Coolify server.

For the full project overview, architecture, and analytics behaviour, see the [`main` branch README](https://github.com/kaperkunde/CoolGhost/blob/main/README.md).

## What to deploy

| Resource       | Compose file                    | How many                    |
| -------------- | ------------------------------- | --------------------------- |
| MySQL          | `docker-compose.mysql.yaml`     | Once per server             |
| Analytics      | `docker-compose.analytics.yaml` | Once per server             |
| GhostHost API  | `docker-compose.api.yaml`       | Once per server             |
| Duplicati      | `docker-compose.duplicati.yaml` | Once per server             |
| Traefik routes | `traefik.coolghost.yaml`        | Once per server (see below) |
| Ghost site     | `docker-compose.yaml`           | One per blog                |

## Coolify setup

Deploy each compose file as a separate Coolify Docker Compose resource.

On **every** resource — MySQL, analytics, GhostHost API, and each blog — open **Advanced** and enable **Connect to Predefined Network**. Without this, stacks cannot reach each other on the shared `coolify` network.

Give each shared stack a **custom name** in Advanced (e.g. `mysql-ghost` for MySQL, `ghost-analytics` for analytics, `ghosthost-api` for the API). Coolify uses these names for cross-stack DNS — the hostname is the custom name with a **trailing dash**, e.g. `mysql-ghost-`.

### 1. MySQL (`docker-compose.mysql.yaml`)

Set `SERVICE_USER_MYSQL`, `SERVICE_PASSWORD_MYSQL`, `SERVICE_PASSWORD_MYSQLROOT`, and an initial `GHOST_DATABASE` (only used to bootstrap the container; each blog gets its own database later).

### 2. Analytics (`docker-compose.analytics.yaml`)

Deploy once with custom name **`ghost-analytics`**. No extra configuration beyond the shared env vars Coolify provides.

### 3. Traefik routes (once per server)

Coolify already runs Traefik (`coolify-proxy`) on port 443. Each Ghost blog needs `/.ghost/stats` and `/.ghost/analytics` routed to the **shared** analytics stack on whatever domain Coolify assigns.

1. Confirm analytics is reachable from the proxy:

   ```bash
   docker exec coolify-proxy wget -qO- http://traffic-stats-ghost-analytics-:3000/v0/health
   docker exec coolify-proxy wget -qO- http://traffic-analytics-ghost-analytics-:3000/
   ```

   If those fail, check that the analytics stack uses custom name `ghost-analytics` and is connected to the predefined network. Adjust the hostnames in `traefik.coolghost.yaml` if you chose a different custom name (`<service>-<custom-name>-`).

2. Open **Server → Proxy → Dynamic Configurations → Add**.

3. Paste the contents of [`traefik.coolghost.yaml`](traefik.coolghost.yaml). Update the two service URLs if your stack custom name is not `ghost-analytics`.

4. Save. Traefik reloads automatically — no proxy restart needed.

The config registers four routers (HTTP + HTTPS) with **priority 2000** so they win over each blog's default `Host(...)` router for paths under `/.ghost/stats` and `/.ghost/analytics`. Ghost itself is still routed by Coolify per deployment.

### 4. GhostHost API (`docker-compose.api.yaml`)

Deploy once per server with custom name **`ghosthost-api`**. This small HTTP service lets [GhostHost](https://github.com/kaperkunde/GhostHost) automate blog deployments: when a customer provisions a new site, GhostHost calls the API to create that site's MySQL database and user on the shared MySQL stack.

Set these environment variables on the Coolify resource:

| Variable              | Notes                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------- |
| `API_TOKEN`           | Shared secret; GhostHost sends it as `Authorization: Bearer …`                        |
| `MYSQL_HOST`          | Shared MySQL hostname, e.g. `mysql-ghost-`                                            |
| `MYSQL_PORT`          | Optional; defaults to `3306`                                                          |
| `MYSQL_ROOT_PASSWORD` | Root password for the shared MySQL stack (falls back to `SERVICE_PASSWORD_MYSQLROOT`) |

Keep the API on the internal Coolify network only — do not expose it on a public domain unless you add additional access controls.

`GET /health` verifies MySQL connectivity via `MYSQL_HOST` / `MYSQL_ROOT_PASSWORD`. The container healthcheck uses the same endpoint, so Coolify shows **unhealthy** when MySQL is unreachable. GhostHost admin checks `/health` when saving server API settings. If it fails, fix `MYSQL_HOST` (Coolify custom name + trailing dash, e.g. `mysql-ghost-`), `MYSQL_ROOT_PASSWORD`, and predefined-network connectivity.

**Endpoint:** `POST /v1/provision/mysql-user`

Request body (JSON):

```json
{
  "username": "site_db_name",
  "password": "generated-password"
}
```

`username` must contain only letters, numbers, and underscores. The API creates a database with the same name, a MySQL user `username`@`%`, and grants full privileges on that database. The operation is idempotent.

Success response:

```json
{
  "ok": true,
  "username": "site_db_name",
  "database": "site_db_name",
  "createdUser": true,
  "updatedPassword": false,
  "createdDatabase": true
}
```

Use the returned `username` and `database` for `SERVICE_USER_MYSQL`, `GHOST_DATABASE`, and the supplied password for `SERVICE_PASSWORD_MYSQL` on the blog resource.

#### Export / restore (`/v1/data/*`)

The API also executes blog exports and restores on behalf of GhostHost. This
requires extra mounts and env (already wired in `docker-compose.shared.yaml`;
`docker-compose.api.yaml` carries the same wiring with overridable defaults):

| Variable / mount                      | Notes                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/var/lib/docker/volumes:/local/volumes` | Read/write access to each blog's `ghost-content-data` volume                             |
| `${STAGING_HOST_DIR}:/staging`        | Export artifacts, restore uploads, job state. Mount the same host dir into duplicati; nothing else needs it |
| `STAGING_DIR`                         | In-container staging path (`/staging`)                                                      |
| `DUPLICATI_URL` / `DUPLICATI_PASSWORD` | Duplicati web service (e.g. `http://duplicati:8200`) + `SERVICE_PASSWORD_DUPLICATI`        |
| `DUPLICATI_STAGING_DIR`               | Staging path as seen inside the duplicati container (defaults to `STAGING_DIR`)             |
| `ARTIFACT_TTL_HOURS`                  | Optional; export artifacts/uploads/job dirs are swept after this TTL (default 24)           |
| `MAX_UPLOAD_BYTES`                    | Optional; largest restore archive accepted by the uploads route (default 4 GiB)             |
| `GHOST_CONTENT_UID` / `GHOST_CONTENT_GID` | Optional; ownership applied to restored content (default 1000)                          |

Endpoints (all require the bearer token): `GET /v1/data/backups` lists
Duplicati jobs and their restorable versions (a job whose versions could not
be listed carries `versionsError` instead of pretending to be empty); `POST /v1/data/spots/:spot/export`
and `POST /v1/data/spots/:spot/restore` start async jobs polled via
`GET /v1/data/jobs/:id`. Exports package `info.json` + `db.sql` + `content/`
into one `.tar.gz` under `staging/artifacts/`, described by
`GET /v1/data/spots/:spot/artifact` and streamed by
`GET /v1/data/spots/:spot/artifact/download`. Restore archives are received
as a raw request body by `POST /v1/data/spots/:spot/uploads`, which returns
the `uploadRelPath` to pass as the `upload` restore source. Restores expect
the caller to stop the Ghost container first, snapshot current data as an
undo artifact, then replace the content volume and re-import the database.
When `STAGING_DIR` or the Duplicati env is missing the routes degrade
gracefully (503 / empty list) instead of failing at boot — with `DUPLICATI_URL`
unset, `GET /v1/data/backups` answers `{"configured": false, "backups": []}`
and GhostHost shows "Automatic backups are not configured on this server yet".

##### Duplicati (`docker-compose.duplicati.yaml`)

Backup-sourced listing, export and restore need a duplicati alongside the api.
Deploy `docker-compose.duplicati.yaml` once per server (the all-in-one
development stack, `docker-compose.shared.yaml`, has its own copy of the
service — deploy exactly one of the two on a host). Give it a custom name,
e.g. `duplicati-ghost`, and connect it to the predefined network.

`DUPLICATI_URL` on the **api** resource must be the address the api container
can reach it at. On Coolify that is the cross-stack hostname — the custom name
with a trailing dash, e.g. `http://duplicati-ghost-:8200` — not
`http://duplicati:8200`, which only resolves inside a single compose stack.
A wrong or unreachable value is reported: since every Duplicati call is
bounded and wrapped, `GET /v1/data/backups` answers 502 with the underlying
reason (`getaddrinfo ENOTFOUND …`, `timed out after 15000ms`, …) rather than
hanging or returning a bare 500.

**Both resources must mount the same host directory as `/staging`.** The api
creates a job directory in it and Duplicati restores into that same directory;
they are the two halves of one hand-off. Coolify keeps environment variables
per resource, so `STAGING_HOST_DIR` set on only one of them leaves each
container with its own private `/staging` — Duplicati then restores into a
directory the api cannot see, and every backup-sourced export fails with
*"Duplicati reported the restore finished, but nothing appeared in …"*. Set
`STAGING_HOST_DIR` to the same value on the api and duplicati resources (or
leave it unset on both, so both take the `/root/data/ghosthost-staging`
default), and set the api's `DUPLICATI_STAGING_DIR` to the path duplicati has
it mounted at (`/staging`). The api probes the mount before starting a restore
and fails immediately, with both paths named, when the two do not match.

The staging dir is local to each server: every server runs its own
mysql + api + duplicati stack, and the GhostHost app talks to the api of
whichever server hosts a blog. Nothing outside the stack mounts it.

#### Redirect domains (`/v1/proxy/*`)

The API writes per-redirect Traefik dynamic configs into Coolify's
file-provider directory so extra addresses 301 to a blog's canonical domain,
with Let's Encrypt certificates issued through the proxy's standard
`letsencrypt` resolver. Wiring (in `docker-compose.api.yaml`):

| Variable / mount                                    | Notes                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `${PROXY_DYNAMIC_HOST_DIR:-/data/coolify/proxy/dynamic}:/proxy-dynamic` | Coolify's Traefik dynamic-config dir; hot-reloaded |
| `PROXY_DYNAMIC_DIR`                                 | In-container path (`/proxy-dynamic`); unset ⇒ routes respond 503   |
| `TRAEFIK_CERT_RESOLVER`                             | Optional; resolver name in the generated proxy config (default `letsencrypt`) |

`PUT /v1/proxy/redirects/:key` with `{ "redirectDomain": "...", "targetDomain": "..." }`
writes `plekje-redirect-<key>.yaml` atomically; `DELETE /v1/proxy/redirects/:key`
removes it (idempotent). Router/middleware/service names are `<key>`-prefixed
because Traefik's file provider shares one namespace across all dynamic files.

> **Note:** servers deployed before this feature need a one-time redeploy of
> the `ghosthost-api` stack to pick up the `/proxy-dynamic` mount.

#### Content storage (`/v1/storage/*`)

`GET /v1/storage/content` walks every `<application-uuid>_ghost-content-data`
volume under `VOLUMES_DIR` (the `/var/lib/docker/volumes` mount the data
routes already use) and reports the apparent size and file count of each
blog's Ghost content directory:

```json
{
  "ok": true,
  "volumes": [
    {
      "applicationUuid": "abc123",
      "volumeName": "abc123_ghost-content-data",
      "sizeBytes": 734003200,
      "fileCount": 1842,
      "partial": false
    }
  ]
}
```

Orphaned volumes (no application any more) are included so the GhostHost
admin cleanup view can surface them. `partial` is `true` when part of a tree
could not be read. The route responds 503 when the volumes mount is missing.

`GET /v1/storage/databases` reports every blog database on the shared MySQL
(`information_schema` data + index length, table count) together with the
Ghost `site_uuid` setting read from it, which is the key the analytics rows
carry:

```json
{ "ok": true, "databases": [ { "name": "demo_plek_je", "sizeBytes": 52428800, "tableCount": 118, "siteUuid": "…" } ] }
```

`GET /v1/storage/analytics` reports ClickHouse usage: bytes on disk per table
in `CLICKHOUSE_DATABASE`, and an estimate per `site_uuid` (each table's bytes
apportioned by the site's share of its rows — the tables are shared, so this
cannot be exact). Site uuids that no database claims are the orphans. Wiring:

| Variable              | Notes                                                                        |
| --------------------- | ---------------------------------------------------------------------------- |
| `CLICKHOUSE_URL`      | HTTP interface of the analytics stack's ClickHouse; unset ⇒ route responds 503 |
| `CLICKHOUSE_DATABASE` | Defaults to `ghost_analytics`                                                |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | Optional; the stock stack uses the passwordless default user |

```json
{
  "ok": true,
  "tables": [ { "name": "analytics_events", "bytesOnDisk": 1048576, "rows": 12000 } ],
  "sites": [ { "siteUuid": "…", "rows": 9000, "estimatedBytes": 786432 } ]
}
```

Backup-sourced flows drive the Duplicati REST API (v2.1+ JWT auth: `POST
/api/v1/auth/login`, filesets, restore tasks). Duplicati holds the remote
target credentials, so local and remote versions restore identically. Verify
against your Duplicati version on first deploy — the endpoint shapes differ
across releases.

#### Duplicati backup jobs (configured automatically)

The `duplicati` image builds from `./duplicati` and provisions its own backup
jobs the first time it starts, so a fresh Coolify deploy comes up ready for the
API's backup, export and restore flows with nothing to click:

| Job                | Schedule           | Retention | Destination            | Sources                                            |
| ------------------ | ------------------ | --------- | ---------------------- | -------------------------------------------------- |
| `CoolGhost Hourly` | every hour         | 24 hours  | `file:///backups/hourly` | `/local/volumes/`, `/data/db_dumps/`             |
| `CoolGhost Daily`  | daily at 03:30     | 15 days   | `file:///backups/daily`  | the above plus `/data/coolify/`                  |

Both run `--run-script-before=/usr/local/bin/pre-backup.sh`, so every snapshot
contains a fresh `gzip`ped `mysqldump` of each site database taken alongside the
content volumes — which is exactly the pair (`/local/volumes/<uuid>_ghost-content-data/_data/`
and `/data/db_dumps/<database>.sql.gz`) that `GET /v1/data/backups` indexes and
that the restore flow pulls back out of a chosen version. Live MySQL and
ClickHouse data directories are excluded: a file-level copy of a running
database is not restorable, and the dumps carry that content properly.

The hourly job is also kicked off once at the end of provisioning, so there is a
restorable version immediately instead of an empty picker for the first hour.

Provisioning is idempotent. It records a marker at
`/config/coolghost-bootstrap.json` and skips any job whose name already exists,
so restarts and redeploys never duplicate jobs and jobs you have since edited or
deleted are left alone. To re-run it, delete that marker (or set
`DUPLICATI_BOOTSTRAP_FORCE=true`); progress and errors go to `docker logs` and to
`/config/coolghost-bootstrap.log`.

> **Keep `DUPLICATI_BACKUP_PASSPHRASE` safe.** Backups are AES-encrypted with it
> and cannot be restored without it — not on this host, not on a rebuilt one. It
> defaults to `SERVICE_PASSWORD_ENCRYPT`, which Coolify generates and persists in
> the stack's environment; copy it somewhere off the server. Changing it later
> makes existing backups unreadable.

Local disk alone does not survive losing the server, so point the daily job at
off-host storage by setting `DUPLICATI_DAILY_TARGET_URL` to any Duplicati backend
URL (S3, B2, SFTP, ...) before the first deploy. Duplicati holds those
credentials, so remote versions restore through the API exactly like local ones.

Overridable environment (all optional):

| Variable                                              | Default                            | Notes                                                     |
| ----------------------------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| `DUPLICATI_BOOTSTRAP_ENABLED`                         | `true`                             | `false` to configure jobs by hand in the web UI instead    |
| `DUPLICATI_BACKUP_PASSPHRASE`                         | `SERVICE_PASSWORD_ENCRYPT`         | Encryption passphrase; empty creates unencrypted backups   |
| `DUPLICATI_DAILY_TARGET_URL`                          | `file:///backups/daily`            | Any Duplicati backend URL — set this for off-host copies   |
| `DUPLICATI_HOURLY_TARGET_URL`                         | `file:///backups/hourly`           |                                                            |
| `DUPLICATI_DAILY_AT`                                  | `03:30`                            | Wall-clock time in the container `TZ`                      |
| `DUPLICATI_HOURLY_KEEP_TIME` / `DUPLICATI_DAILY_KEEP_TIME` | `24h` / `15D`                 | Duplicati timespans (`h` hours, `D` days — `m` is minutes) |
| `DUPLICATI_HOURLY_REPEAT` / `DUPLICATI_DAILY_REPEAT`  | `1h` / `1D`                        | Must be longer than 5 minutes                              |
| `DUPLICATI_HOURLY_SOURCES` / `DUPLICATI_DAILY_SOURCES` | see table above                   | Colon-separated absolute paths inside the container        |
| `DUPLICATI_BOOTSTRAP_EXCLUDES`                        | live DB dirs, `backingFsBlockDev`  | Colon-separated Duplicati filter expressions               |
| `DUPLICATI_BOOTSTRAP_RUN_NOW`                         | `true`                             | `false` to skip the initial hourly run                     |
| `DUPLICATI_HOURLY_NAME` / `DUPLICATI_DAILY_NAME`      | `CoolGhost Hourly` / `... Daily`   | Names are what the bootstrap matches on                    |

If you configure jobs by hand instead, keep the same contract: include
`/local/volumes` and `/data/db_dumps` in the sources and run
`--run-script-before=/usr/local/bin/pre-backup.sh`, or the API will not find the
data it needs to restore a site.

### 5. Each blog (`docker-compose.yaml`)

The blog stack is a single **Ghost** service. Assign the public domain to **ghost** (port **2368**) in Coolify.

Per-site environment variables (full list and descriptions are on [`main`](https://github.com/kaperkunde/CoolGhost/blob/main/README.md#quick-deployment-coolify)):

| Variable                 | Notes                                                           |
| ------------------------ | --------------------------------------------------------------- |
| `SERVICE_URL_GHOST`      | Public URL, e.g. `https://blog.example.com` (Coolify magic var) |
| `SERVICE_FQDN_GHOST`     | Bare hostname, e.g. `blog.example.com` (Coolify magic var)      |
| `MYSQL_HOST`             | Shared MySQL stack hostname, e.g. `mysql-ghost-`                |
| `GHOST_DATABASE`         | This site's database name                                       |
| `SERVICE_USER_MYSQL`     | This site's MySQL user                                          |
| `SERVICE_PASSWORD_MYSQL` | This site's MySQL password                                      |
| Mail vars                | `MAIL_FROM`, `MAIL_OPTIONS_*` — see main README                 |

Open `SERVICE_URL_GHOST` and finish setup at `/ghost`.

## MySQL: one database per blog

Each blog needs its **own** MySQL database and user.

**Automated (GhostHost):** deploy the GhostHost API (step 4 above). GhostHost provisions credentials via `POST /v1/provision/mysql-user` when deploying a new blog.

**Manual:** use [`scripts/createtable.sh`](scripts/createtable.sh) on the server:

```bash
./scripts/createtable.sh <mysql-container> <name> <password>
```

This creates a database `<name>`, user `<name>`@`%`, and grants full access to that database. Use the same values for `GHOST_DATABASE`, `SERVICE_USER_MYSQL`, and `SERVICE_PASSWORD_MYSQL` on the blog resource.

Example:

```bash
./scripts/createtable.sh mysql-edtcy0qssaygae7y63jotnnj-065108521543 kaperkunde_nl 'your-secure-password'
```

Find the MySQL container name with `docker ps`.

## License

[MIT](LICENSE)
