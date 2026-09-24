# Coati contributor instructions

Coati is a self-hosted enterprise model gateway and administration console.
portal/ contains Flask, React and PostgreSQL integration; docker/ contains
server deployment definitions.

Desktop applications, CLI implementations, agent plugins and runtime installers
are outside the public repository. Do not add them as dependencies or vendor them.
Keep company-specific services, credentials, domains and deployment records out.

Backend layers: model → schema → crud → service → api. Reuse backend/common/auth.py
for access checks. Frontend uses Semi Design and shared/api/request.js.
Preserve migration revision chains and apply new migrations to an isolated
development database before claiming they are validated.

Run portal backend tests, frontend tests/build and
portal/backend/scripts/verify_feature.py for affected changes.
