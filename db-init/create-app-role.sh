#!/bin/sh
# Creates the role the bot uses for handlers; its row-level security keeps guilds apart. Runs once, on an empty data
# directory. The bot grants the role its privileges at startup.
set -eu
psql -v ON_ERROR_STOP=1 -v app_password="$BOT_APP_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE bot_app LOGIN PASSWORD :'app_password';
SQL
