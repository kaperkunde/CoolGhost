# CoolGhost — shared infrastructure

This branch splits CoolGhost into **shared** and **per-site** compose stacks for running multiple Ghost blogs on one Coolify server.

For the full project overview, architecture, analytics behaviour, and local development setup, see the [`main` branch README](https://github.com/kaperkunde/CoolGhost/blob/main/README.md).

## What to deploy

| Resource | Compose file | How many |
| -------- | ------------ | -------- |
| MySQL | `docker-compose.mysql.yaml` | Once per server |
| Analytics | `docker-compose.analytics.yaml` | Once per server |
| Ghost site | `docker-compose.yaml` | One per blog |

## Coolify setup

Deploy each compose file as a separate Coolify Docker Compose resource.

On **every** resource — MySQL, analytics, and each blog — open **Advanced** and enable **Connect to Predefined Network**. Without this, stacks cannot reach each other on the shared `coolify` network.

Give each shared stack a **custom name** in Advanced (e.g. `mysql-ghost` for MySQL, `ghost-analytics` for analytics). Coolify uses these names for cross-stack DNS — the hostname is the custom name with a **trailing dash**, e.g. `mysql-ghost-`.

### 1. MySQL (`docker-compose.mysql.yaml`)

Set `SERVICE_USER_MYSQL`, `SERVICE_PASSWORD_MYSQL`, `SERVICE_PASSWORD_MYSQLROOT`, and an initial `GHOST_DATABASE` (only used to bootstrap the container; each blog gets its own database later).

### 2. Analytics (`docker-compose.analytics.yaml`)

No extra configuration beyond the shared env vars Coolify provides. Deploy once and leave it running.

### 3. Each blog (`docker-compose.yaml`)

Per-site environment variables (full list and descriptions are on [`main`](https://github.com/kaperkunde/CoolGhost/blob/main/README.md#quick-deployment-coolify)):

| Variable | Notes |
| -------- | ----- |
| `SERVICE_URL_CADDY` | Public URL, e.g. `https://blog.example.com` |
| `SERVICE_HOST_CADDY` | Bare hostname, e.g. `blog.example.com` |
| `MYSQL_HOST` | Shared MySQL stack hostname, e.g. `mysql-ghost-` |
| `GHOST_DATABASE` | This site's database name |
| `SERVICE_USER_MYSQL` | This site's MySQL user |
| `SERVICE_PASSWORD_MYSQL` | This site's MySQL password |
| `TRAFFIC_STATS_HOST` | Analytics stack `traffic-stats` hostname (default `traffic-stats`) |
| `TRAFFIC_ANALYTICS_HOST` | Analytics stack `traffic-analytics` hostname (default `traffic-analytics`) |
| Mail vars | `MAIL_FROM`, `MAIL_OPTIONS_*` — see main README |

Open `SERVICE_URL_CADDY` and finish setup at `/ghost`.

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
