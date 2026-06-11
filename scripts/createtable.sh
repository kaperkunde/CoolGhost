#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <container> <name> <password>"
  echo
  echo "Creates inside <container>:"
  echo "  - MySQL user:     <name>@'%'"
  echo "  - MySQL database: <name>"
  echo "  - Grants full privileges on <name>.* to <name>@'%'"
  exit 1
}

if [[ $# -ne 3 ]]; then
  usage
fi

CONTAINER="$1"
NAME="$2"
PASSWORD="$3"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Error: container not found: $CONTAINER" >&2
  exit 1
fi

if [[ ! "$NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "Error: name must contain only letters, numbers, and underscores." >&2
  exit 1
fi

echo "Checking MYSQL_ROOT_PASSWORD exists in container..."
docker exec "$CONTAINER" sh -c 'test -n "$MYSQL_ROOT_PASSWORD"' || {
  echo "Error: MYSQL_ROOT_PASSWORD is not set in container: $CONTAINER" >&2
  exit 1
}

echo "Creating database/user/grants:"
echo "  container: $CONTAINER"
echo "  database:  $NAME"
echo "  user:      $NAME"
echo

docker exec -i "$CONTAINER" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' <<SQL
CREATE USER IF NOT EXISTS '$NAME'@'%' IDENTIFIED BY '$PASSWORD';
ALTER USER '$NAME'@'%' IDENTIFIED BY '$PASSWORD';
CREATE DATABASE IF NOT EXISTS $NAME;
GRANT ALL PRIVILEGES ON $NAME.* TO '$NAME'@'%';
FLUSH PRIVILEGES;
SHOW GRANTS FOR '$NAME'@'%';
SQL

echo
echo "Done."
echo "Database: $NAME"
echo "User:     $NAME"
echo "Host:     %"