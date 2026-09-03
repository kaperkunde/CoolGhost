#!/usr/bin/with-contenv bash
# LinuxServer init hook. This stage runs before the Duplicati service starts,
# so the provisioning itself has to wait for the web service — hence the
# background process rather than a blocking call here.
mkdir -p /config
nohup /usr/local/bin/bootstrap-backups.sh >/dev/null 2>&1 &
echo "[coolghost-bootstrap] provisioning backup jobs in the background; see /config/coolghost-bootstrap.log"
