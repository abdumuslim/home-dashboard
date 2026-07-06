# AGENTS.md — Home Dashboard

Always-loaded (Tier-1) guide for AI agents. This file is deliberately small: deep knowledge lives in **Tier-3 topic docs** under `docs/agent/` that you MUST read on demand (see the routing table). Do not guess details that live in a topic doc — read the doc.

## What this is

Home environmental monitoring + device automation dashboard at **https://home.altijwal.com**. Express 5 (Node/TypeScript) backend + React/Vite/Tailwind v4 frontend, PostgreSQL storage, deployed via Docker on a VPS. It collects weather (Ambient Weather WS-2000), air quality (Qingping CGS2 via MQTT), and mains power (custom ESP monitor), and automates 2 Xiaomi air purifiers and 3 TCL split ACs (cloud APIs), including a closed-loop "Smart AC Leveling" controller that keeps total household current under the active source's breaker limit.

```
Browser → Cloudflare → Traefik (VPS) → dashboard container (port 8000) → PostgreSQL (db=home)
```

## Routing table — read the doc BEFORE working on the topic

| If your task touches… | You MUST first read |
|---|---|
| System overview, collectors, data flow, MQTT/ESP payloads, auth (incl. Hermes agent API), push notifications, forecast/bias pipeline, logging, health, performance patterns, full per-file structure | `docs/agent/architecture.md` |
| Database tables, migrations, schema conventions | `docs/agent/database.md` |
| TCL AC cloud protocol: auth chain, IoT shadow, commands, AC models, firmware quirks | `docs/agent/tcl-ac.md` |
| Automations: purifier rules, AC range hysteresis, range slots, fan enforcement, manual-off locks, schedules, timers, presets (server side), beep enforcement | `docs/agent/ac-automations.md` |
| Smart AC Leveling, power budget, shed/restore, calibration, amp models | `docs/agent/ac-leveling.md` |
| Frontend: layout, cards, widgets, presets UI, charts, colors, hooks, sky/solar model | `docs/agent/frontend.md` |
| Prayer times: calculation engine (astronomy-engine), method profiles, BaghdadYMA calibration, `/api/prayer-times`, client API-driven flow | `docs/PRAYER_TIMES_API.md` + `server/src/prayer-engine/README.md` |
| Tests: what exists, fake-timer harness gotchas | `docs/agent/testing.md` |
| Deploying, SSH/VPS, live API debugging, credentials, disk maintenance | `docs/agent/operations.md` ⚠️ local-only (gitignored); if absent, ask the user |

Multiple topics → read multiple docs. The docs cross-link each other; follow links when they point at your task. User preferences, working-style feedback, and known-bug notes live in Claude's auto-memory (see CLAUDE.md), not in this repo.

## Commands

```bash
cd client && npm run dev        # frontend dev (proxies /api/* to https://home.altijwal.com — no local backend needed)
cd server && npx tsc --noEmit   # server type-check
cd client && npx tsc -b         # client type-check
cd client && npx vite build     # client build
cd server && npm test           # server tests (vitest)
```

Deployment is a 3-step pipeline (tarball → scp/ssh rebuild → **regenerate mosquitto passwd**) with exact commands in `docs/agent/operations.md`. Never deploy from memory — the mosquitto step is mandatory after every tar extract or MQTT silently breaks.

## Hard rules (violating these has bitten us before)

1. **Never commit secrets.** `CLAUDE.md` and `docs/agent/operations.md` are gitignored because they contain credentials/VPS details — never copy their contents into committed files, and never `git add -f` them.
2. **AC manual-off locks are sacred:** never auto-clear a manual-off lock from temperature thresholds; only an explicit/observed manual-on clears it. But **classification comes first**: an OBSERVED (un-commanded) off near a power event (changeover/blackout/collapse/ESP gap, or a power-loss shadow fingerprint) is a power-loss off and must NOT record a lock in the first place (`docs/agent/ac-automations.md` → Manual-off locks).
3. **Range-slot fields:** any new field on automation range slots MUST be added to the `normalizeRangeSlots()` whitelist in `server/src/automation-slots.ts` or it is silently dropped on save.
4. **Preset slots:** never hardcode preset slot arrays — derive from `PRESET_COUNT`/`PRESET_SLOTS` in `ac-widget.tsx` (slots are 1–10).
5. **Managed ACs are never left at generator level 0** (unrestricted) — leveling invariants in `docs/agent/ac-leveling.md`.
6. **Never run `docker image prune -a` on the VPS** without reading the warning in `docs/agent/operations.md` (it deletes the on-demand `iraq-law-checker` image).
7. **Smart-auto over built-in auto:** device built-in "auto" modes are replaced by server-computed delta logic (pure functions + tests); manual user changes always win over automation enforcement.
8. **VPS clock is UTC, household is Baghdad (UTC+3, no DST)** — all time-window/prayer logic must convert; see the timezone gotcha in `docs/agent/architecture.md`.
9. New columns/tables go through the `MIGRATIONS` list in `server/src/database.ts` (`docs/agent/database.md`).
10. **Prayer times = `prayer-engine` (BaghdadYMA profile via `server/src/prayer.ts`); the client is API-driven (`/api/prayer-times`).** Never reintroduce `adhan` or client-side prayer math. Retune Baghdad only by editing angles/offsets in `prayer-engine/methods.ts`, then re-run `calibrate.ts` + `prayer-engine.test.ts` (keep ≤1 min vs the printed calendar). Engine loads astronomy-engine via `createRequire` (tsx/vitest CJS/ESM gotcha — do not switch to a named ESM import); details in `server/src/prayer-engine/README.md`.

## Project structure (compact — full per-file annotations in docs/agent/architecture.md)

```
server/src/      Express app: index.ts (wiring), routes.ts (REST API), collector.ts (polling + automation loop),
                 tcl-cloud.ts / xiaomi-cloud.ts (device clouds), ac-leveling.ts + ac-leveler.ts (leveling),
                 ac-calibration.ts, ac-auto-fan.ts, automation-slots.ts, alert-metrics.ts, forecast.ts,
                 prayer.ts (Baghdad wrapper) + prayer-engine/ (standalone GPS prayer-time engine),
                 auth.ts, database.ts, config.ts, logger.ts, calibrate.ts (offline bias-table script), *.test.ts
client/src/      React app: components/ (cards, sections, widgets, ui/), hooks/, types/, constants/
mosquitto/       MQTT broker config (passwd generated on VPS — see operations doc)
docs/agent/      Tier-3 agent docs (this routing table's targets)
Dockerfile, docker-compose.yml   multi-stage build; dashboard + mosquitto services
```

## Conventions

- Conventional commits (`feat:`/`fix:`/`docs:`…). Vitest for server tests; regressions found live always get a named regression test.
- Structured logging via pino `childLogger("component")` — no bare `console.log` in server code.
- Documentation tiers: update the relevant `docs/agent/*.md` when behavior changes; keep this file and CLAUDE.md small (routing + rules only).
