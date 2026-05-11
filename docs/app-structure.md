# UnderSound App Structure

## Product Shape

UnderSound becomes a multi-event audio broadcasting platform.

The base domain opens a login page. After login, users see only what their account is allowed to manage.

The old single `.env`-driven structure should be treated as a prototype. The next app version should use persistent application data for users, events, channels, tokens, and settings.

## Hierarchy

```text
System
  Admin users
    Can manage all users, events, channels, tokens, and passwords
  Event users
    Can manage only assigned events

Event
  Event managers/users
  Event branding
    Logo PNG
    Public description
  Channels
    Speaker link/token
    Listener link/token
    HLS egress status, auto-started when a speaker publishes
```

## Default Template State

Fresh install should create:

```text
Initial admin user
  username: configured during setup
  password: configured during setup

No demo event by default, or one optional starter event:
  Event name: Default Event
  Channels:
    EN
```

Each new event should start with one `EN` channel. More channels can be added from that event's admin page.

## Roles

### System Admin

Can:

- Create, edit, delete users.
- Create, edit, archive/delete events.
- Assign users to events.
- Change any user password.
- Change any event settings.
- Add/delete channels in any event.
- Refresh speaker/listener tokens for any channel.
- Start/stop HLS for any channel.

### Event Manager

Can only access assigned events.

Can:

- Edit assigned event settings.
- Add/delete channels in assigned events.
- Refresh speaker/listener tokens for assigned event channels.
- Start/stop HLS for assigned event channels.
- Change their own password.

Cannot:

- See unassigned events.
- Manage system admins.
- Assign users to events unless we explicitly add that permission later.

## Authentication

Replace URL-only admin access with login sessions.

Recommended:

- Username + password login.
- Passwords stored as strong hashes, never plaintext.
- Session cookie for dashboard access.
- Speaker/listener pages continue to use URL tokens.

Base domain:

```text
GET /
  If not logged in: show login page
  If logged in as admin: redirect to admin dashboard
  If logged in as event manager: redirect to event list/dashboard
```

## Public Link Tokens

Every channel has two independently refreshable public tokens:

```text
speaker_token
listener_token
```

Speaker token allows:

- Opening the speaker page for that exact event/channel.
- Requesting a LiveKit token with publish permission.

Listener token allows:

- Opening the listener page for that exact event/channel.
- Requesting a LiveKit token with subscribe-only permission.
- Reading HLS status for that exact channel.

Refreshing a token invalidates old QR codes/links for that side only.

## Data Model

Use SQLite for simple self-hosting unless a larger deployment needs Postgres later.

### users

```text
id
username
password_hash
role                 admin | event_manager
display_name
created_at
updated_at
disabled_at
```

### events

```text
id
name
slug
description
location
logo_asset_id
public_description
starts_at
ends_at
created_by_user_id
created_at
updated_at
archived_at
```

### assets

Uploaded files managed by the backend.

```text
id
owner_event_id
kind                 event_logo
original_filename
mime_type            image/png
storage_path
public_path
size_bytes
width
height
created_by_user_id
created_at
deleted_at
```

Event logos should be PNG files. The backend should validate MIME type, file extension, and size. Recommended initial limit: 2 MB.

The event description should be editable from the event admin page. It is shown on public speaker/listener pages for that event.

### event_users

Many-to-many join table.

```text
event_id
user_id
permission           manager
created_at
```

### channels

```text
id
event_id
name                 EN, FR, DE, ROOM-A
speaker_token_hash
listener_token_hash
speaker_token_hint
listener_token_hint
created_at
updated_at
deleted_at
```

Store token hashes in the database. Show the full token only immediately after generation/refresh, or generate links directly in the admin UI.

### hls_streams

```text
id
channel_id
egress_id
stream_id
playlist_path
status               starting | active | failed | stopped
error_message
started_at
stopped_at
```

HLS streams should be started automatically when the first speaker begins publishing in a channel. Admins/event managers may still stop or restart HLS manually for recovery.

### audit_log

```text
id
actor_user_id
action
entity_type
entity_id
metadata_json
created_at
```

Use this for sensitive actions like password changes, token refreshes, channel deletion, and HLS start/stop.

## URL Structure

Dashboard:

```text
GET  /
GET  /login
POST /login
POST /logout

GET  /admin
GET  /admin/users
GET  /admin/events
GET  /admin/events/:eventId
```

Public pages:

```text
GET /e/:eventSlug/:channelName/speaker?token=...
GET /e/:eventSlug/:channelName/listen?token=...
```

Optional short links:

```text
GET /s/:channelId?token=...
GET /l/:channelId?token=...
```

## API Structure

Auth:

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/change-password
```

Users:

```text
GET    /api/users
POST   /api/users
PATCH  /api/users/:id
POST   /api/users/:id/password
POST   /api/users/:id/disable
```

Events:

```text
GET    /api/events
POST   /api/events
GET    /api/events/:eventId
PATCH  /api/events/:eventId
DELETE /api/events/:eventId
```

Event branding:

```text
POST   /api/events/:eventId/logo
DELETE /api/events/:eventId/logo
GET    /event-assets/:eventSlug/logo.png
```

Logo upload rules:

- PNG only.
- Store outside the editable public source tree, then serve through the backend or a mounted uploads directory.
- Replace old logo atomically when a new logo is uploaded.
- Remove old logo file after successful replacement.

Event assignments:

```text
GET    /api/events/:eventId/users
POST   /api/events/:eventId/users
DELETE /api/events/:eventId/users/:userId
```

Channels:

```text
GET    /api/events/:eventId/channels
POST   /api/events/:eventId/channels
PATCH  /api/channels/:channelId
DELETE /api/channels/:channelId
```

Tokens and links:

```text
GET  /api/channels/:channelId/links
POST /api/channels/:channelId/tokens/speaker/refresh
POST /api/channels/:channelId/tokens/listener/refresh
GET  /api/channels/:channelId/qr/speaker.svg
GET  /api/channels/:channelId/qr/listener.svg
```

LiveKit:

```text
GET  /api/livekit/token?channelId=...&role=speaker|listener&token=...
GET  /api/channels/:channelId/hls
POST /api/channels/:channelId/hls/start
POST /api/channels/:channelId/hls/stop
```

Automatic HLS:

```text
POST /api/channels/:channelId/speaker-session/start
POST /api/channels/:channelId/speaker-session/stop
```

The speaker page calls `speaker-session/start` after the microphone track is published successfully. The backend creates the LiveKit room if needed and starts HLS if it is not already active. `speaker-session/stop` may be used for bookkeeping, but HLS can remain active until manually stopped or until an event/channel auto-stop policy is added.

## Page Structure

### Login Page

Shown at base domain for unauthenticated users.

Fields:

- Username
- Password

### Admin Dashboard

For system admins:

- Events overview.
- Users overview.
- Quick create event.
- Quick create user.

For event managers:

- Assigned events only.

### Event Detail Page

For each event:

- Event settings.
- Editable public event description.
- Event logo upload/replace/remove.
- Assigned users.
- Channels list.
- Add channel.
- HLS start/stop per channel.
- HLS status per channel. HLS starts automatically when a speaker begins publishing.
- Speaker/listener links per channel.
- Speaker/listener QR codes per channel.
- Refresh speaker token.
- Refresh listener token.

### Speaker Page

No dashboard navigation.

Inputs:

- Channel shown as fixed context.
- Microphone selector.
- Start/stop publishing.

Requires valid channel speaker token.

After publish succeeds, the page notifies the backend so HLS starts automatically for that channel.

### Listener Page

No dashboard navigation.

Behavior:

- Uses HLS by default on phones.
- Uses WebRTC by default on desktop.
- Allows fallback switch only if useful.

Requires valid channel listener token.

Displays the event logo when one is configured.
Displays the event public description when one is configured.

## Configuration

Keep infrastructure settings in `.env`:

```text
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
PUBLIC_LIVEKIT_WSS
LOCAL_LIVEKIT_WSS
INTERNAL_LIVEKIT_URL
LINK_BASE_URL
DATABASE_URL
SESSION_SECRET
```

Move product data out of `.env`:

- Admin passwords.
- Event names.
- Event logos.
- Channels.
- Speaker/listener tokens.
- User assignments.

## Implementation Direction

Recommended next stage:

1. Add SQLite and a small database access layer.
2. Add migrations and seed/setup command.
3. Replace in-memory rooms, sessions, and HLS stream tracking with database-backed tables.
4. Replace `.env` admin password with user login.
5. Rebuild admin UI around events first, then channels.
6. Convert public speaker/listener URLs to event/channel token URLs.
7. Add event logo upload/storage and render event-specific branding on public pages.
8. Keep current LiveKit and HLS code, but attach it to `channel_id` instead of room name alone.
9. Add speaker publish notification so HLS starts automatically for the channel.

## Decisions To Confirm

- Should event managers be allowed to create new users, or only admins?
- Should events be deletable, or only archived?
- Should a channel be reusable after deletion, or should deleted channel names remain reserved?
- Should token refresh immediately stop current speaker/listener sessions, or only prevent future joins?
- Should HLS stop automatically after the speaker disconnects, or stay running until manually stopped?
- What maximum PNG logo size and dimensions should we allow?
