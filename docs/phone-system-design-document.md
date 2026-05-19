# Modern Company Phone System — Design Document

## Overview

A cloud-native business phone system replacing traditional PBX hardware with a serverless architecture built on Twilio, Azure, and a lightweight SPA portal. The system provides multi-level auto-attendant (IVR), extension-based routing, voicemail, call logging, and a web portal for all users and admins — with no on-premise servers.

### Design principles

- No dedicated PBX server — Twilio is the phone network edge, Azure Blob is the brain
- Pre-generate all audio (TTS greetings) at save time, never on a live call — admin can preview each greeting before saving
- Phone number is the primary identity — extensions are optional (only for SIP client users)
- Users without extensions receive calls via direct forwarding to their phone number
- Only users with a SIP-registered extension can make outbound calls
- Admin auth via Microsoft Entra (MSAL popup) with delegated storage permissions — no separate admin credentials
- Regular user auth via OTP: SMS to phone number, or voice call to extension reading the code aloud
- Stable internal user IDs decouple identity from extensions — history survives reassignment
- Minimal compute — a light server handles only auth, TTS proxy, and token generation
- SPA talks directly to blob storage via scoped credentials for all read/write operations

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                      THIRD-PARTY SERVICES                       │
│                                                                 │
│  Twilio              Twilio Serverless        OpenAI TTS API    │
│  PSTN + SIP +        IVR logic +              Voice generation  │
│  Verify (OTP)        webhook handler          (pre-gen only)    │
└──────┬──────────────────┬─────────────────────────┬─────────────┘
       │                  │                         │
       │                  │ reads XML + writes      │
       │                  │ logs/voicemail           │
       │                  ▼                         │
┌──────┴──────────────────────────────────────────────────────────┐
│                      AZURE BLOB STORAGE                         │
│                                                                 │
│  /ivr/*          TwiML XML files (IVR menu instructions)        │
│  /audio/*        Pre-generated TTS MP3 greetings                │
│  /voicemail/*    Recordings filed by {userId}/{timestamp}.mp3   │
│  /logs/*         Call detail records as JSON                    │
│  /config/*       IVR tree structure, extension directory        │
│  /sessions/*     Active session records                         │
└──────▲──────────────────────────────────────────────────────────┘
       │                  │
       │ SAS tokens       │ Entra delegated token
       │ (30-min, scoped) │ (admin, MSAL popup)
       │                  │
┌──────┴──────────┐  ┌────┴───────────────────────────────────────┐
│  LIGHT SERVER   │  │  SPA PORTAL (Azure Static Web Apps)        │
│  Azure Container│  │                                            │
│  App (6 routes) │  │  Regular users: OTP login → view logs,     │
│                 │  │    play voicemail, settings                 │
│  /auth/request  │  │  Admin: Entra login → manage extensions,   │
│  /auth/verify   │  │    edit IVR tree, generate greetings,      │
│  /auth/refresh  │  │    manage users                            │
│  /auth/logout   │  │                                            │
│  /tts/generate  │  │  Heartbeat keeps container warm during     │
│  /voice/token   │  │    active sessions                         │
└─────────────────┘  └────────────────────────────────────────────┘
```

---

## Resources and Cost Estimates

| Resource | Service | Purpose | Monthly cost |
|---|---|---|---|
| Phone numbers + calling | Twilio | PSTN connectivity, SIP domain | ~$1/number + $0.013/min |
| OTP verification | Twilio Verify | User login codes | $0.05 per verification |
| IVR logic + webhooks | Twilio Serverless Functions | Digit routing, call logging, voicemail capture | Included with Twilio |
| Voice generation | OpenAI TTS API | Pre-generate greeting audio | ~$1–2 (very low volume) |
| Admin identity | Entra ID App Registration | Admin auth + blob scoping | Free |
| Light server | Azure Container App (Consumption) | Auth, TTS proxy, token gen | $0 (free tier covers it) |
| SPA hosting | Azure Static Web Apps | Frontend portal | $0 (free tier) |
| All data + audio | Azure Blob Storage | IVR XML, audio, voicemail, logs | ~$2–5 |
| Desktop softphone | MicroSIP + Zoiper | SIP client on PC and mobile | Free / ~€40 one-time |
| Voicemail email | Twilio SendGrid | Forward VM as email with MP3 | $0 (free tier: 100/day) |
| VM transcription | OpenAI Whisper | Transcribe voicemails to text | ~$0.26/mo (very low) |

**Estimated total: ~$20–35/month** plus per-minute calling costs for a small company.

---

## Twilio Configuration

### SIP Domain

A Twilio SIP Domain acts as the PBX registration point. All softphones (MicroSIP, Zoiper) register here.

- Domain: `yourcompany.sip.us1.twilio.com`
- SIP Registration: enabled
- Voice Configuration URL: points to the Twilio Serverless Function handling IVR and outbound routing
- Credential List: one entry per extension (username = extension number, password = generated)

### Twilio Serverless Functions

Already built by the team. These functions:

1. **Inbound call handler** — fetches the appropriate TwiML XML from Azure Blob based on the IVR menu path, plays audio from blob URLs
2. **Digit collection handler** — reads caller input, fetches the next TwiML XML from blob for the selected menu option
3. **Outbound call handler** — when a SIP endpoint dials out, determines if the destination is an internal extension (routes SIP-to-SIP) or an external number (routes to PSTN with company caller ID)
4. **Voicemail handler** — records the message, writes the recording URL to blob storage under `/voicemail/{userId}/{timestamp}.mp3`
5. **Call status webhook** — on call completion, writes a call detail record to blob under `/logs/`

### Twilio Phone Numbers

Each DID number is configured with its voice webhook pointing to the inbound call handler function. Multiple numbers can share the same IVR entry point or have different greetings.

---

## Auto-Attendant / IVR System

### Menu structure

The IVR is a multi-level tree stored as JSON in blob at `/config/ivr-tree.json`. Each node represents a menu level and supports unlimited nesting depth. Each menu option specifies an action type and target:

- **Submenu** — plays another greeting with its own set of options (enables multi-level menus)
- **Ring extension** — rings a registered SIP endpoint (MicroSIP/Zoiper on desk)
- **Ring group** — rings multiple extensions simultaneously (first to answer wins)
- **Forward to phone** — dials an external mobile/landline number directly
- **Voicemail** — plays greeting and records a message (no ring attempt)
- **Announcement** — plays a message then returns to menu or hangs up

### Whisper announcements

When calls are forwarded to a mobile phone (not a SIP extension), the system uses Twilio's whisper feature. Before connecting the caller, the agent hears a brief spoken announcement identifying the call source. The caller hears normal ringing during this time. Example: "Incoming call from accounts receivable line."

This is implemented via `<Dial>` with a `url` attribute pointing to a TwiML endpoint that plays the whisper text. Only the answering party hears it.

### Role-based forwarding

Each menu option can be configured to ring differently based on context:

- Ring SIP extension first, simultaneously forward to mobile if configured
- Forward directly to a mobile number (skipping SIP) — useful for after-hours or remote workers
- Ring group with mixed targets — some SIP extensions, some forwarded numbers
- Fallback chain: ring extension → if no answer → forward to mobile → if no answer → voicemail

Admin configures all forwarding targets per-extension in the directory. The IVR tree can also override forwarding per-option (e.g., Catskills sales line forwards to a specific summer mobile number regardless of the user's default).

### Multiple menu modes

The system supports separate menu trees that can be activated automatically or manually:

- **Main menu** — default business hours greeting and routing
- **After hours** — activated automatically based on business hours schedule
- **Yom Tov / Holiday** — manually activated by admin with configurable holiday name and return date
- **On hold loop** — played to callers waiting in queue or on hold

```json
{
  "id": "main",
  "greeting_audio": "/audio/ivr/main-greeting.mp3",
  "options": {
    "1": { "action": "submenu", "target": "sales" },
    "2": { "action": "submenu", "target": "support" },
    "0": { "action": "extension", "target": "100" },
    "timeout": { "action": "voicemail", "target": "general" }
  }
}
```

### TwiML XML generation

When admin saves a menu node, the portal:

1. Calls `/api/tts/generate` with the greeting text and selected voice
2. Server calls OpenAI TTS API, receives MP3
3. Server writes MP3 to `/audio/ivr/{node-id}.mp3` in blob
4. Server generates TwiML XML referencing that audio URL and writes to `/ivr/{node-id}.xml`

Example generated TwiML:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://yourcompany.blob.core.windows.net/ivr/main-gather.xml">
    <Play>https://yourcompany.blob.core.windows.net/audio/ivr/main-greeting.mp3</Play>
  </Gather>
  <Redirect>/ivr/main.xml</Redirect>
</Response>
```

### TTS preview workflow

Every greeting, voicemail message, and announcement in the system has a "Preview" button. When clicked:

1. Portal sends the text to the TTS generation endpoint
2. Server calls OpenAI TTS API with the selected voice
3. Audio is returned and plays in the browser immediately
4. Admin can listen, adjust the text, and preview again
5. On "Save & generate audio," final audio files are written to blob and TwiML XML is updated
6. Changes are live immediately — next caller hears the new greeting

The "Save & generate audio" button generates ALL audio for the current menu in one operation — intro greeting, all submenu intros, all voicemail greetings, and all announcements. Each is saved as a separate MP3 in blob.

### Greeting tabs vs menu options

Greeting tabs (Main, After Hours, Yom Tov, custom) control only the intro text — what callers hear first. The menu options underneath are shared across all greetings. When switching from business hours to after hours, only the intro changes — "press 1 for orders" stays the same.

Custom greeting tabs support scheduling: set a start date/time and expiry, or activate immediately. When the scheduled period expires, the system reverts to the main greeting automatically.

On hold is a separate setting — not a greeting tab. It's played when a caller is waiting in queue or on hold, not during IVR navigation.

---

## User Identity Model

### Core principle: phone number is primary, extension is optional

Every person in the system has a permanent `userId` (UUID) and a phone number. The phone number is their identity — used for OTP login and call forwarding. Extensions are optional — only users with a registered SIP client (MicroSIP, Zoiper) have one.

- **Users with extension:** Incoming calls ring their SIP client through the PBX AND can simultaneously forward to their phone number. They can also make outbound calls via the SIP client.
- **Users without extension:** Incoming calls forward directly to their phone number. No PBX involvement. They cannot make outbound calls through the system.

Extensions are pointers — an extension maps to a user, but the user persists independently. Voicemails and call logs are stored against `userId`, with the extension (if any) at the time of the call saved as metadata. If an extension is reassigned, the old user keeps all their history.

### Ring groups

A ring group rings multiple destinations simultaneously — first to answer gets the call, the rest stop ringing. Ring groups can mix SIP extensions and phone numbers. Example: a "Sales" ring group might ring ext 101 (SIP), ext 102 (SIP), and +1 (555) 123-4567 (direct forward) all at once. Implemented as a `<Dial>` with multiple `<Sip>` and `<Number>` elements inside it.

### Directory structure in blob

```
/config/directory.json
{
  "users": [
    {
      "userId": "usr-001",
      "name": "Moshe Klein",
      "phone": "+15551234567",
      "email": "moshe@company.com",
      "currentExt": "101",
      "client": "MicroSIP",
      "canCallOut": true,
      "emailVoicemail": true,
      "role": "user"
    },
    {
      "userId": "usr-006",
      "name": "Sarah Levi",
      "phone": "+15556667777",
      "email": "sarah@company.com",
      "currentExt": null,
      "client": null,
      "canCallOut": false,
      "emailVoicemail": true,
      "role": "user"
    }
  ],
  "extensions": {
    "100": "usr-003",
    "101": "usr-001",
    "102": "usr-002"
  }
}
```

Users with `currentExt: null` are forward-only — calls go to their `phone` directly. The `extensions` map only contains SIP-registered users.

### User lifecycle

- Admin adds user with phone number → user can log in via phone OTP, receives forwarded calls
- Admin optionally assigns extension → Twilio SIP credential created, QR code generated for Zoiper, user can now receive SIP calls and dial out
- Admin removes extension → user becomes forward-only, keeps all voicemail and log history
- Admin deactivates user → phone and extension freed, user record marked inactive, data preserved

---

## Authentication

### Regular users — two login methods

**1. Extension (voice call OTP):** User enters their extension number. System calls the extension via Twilio and reads a 6-digit code aloud. User enters the code in the portal. This is automatic — if the user is at their desk with MicroSIP/Zoiper running, their phone rings, they pick up, hear the code, type it in. No SMS, no phone number needed.

**2. Phone number (SMS OTP):** User enters their phone number. System sends a 6-digit code via SMS using Twilio Verify. Used by forward-only users who don't have an extension, or by extension users who are away from their desk.

The login method is determined by which tab the user selects — no confusing options within a tab.

### Admin users — Microsoft Entra (MSAL popup)

Admins authenticate through Azure Entra ID using MSAL.js popup flow. No page redirect — a small popup window handles auth and closes automatically. If the admin is already logged into Entra on their machine (corporate device, M365), `ssoSilent` makes the login completely invisible.

The admin's Entra token grants delegated access to Azure Blob Storage with impersonation permissions. The admin never receives separate storage credentials — Entra handles it end-to-end.

**Login flow:**

```
1. User enters their extension (e.g. 101) or forwarded-to phone number
2. Server looks up the user in directory.json
3. Server sends OTP via Twilio Verify to the user's forwarded phone number
   (or email if configured)
4. User enters OTP code
5. Server verifies OTP, creates server-side session record
6. Server issues:
   - httpOnly JWT cookie (session anchor, 8–24hr expiry)
   - Scoped SAS token for Azure Blob (read-only, 30-min expiry)
7. SPA uses SAS token to read blob directly
8. SPA refreshes SAS every 25 minutes via /api/auth/refresh
   (server verifies JWT cookie, issues fresh SAS)
```

**Session binding:**

| Mechanism | Purpose |
|---|---|
| httpOnly cookie | Not readable by JS — XSS-proof session anchor |
| SameSite=Strict | Prevents CSRF |
| Server-side session table | Allows instant invalidation on logout |
| 30-min SAS tokens | Limits blast radius if token leaks |
| SPA heartbeat (every 4 min) | Keeps Container App warm during session |

**SAS token scoping:**

| User role | SAS permissions | Blob path scope |
|---|---|---|
| Regular user | Read only | `/voicemail/{userId}/*`, `/logs/*` |
| Admin | Read + write | `/ivr/*`, `/audio/*`, `/config/*` |

Admin write SAS tokens are issued per-operation with 5-minute expiry.

### Admin users — Entra ID via MSAL

Admins authenticate through Azure Entra ID using MSAL.js popup flow. No page redirect — a small popup window handles auth and closes automatically.

```javascript
// Silent first (if already logged into Entra on this machine)
try {
  const result = await msalInstance.ssoSilent({
    scopes: ["https://storage.azure.com/user_impersonation"],
    loginHint: "admin@yourcompany.com"
  })
} catch (e) {
  // Popup fallback
  const result = await msalInstance.loginPopup(...)
}
```

**App Registration configuration:**

- Platform: Single Page Application
- Redirect URI: `https://yourportal.com`
- API Permissions: Azure Storage → `user_impersonation`
- Blob IAM roles:
  - Admin Entra group → Storage Blob Data Contributor (scoped to `/ivr/*`, `/audio/*`, `/config/*`)
  - Admin Entra group → Storage Blob Data Reader (scoped to `/voicemail/*`, `/logs/*`)

---

## Light Server (Azure Container App)

### Overview

Six API routes. That's the entire server. Deployed as a single container on Azure Container Apps (Consumption plan).

### Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/request` | None | Look up ext or phone number. If ext: call the extension via Twilio and read OTP aloud. If phone: send SMS OTP via Twilio Verify. |
| `POST /api/auth/verify` | None | Check OTP, create session, set httpOnly cookie, return SAS |
| `POST /api/auth/refresh` | JWT cookie | Verify session, return fresh 30-min SAS |
| `POST /api/auth/logout` | JWT cookie | Delete server-side session, clear cookie |
| `POST /api/tts/generate` | JWT cookie (admin) | Call OpenAI TTS, return audio for preview. On save, write MP3 + XML to blob. |
| `POST /api/voice/token` | JWT cookie | Generate Twilio access token (for future WebRTC in-browser calling) |
| `POST /api/notify/voicemail` | Twilio signature | Receive VM webhook, transcribe via Whisper, send email via SendGrid |
| `GET /api/costs` | JWT cookie (admin) | Fetch Twilio Usage Records + Azure Cost Management + OpenAI log |
| `GET /api/health` | None | Returns 200. Used by SPA heartbeat to keep Container App warm. |

### Deployment

- Azure Container App, Consumption plan
- Region: same as blob storage (e.g. East US)
- Minimum replicas: 0 (scales to zero when idle)
- Cold start: ~2–3 seconds on first request after idle. Acceptable because extension users are waiting for a voice call (takes a moment to connect anyway) and phone users are waiting for an SMS.
- SPA sends a `HEAD /api/health` heartbeat every 4 minutes during active sessions to keep the container warm — all subsequent requests are instant
- On tab close or logout, heartbeat stops, container eventually scales to zero
- Cost: $0/month (well within free tier of 180,000 vCPU-seconds)

### Server-to-blob authentication

The Container App uses Managed Identity to access blob storage. No connection strings or keys in code. Azure handles credential rotation automatically.

---

## SPA Portal (Azure Static Web Apps)

### Deployment

Static frontend only — no API Functions bundled. Served from Azure Static Web Apps free tier. API calls go to the Container App.

### User-facing features

**Call log viewer**
- All users can see the full company call log (shared visibility as specified)
- Filterable by date, extension, direction (inbound/outbound), duration
- Data read directly from blob via SAS token
- Each record includes: timestamp, from, to, extension, duration, status, recording link (if applicable)

**Voicemail viewer**
- Users see their own voicemails (scoped by `userId` in blob path)
- In-browser audio player for playback
- Download option
- Setting to auto-forward new voicemails to email (stored in user config)
- Voicemail list read directly from blob

**Settings**
- Toggle email forwarding for voicemails
- Toggle voicemail transcription (OpenAI Whisper)
- View current extension assignment
- View forwarded-to phone number (admin-managed, read-only for users)

### Voicemail to email

When a voicemail is recorded and the user has email forwarding enabled:

1. Twilio Function receives the recording completion webhook
2. Function downloads the MP3 from Twilio, stores it in blob
3. If transcription is enabled, Function sends audio to OpenAI Whisper API for transcription
4. Function calls Twilio SendGrid API to send email with:
   - Caller number and timestamp in subject line
   - Voicemail transcript in email body (if enabled)
   - MP3 file as attachment (or link to portal playback)
   - Link to view in portal
5. Function deletes the recording from Twilio (we have our own copy)

**SendGrid setup:** Free tier (100 emails/day) is more than sufficient for voicemail forwarding. A verified sender domain is configured in SendGrid. The SendGrid API key is stored in Twilio Function environment variables alongside the existing blob SAS tokens.

### Cost dashboard (admin)

The portal includes a cost dashboard that aggregates spending across all system resources in one view:

**Twilio costs** — pulled via the Twilio Usage Records API (`/2010-04-01/Accounts/{AccountSid}/Usage/Records/ThisMonth.json`). Categories include: phone number leases, inbound/outbound minutes, SIP-to-SIP minutes, recordings, Twilio Verify verifications, and SendGrid emails.

**Azure costs** — pulled via Azure Cost Management API or Azure Consumption API. Resources tracked: Blob Storage (capacity + operations), Container App (vCPU-seconds, GiB-seconds), Static Web Apps (free tier), and bandwidth egress.

**OpenAI costs** — tracked by the light server which logs each TTS generation and Whisper transcription call with character/minute counts and costs. Stored in blob at `/config/cost-log.json`.

The dashboard shows: current month total, per-category breakdown, month-over-month trend, and per-service subtotals. Data refreshes each time an admin visits the page.

### Admin-facing features

**User management (phone-primary model)**
- Every user has a phone number (required) — this is their identity for OTP login and where calls forward to
- Extension is optional — only assigned to users with a SIP client (MicroSIP/Zoiper)
- Users without an extension are "forward-only" — calls go directly to their phone number, no PBX involved
- Only users with a SIP-registered extension can make outbound calls (`canCallOut` flag)
- Admin can add a user with just a phone number first, then assign an extension later
- Creates/updates Twilio SIP credentials via API when assigning extensions
- Generates Zoiper QR provisioning codes per extension for zero-touch mobile setup

**IVR menu editor**

The IVR editor separates greeting tabs from menu options:

*Greeting tabs* control only the intro text callers hear first. Menu options are shared across all greetings. Available greeting modes:
- Main (business hours) — default, always active during configured hours
- After hours — activates automatically based on business hours schedule
- Yom Tov / Holiday — custom greetings with scheduling: set start date/time + expiry, or activate immediately. Reverts to main greeting when expired.
- Custom — admin can add unlimited greeting tabs with their own schedules

*On hold message* is a separate setting — not a greeting tab. Plays when a caller is waiting in queue or on hold during a transfer.

*Menu options* are auto-numbered (1, 2, 3...) — admin just provides a label and selects an action type. The system auto-generates the "press 1 for orders, press 2 for shipping..." TTS prompt from the option labels. Admin never types "press X" manually.

Action types per option:
- **Extension (SIP)** — rings a registered SIP endpoint through the PBX
- **Forward to number** — dials a phone number directly, no PBX involvement
- **Ring group** — rings multiple destinations simultaneously (mix of extensions and phone numbers). First to answer gets the call, the rest stop ringing.
- **Voicemail** — plays greeting and records a message (no ring attempt)
- **Submenu** — plays a sub-intro and presents nested options (unlimited depth). Sub-options have the same action types, enabling multi-level menus.
- **Announcement** — plays a message then returns to menu or hangs up

*Fallback chains* — each option that rings something (extension, forward, ring group) has a configurable fallback chain. Admin builds sequences like: ring ext 101 → no answer → forward to +1 (555) 123-4567 → no answer → try +1 (555) 999-0000 → voicemail. Multiple fallback steps supported.

*Whisper announcements* — when calls are forwarded to a phone number, the agent hears a brief spoken announcement before connecting (e.g. "Incoming orders call"). Caller hears normal ringing during this time. Configurable per option.

*TTS preview* — every greeting, voicemail message, and announcement has a "Preview" button. Clicking it calls the OpenAI TTS API, generates audio, and plays it in the browser. Admin can listen, adjust text, preview again, then save. "Save & generate audio" generates ALL audio files for the current menu in one operation.

**Conference calling**
Between extension users only — handled entirely by the SIP client (MicroSIP/Zoiper). User presses Hold, dials another extension, presses Conference/Merge. Standard SIP behavior, Twilio handles media mixing. No IVR changes, no portal changes, no additional Twilio Functions needed.

**Active sessions**
- View all currently logged-in users
- Kill any session instantly (invalidates JWT, SAS token stops refreshing)

### SPA keep-alive heartbeat

```javascript
let heartbeat;

function startHeartbeat() {
  heartbeat = setInterval(() => {
    fetch("/api/health", { method: "HEAD" });
  }, 4 * 60 * 1000); // every 4 minutes
}

function stopHeartbeat() {
  clearInterval(heartbeat);
}

window.addEventListener("beforeunload", stopHeartbeat);
```

Container Apps idle timeout is 5 minutes. Pinging every 4 minutes keeps the container warm for the duration of the user's session. On tab close or logout, the heartbeat stops and the container eventually scales to zero.

---

## Desktop and Mobile Clients

### Strategy

MicroSIP for lightweight Windows desk use. Zoiper as the cross-platform option covering desktop, mobile, and web — with QR provisioning for zero-touch setup.

### MicroSIP (Windows desk users)

- Open source, ~10MB, minimal resource usage
- TLS/SRTP encryption included
- Admin distributes a pre-configured `.ini` file with Twilio SIP credentials
- Works with USB desk phones and headsets
- Registers directly to Twilio SIP Domain

**Configuration:**

```ini
[Settings]
sipServer=yourcompany.sip.us1.twilio.com
sipTransport=TLS
account=101
password=****
```

### Zoiper (cross-platform — desktop, iOS, Android)

- Available on Windows, Mac, Linux, iOS, Android
- QR code provisioning — admin generates code, user scans, done
- Push notification support on mobile (rings even when backgrounded)
- TLS/SRTP encryption in Pro version
- Proven Twilio compatibility

**Cost:**

| Platform | Cost |
|---|---|
| Desktop (Win/Mac/Linux) | Free or ~€40 one-time for Pro |
| iOS | $9.99/year |
| Android | Free or $6.99 one-time for Pro |

**SIP configuration (same for all clients):**

```
Server:     yourcompany.sip.us1.twilio.com
Username:   {extension number}
Password:   {from Twilio credential list}
Transport:  TLS
```

### Call routing behavior

All registered SIP clients for the same extension ring simultaneously. User answers on whichever device they prefer. Unanswered calls follow the timeout path defined in the IVR (voicemail, forward to phone, etc.).

Internal extension-to-extension calls (e.g. 101 dials 102) are routed SIP-to-SIP through Twilio at no PSTN cost.

### Future option: WebRTC in-browser calling

The `/api/voice/token` server route is already planned. When ready, embedding Twilio's Voice JS SDK into the SPA portal would allow users to make and receive calls directly in the browser — no softphone install needed. This is a Phase 2 enhancement that doesn't require architectural changes.

---

## Data Model

### Call log record (`/logs/{date}/{callId}.json`)

```json
{
  "callId": "CA-xxxxxxx",
  "timestamp": "2026-05-18T14:30:00Z",
  "direction": "inbound",
  "from": "+15551234567",
  "to": "+15559876543",
  "extensionAtTime": "101",
  "userId": "usr-001",
  "duration": 145,
  "status": "completed",
  "recordingUrl": null,
  "voicemailUrl": null
}
```

### Voicemail record (`/voicemail/{userId}/{timestamp}.mp3`)

Metadata stored alongside as `.json`:

```json
{
  "voicemailId": "vm-001",
  "userId": "usr-001",
  "extensionAtTime": "101",
  "callerNumber": "+15551234567",
  "timestamp": "2026-05-18T14:35:00Z",
  "duration": 32,
  "audioFile": "2026-05-18T143500.mp3",
  "forwaredToEmail": true,
  "listened": false
}
```

### Session record (`/sessions/{sessionId}.json`)

```json
{
  "sessionId": "sess-abc123",
  "userId": "usr-001",
  "extensionAtLogin": "101",
  "createdAt": "2026-05-18T10:00:00Z",
  "expiresAt": "2026-05-18T18:00:00Z",
  "active": true
}
```

---

## Security Summary

| Layer | Mechanism |
|---|---|
| User authentication | OTP via Twilio Verify (no passwords) |
| Admin authentication | Entra ID via MSAL popup |
| Session management | httpOnly JWT cookie + server-side session table |
| Blob access (users) | Short-lived SAS tokens (30-min read, 5-min write) |
| Blob access (admin) | Entra delegated token via MSAL |
| Blob access (server) | Managed Identity (no keys in code) |
| SIP encryption | TLS signaling + SRTP media |
| Token leak mitigation | SAS tokens scoped to user's blob path, short expiry, non-refreshable without valid httpOnly cookie |
| Session termination | Server-side invalidation on logout, admin can kill sessions |

---

## Blob Storage Structure

```
storage-account/
├── ivr/
│   ├── main-menu.xml
│   ├── sales-menu.xml
│   ├── support-menu.xml
│   └── ...
├── audio/
│   ├── ivr/
│   │   ├── main-greeting.mp3
│   │   ├── sales-greeting.mp3
│   │   └── ...
│   └── system/
│       ├── voicemail-prompt.mp3
│       └── invalid-option.mp3
├── voicemail/
│   ├── usr-001/
│   │   ├── 2026-05-18T143500.mp3
│   │   ├── 2026-05-18T143500.json
│   │   └── ...
│   └── usr-002/
│       └── ...
├── logs/
│   ├── 2026-05-18/
│   │   ├── CA-xxxxx.json
│   │   └── ...
│   └── ...
├── config/
│   ├── directory.json
│   ├── ivr-tree.json
│   └── company-settings.json
└── sessions/
    ├── sess-abc123.json
    └── ...
```

---

## Deployment Checklist

### Twilio

- [ ] Create Twilio account, purchase DID phone number(s)
- [ ] Create SIP Domain with registration enabled
- [ ] Create credential list with initial extensions
- [ ] Deploy Serverless Functions (IVR handler, outbound handler, voicemail handler, status webhook)
- [ ] Configure phone number voice webhook to point to IVR function
- [ ] Configure SIP Domain voice URL to point to outbound routing function
- [ ] Enable Twilio Verify for OTP

### Azure

- [ ] Create Azure Blob Storage account in target region
- [ ] Create containers: `ivr`, `audio`, `voicemail`, `logs`, `config`, `sessions`
- [ ] Create Entra App Registration (SPA platform, redirect URI, Storage API permissions)
- [ ] Assign Entra admin group blob IAM roles
- [ ] Deploy Container App with Managed Identity
- [ ] Assign Managed Identity blob contributor role
- [ ] Deploy SPA to Azure Static Web Apps
- [ ] Configure custom domain and SSL

### Configuration

- [ ] Upload initial IVR tree JSON to blob
- [ ] Upload initial directory JSON to blob
- [ ] Generate initial TTS greetings and upload to blob
- [ ] Generate initial TwiML XML and upload to blob
- [ ] Set OpenAI TTS API key in Container App environment variables
- [ ] Set Twilio credentials in Container App environment variables

### Client rollout

- [ ] Distribute MicroSIP with pre-configured `.ini` files to desk users
- [ ] Generate Zoiper QR provisioning codes for mobile users
- [ ] Provide portal URL and login instructions to all users

---

## Phase Roadmap

| Phase | Scope | Effort |
|---|---|---|
| **Phase 1** | Twilio SIP Domain + IVR via blob + MicroSIP on desks + call forwarding for mobile | Already done (Twilio Functions + blob) |
| **Phase 2** | SPA portal (auth, call logs, voicemail viewer) + light server + Zoiper rollout | 4–6 weeks |
| **Phase 3** | Admin panel (extension manager, IVR editor, TTS generation) | 2–3 weeks |
| **Phase 4** | WebRTC in-browser calling via Twilio Voice JS SDK (optional) | 2–3 weeks |
| **Phase 5** | Native mobile app or enhanced PWA (optional, if call forwarding + Zoiper aren't sufficient) | Evaluate later |
