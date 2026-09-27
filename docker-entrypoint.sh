#!/bin/sh
set -e
echo "Coati: applying migrations and synchronizing permissions"
node dist/setup-once.js
exec node dist/main.js
