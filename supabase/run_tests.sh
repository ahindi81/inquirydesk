#!/usr/bin/env bash
# Local test runner: fresh database, stub, migrations, then acceptance tests.
set -euo pipefail
cd "$(dirname "$0")"
DB=${DB:-idtest}
su postgres -c "dropdb --if-exists $DB; createdb $DB"
for f in tests/00_local_supabase_stub.sql migrations/*.sql; do
  su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f $PWD/$f" >/dev/null
done
su postgres -c "psql -q -d $DB -f $PWD/tests/10_security_and_rules.sql" 2>&1 | grep -E "FAIL|PASS|ERROR" | sed "s/^ *//" || true
