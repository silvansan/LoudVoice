# lOudvoice

lOudvoice is a self-hosted event audio app built on LiveKit. It supports multiple events, event managers, per-event branding, per-channel speaker/listener links, QR codes, WebRTC listening, and HLS listening for phones.

## Current Shape

- The base domain opens a login page.
- Admins can manage users, events, event assignments, channels, logos, descriptions, passwords, links, QR codes, and HLS.
- Event managers can manage only their assigned events.
- Every event starts with one `EN` channel.
- Every channel has separate speaker and listener tokens, which can be refreshed from Admin.
- Speaker pages auto-start HLS for their channel after publishing begins.
- Listener pages are merged into one page: phones prefer HLS, desktops prefer WebRTC.

## Quick Start

```bash
cp .env.example .env
docker compose up -d
```

Open:

```text
http://localhost:7884/
```

The first boot creates the initial admin from:

```text
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=change-this-admin-password
```

If `INITIAL_ADMIN_PASSWORD` is not set, `ADMIN_PASSWORD` is used as a fallback.

## Environment

| Variable | Purpose |
| --- | --- |
| `LIVEKIT_API_KEY` | LiveKit API key used by the web app and egress. |
| `LIVEKIT_API_SECRET` | LiveKit API secret, at least 32 characters. |
| `PUBLIC_LIVEKIT_WSS` | Browser WebSocket URL for normal LAN/domain users. |
| `LOCAL_LIVEKIT_WSS` | Browser WebSocket URL when opening the app on localhost. |
| `INITIAL_ADMIN_USERNAME` | Username seeded on the first boot. |
| `INITIAL_ADMIN_PASSWORD` | Password seeded on the first boot. |
| `ADMIN_PASSWORD` | Backward-compatible fallback for initial admin password. |
| `LINK_BASE_URL` | Optional base URL for generated speaker/listener links and QR codes. |
| `DATA_PATH` | JSON data file path inside the web container. |
| `UPLOAD_ROOT` | Uploaded event logo directory inside the web container. |

## Deployment Notes

For a domain deployment, use two proxy hosts:

| Domain | Forward to | Notes |
| --- | --- | --- |
| `voice.example.com` | `localhost:7884` | lOudvoice web app. |
| `livekit.example.com` | `localhost:7880` | LiveKit signaling with WebSocket support. |

Open firewall/router ports for:

| Port | Protocol | Purpose |
| --- | --- | --- |
| `7884` | TCP | Web frontend, usually proxied. |
| `7880` | TCP | LiveKit signaling, usually proxied. |
| `7881` | TCP | LiveKit TCP fallback. |
| `50000-50100` | UDP | WebRTC media. |

Set `PUBLIC_LIVEKIT_WSS=wss://livekit.example.com` when serving over HTTPS.

## Data

The first implementation uses a file-backed JSON store at `loudvoice_web/data/app-data.json`. Uploaded event logos are stored under `loudvoice_web/uploads/`. Both folders are ignored by Git.

This is intentionally isolated behind `store.mjs`, so it can be swapped for SQLite/Postgres later without rewriting the browser pages.
