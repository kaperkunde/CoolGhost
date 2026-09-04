FROM lscr.io/linuxserver/duplicati:v2.3.0.3_stable_2026-06-10-ls296@sha256:98986271265c9184f844d7e61ce63a60993d8dcfe5f989e4316b374ccebfdaee

# mysql-client: pre-backup.sh dumps every site database.
# curl + jq: bootstrap-backups.sh talks to the Duplicati REST API.
# The base image enables deb-src for every repo, which makes apt-get update
# pull ~50 MB of source-package indexes we never use — slow mirrors have
# stalled deploys on that alone. Drop them (both list formats) first.
RUN sed -i '/^deb-src/d' /etc/apt/sources.list \
    && (sed -i '/^Types:/s/ deb-src//' /etc/apt/sources.list.d/*.sources 2>/dev/null || true) \
    && apt-get update \
    && apt-get install -y --no-install-recommends default-mysql-client curl jq \
    && rm -rf /var/lib/apt/lists/*

COPY pre-backup.sh /usr/local/bin/pre-backup.sh
COPY bootstrap-backups.sh /usr/local/bin/bootstrap-backups.sh
RUN chmod +x /usr/local/bin/pre-backup.sh /usr/local/bin/bootstrap-backups.sh

# Runs on every container start; provisions the stock backup jobs the first
# time only (see the marker file in /config).
COPY 99-coolghost-bootstrap.sh /custom-cont-init.d/99-coolghost-bootstrap
RUN chmod +x /custom-cont-init.d/99-coolghost-bootstrap
