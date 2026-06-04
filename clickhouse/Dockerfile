# Bake the init SQL into the image so the analytics schema is created on first
# boot without a host bind mount (which is empty on platforms like Coolify that
# don't keep the Git repo on the host for Docker Compose deployments).
FROM clickhouse/clickhouse-server:24.8-alpine@sha256:b002e56ed5c16e224c312527f6fcba7e77216fec5d7a88a7828f59efc614feb5
COPY init/ /docker-entrypoint-initdb.d/
