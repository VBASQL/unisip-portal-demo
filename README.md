# UniSip — Phone System Portal Demo

Interactive stakeholder demo for the UniSip cloud phone system.

## What this is

A fully interactive React prototype showing the complete phone system portal — IVR menu editor, call logs, voicemail viewer, extension management, cost dashboard, and authentication flows. All data is simulated in-memory; no backend required.

## Features demonstrated

- **Login** — Extension (voice call OTP), Phone number (SMS OTP), Admin (Microsoft Entra)
- **IVR Menu Editor** — Multi-level menus, auto-numbered options, action types (Extension/SIP, Ring group, Forward to number, Voicemail, Submenu, Announcement), fallback chains, whisper announcements, TTS preview simulation
- **Greeting tabs** — Main, After Hours, Yom Tov with scheduling (start/expiry dates)
- **Call logs** — Full history with direction, IVR path, duration, status
- **Voicemail** — Expandable audio player, unread indicators
- **Extension management** — Phone-primary model, optional SIP extensions, outbound call control
- **Cost dashboard** — Twilio, Azure, OpenAI breakdown with monthly trend
- **Role toggle** — Click username in sidebar to switch Admin/User view

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Build for production

```bash
npm run build
```

Static files output to `dist/` — deploy anywhere (Vercel, Netlify, Azure Static Web Apps, GitHub Pages).

## Architecture docs

See the companion design documents:
- `docs/phone-system-design-document.md` — High-level architecture, auth flows, resource map
- `docs/phone-system-technical-plan.md` — Twilio Functions code, data models, blob structure

## Tech stack

- React 19 + Vite
- Zero dependencies beyond React (no UI library, no state management)
- Single-file app (~650 lines)
- All styles inline (no CSS files)
