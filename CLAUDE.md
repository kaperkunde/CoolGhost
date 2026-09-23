# Working in this repo

CoolGhost is the server side of [plek.je](https://github.com/kaperkunde/plekje),
which pins it as the `CoolGhost` submodule and runs its e2e suite against
`docker-compose.shared.yaml`.

## Branches follow the app

| CoolGhost branch | Deployed to         | Used by plekje branch |
| ---------------- | ------------------- | --------------------- |
| `shared-dev`     | the dev servers     | `dev`                 |
| `shared`         | production servers  | `main`                |

Land a change here first, then bump the submodule pointer in plekje: its CI
fails a PR whose pointer is not yet on the matching branch. Promote
`shared-dev → shared` before plekje's `dev → main`.

## Secrets: Coolify magic variables

Generate secrets with Coolify magic variables (`SERVICE_PASSWORD_*`,
`SERVICE_BASE64_*`) instead of asking for new environment values. They are
shared by every service **within one compose resource**, never across
resources: a separate resource (the split `docker-compose.api.yaml` /
`docker-compose.duplicati.yaml`, or the plekje app) needs the value copied into
its own environment, so say so in the compose comment and the README.
