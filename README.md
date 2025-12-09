# Presence Status Service

A standalone Node.js + Express microservice that tracks lobby presence states (online/away/busy) with short-lived TTLs. Designed to live next to `rubik-app` and be deployed independently to Render.

## Quick start

```bash
cd status
npm install
npm run dev
```

Create a `.env` file (Render dashboard will handle environment variables in production):

```
PORT=4444
PRESENCE_SECRET=replace-with-long-random-string
PRESENCE_TTL_MS=60000
CLEANUP_INTERVAL_MS=5000
ALLOW_ORIGINS=http://localhost:3000,https://your-frontend.app
LOG_HEARTBEATS=false
```

Visit `http://localhost:4444/healthz` to confirm the service is running.

## API surface

- `POST /presence/heartbeat` — body `{ userId, status?, ttlMs?, metadata? }`. Requires `x-presence-secret` header when `PRESENCE_SECRET` is set.
- `POST /presence/offline` — body `{ userId }`. Also requires the secret header.
- `GET /presence?userIds=a,b,c` — returns the current presence snapshot for the requested users.
- `GET /presence/:userId` — fetch a single user snapshot.
- `GET /healthz` — returns uptime and the number of active entries.

Statuses automatically expire after `PRESENCE_TTL_MS` (default 60 seconds) if new heartbeats are not received.

## Deploying to Render

1. Push the repository (with both `rubik-app` and `status`) to GitHub.
2. Enable the Render Blueprint located at the repo root `render.yaml` (see below) or manually create a new **Web Service** pointing to `status` as the root directory.
3. Configure environment variables: `PRESENCE_SECRET`, optional `ALLOW_ORIGINS`, overrides for `PRESENCE_TTL_MS`/`CLEANUP_INTERVAL_MS`, and set `LOG_HEARTBEATS=true` if you want to log every heartbeat/offline event.
4. Render will run `npm install && npm run build` automatically and start the service via `npm run start`.

## Blueprint reference (`render.yaml`)

A ready-to-use Render blueprint lives in the repository root and points at this folder. Update the service name before applying to avoid collisions.
