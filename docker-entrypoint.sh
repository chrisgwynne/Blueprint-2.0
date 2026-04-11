#!/bin/sh
set -e

# Init database if not exists
if [ ! -f "$DATABASE_PATH" ]; then
  echo "Initialising Blueprint database..."
  bun run --cwd /app/server db:init
fi

exec "$@"
