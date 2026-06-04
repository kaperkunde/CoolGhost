# Bake the Caddyfile into the image so the config travels with the container.
# This avoids host bind mounts, which break on platforms (e.g. Coolify) that
# don't keep the Git repo on the host for Docker Compose deployments.
FROM caddy:2.10.2-alpine@sha256:953131cfea8e12bfe1c631a36308e9660e4389f0c3dfb3be957044d3ac92d446
COPY Caddyfile /etc/caddy/Caddyfile
