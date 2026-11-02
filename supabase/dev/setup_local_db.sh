#!/usr/bin/env bash
# DEVELOPMENT ONLY: create a local database that mimics Supabase for running the app.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${DB:-inquirydesk_dev}
su postgres -c "dropdb --if-exists $DB; createdb $DB"
for f in tests/00_local_supabase_stub.sql migrations/*.sql dev/local_auth.sql; do
  su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f $PWD/$f" >/dev/null
done
echo "Local database '$DB' ready: postgres://app_server:app_server_dev_only@localhost:5432/$DB"
