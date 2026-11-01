#!/bin/sh
# Runs once, when the database volume is first created. Sandchest connects as
# "sandchest", which owns its database but is not a superuser. The superuser
# loses its password, so it can only be used from inside this container:
#   docker compose exec postgres psql -U postgres
set -eu

psql -v ON_ERROR_STOP=1 -v password="$POSTGRES_PASSWORD" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE sandchest LOGIN PASSWORD :'password';
CREATE DATABASE sandchest OWNER sandchest;
REVOKE ALL ON DATABASE sandchest FROM PUBLIC;
ALTER ROLE postgres PASSWORD NULL;
SQL
