# 🎙 LiveKit Voice

A self-hosted, real-time audio broadcasting system built on [LiveKit](https://livekit.io). Supports multiple rooms, a speaker/listener web interface, and an admin panel — all deployable via Docker Compose.

---

## Features

- 🎙 **Speaker page** — publish audio from your microphone to a room
- 🎧 **Listener page** — join a room and hear live audio in the browser
- ⚙️ **Admin page** — add and delete rooms on the fly without restarting
- 🔒 **Token-protected access** — share URLs with `?token=` so only invited users can access
- 🌐 **LAN/WAN auto-detection** — automatically uses local WebSocket on LAN, public on internet
- 🐳 **Docker Compose** — easy to deploy on any Linux server

---

## Requirements

- A Linux server with Docker and Docker Compose installed
- A domain name pointing to your server (e.g. `voice.example.com`)
- A reverse proxy with SSL (e.g. Nginx Proxy Manager, Caddy)
- Ports **80**, **443**, **7880**, **7881**, and **50000–50100/UDP** open on your router/firewall

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/yourname/livekit-voice.git
cd livekit-voice
```

### 2. Create your environment file

```bash
cp .env.example .env
nano .env
```

Fill in all the values (see [Environment Variables](#environment-variables) below).

### 3. Create the host directories

```bash
mkdir -p /srv/docker/livekit-web/public
cp -r livekit-web/* /srv/docker/livekit-web/
```

### 4. Deploy

```bash
docker compose up -d
```

### 5. Set up your reverse proxy

You need two proxy hosts:

| Domain | Forward to | Notes |
|--------|-----------|-------|
| `voice.example.com` | `localhost:7884` | Web frontend |
| `livekit.example.com` | `localhost:7880` | LiveKit signal — must have WebSocket support enabled |

Both need valid SSL certificates.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description | Example |
|----------|-------------|---------|
| `LIVEKIT_API_KEY` | Your LiveKit API key (any string) | `my-app-key` |
| `LIVEKIT_API_SECRET` | Your LiveKit API secret (min 32 chars) | `openssl rand -hex 32` |
| `PUBLIC_LIVEKIT_WSS` | Public WebSocket URL for LiveKit | `wss://livekit.example.com` |
| `LOCAL_LIVEKIT_WSS` | LAN WebSocket URL for LiveKit | `ws://192.168.1.x:7880` |
| `ADMIN_PASSWORD` | Password for the admin panel | `supersecret` |
| `ACCESS_TOKEN` | Token required in URL to access pages | `mysecrettoken` |

Generate a secure API secret:
```bash
openssl rand -hex 32
```

---

## Usage

Once deployed, access the app at:

```
https://voice.example.com/?token=YOUR_ACCESS_TOKEN
```

| Page | URL |
|------|-----|
| Home | `https://voice.example.com/?token=TOKEN` |
| Speaker | `https://voice.example.com/speaker.html?token=TOKEN` |
| Listener | `https://voice.example.com/listen.html?token=TOKEN` |
| Admin | `https://voice.example.com/admin.html?token=TOKEN` |

### Adding/removing rooms

Go to the **Admin** page, enter your `ADMIN_PASSWORD`, and add or delete rooms live — no restart needed.

---

## Updating files

The web files are mounted from the host at `/srv/docker/livekit-web/`. To update them:

```bash
# Edit a file
nano /srv/docker/livekit-web/server.mjs

# Restart the web container to apply changes
docker restart livekit-web
```

No need to redeploy the whole stack.

---

## Architecture

```
Browser
  │
  ├── HTTPS → voice.example.com (NPM) → livekit-web:8080 (token API + static files)
  │
  └── WSS   → livekit.example.com (NPM) → livekit:7880 (LiveKit signal)
                                               │
                                               └── UDP 50000-50100 (WebRTC media)
```

---

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 7884 | TCP | Web frontend (internal, proxied) |
| 7880 | TCP | LiveKit signal (proxied via reverse proxy) |
| 7881 | TCP | LiveKit TCP fallback for WebRTC |
| 50000–50100 | UDP | WebRTC media streams |

---

## License

MIT