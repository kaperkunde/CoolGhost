# CoolGhost — shared infrastructure

This branch splits CoolGhost into **shared** and **per-site** compose stacks for running multiple Ghost blogs on one Coolify server.

For the full project overview, architecture, and analytics behaviour, see the [`main` branch README](https://github.com/kaperkunde/CoolGhost/blob/main/README.md).

## What to deploy

| Resource | Compose file | How many |
| -------- | ------------ | -------- |
| MySQL | `docker-compose.mysql.yaml` | Once per server |
| Analytics | `docker-compose.analytics.yaml` | Once per server |
| Traefik routes | `traefik.coolghost.yaml` | Once per server (see below) |
| Ghost site | `docker-compose.yaml` | One per blog |

## Coolify setup

Deploy each compose file as a separate Coolify Docker Compose resource.

On **every** resource — MySQL, analytics, and each blog — open **Advanced** and enable **Connect to Predefined Network**. Without this, stacks cannot reach each other on the shared `coolify` network.

Give each shared stack a **custom name** in Advanced (e.g. `mysql-ghost` for MySQL, `ghost-analytics` for analytics). Coolify uses these names for cross-stack DNS — the hostname is the custom name with a **trailing dash**, e.g. `mysql-ghost-`.

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

### 4. Each blog (`docker-compose.yaml`)

The blog stack is a single **Ghost** service. Assign the public domain to **ghost** (port **2368**) in Coolify.

Per-site environment variables (full list and descriptions are on [`main`](https://github.com/kaperkunde/CoolGhost/blob/main/README.md#quick-deployment-coolify)):

| Variable | Notes |
| -------- | ----- |
| `SERVICE_URL_GHOST` | Public URL, e.g. `https://blog.example.com` (Coolify magic var) |
| `SERVICE_FQDN_GHOST` | Bare hostname, e.g. `blog.example.com` (Coolify magic var) |
| `MYSQL_HOST` | Shared MySQL stack hostname, e.g. `mysql-ghost-` |
| `GHOST_DATABASE` | This site's database name |
| `SERVICE_USER_MYSQL` | This site's MySQL user |
| `SERVICE_PASSWORD_MYSQL` | This site's MySQL password |
| Mail vars | `MAIL_FROM`, `MAIL_OPTIONS_*` — see main README |

Open `SERVICE_URL_GHOST` and finish setup at `/ghost`.

## MySQL: one database per blog

Each blog needs its **own** MySQL database and user. Create them manually, or use [`scripts/createtable.sh`](scripts/createtable.sh) on the server:

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
