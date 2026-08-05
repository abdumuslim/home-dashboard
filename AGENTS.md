# AGENTS.md — Home Dashboard

Always-loaded (Tier-1) guide for AI agents. This file is deliberately small: deep knowledge lives in **Tier-3 topic docs** under `docs/agent/` that you MUST read on demand (see the routing table). Do not guess details that live in a topic doc — read the doc.

## What this is

Home environmental monitoring + device automation dashboard at **https://home.altijwal.com**. Express 5 (Node/TypeScript) backend + React/Vite/Tailwind v4 frontend, PostgreSQL storage, deployed via Docker on a VPS. It collects weather (Ambient Weather WS-2000), air quality (Qingping CGS2 via MQTT), and mains power (custom ESP monitor), and automates 2 Xiaomi air purifiers and 3 TCL split ACs (cloud APIs), including a closed-loop "Smart AC Leveling" controller that keeps total household current under the active source's breaker limit.

```
Browser → Cloudflare → Traefik (VPS) → dashboard container (port 8000) → PostgreSQL (db=home)
```

## Routing table — read the doc BEFORE working on the topic

**The trigger is the ARTIFACT you are about to produce, not the topic you think you are on.** About
to write SQL → read `database.md` first, even if you call it "just a quick diagnostic query". About
to SSH or curl the live system → `operations.md`, even if you call it "just checking a value". About
to touch a test harness → `testing.md`. This binds on throwaway diagnostics and one-off commands
exactly as hard as on feature work — that framing is what failed on 2026-07-28, when "I'm debugging
leveling, not doing database work" produced SQL against invented column names while the real schema
sat documented in `database.md`, and a live-debugging login was re-derived from scratch with the
working recipe already in `operations.md`.

**Corollary — verify, never invent.** If you are typing a table name, column name, endpoint path,
container name, env var, or file path you have not seen with your own eyes *this session*, stop and
read the doc or query the source. A plausible guess that happens to be wrong costs more than the
lookup, every time.

| If you are about to touch… | You MUST first read |
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
2. **AC manual-off locks are sacred:** never auto-clear a manual-off lock from temperature thresholds; only an explicit/observed manual-on clears it. But **classification comes first**: an OBSERVED (un-commanded) off near a power event (changeover/blackout/collapse/ESP gap, or a power-loss shadow fingerprint) is a power-loss off and must NOT record a lock in the first place (`docs/agent/ac-automations.md` → Manual-off locks). And a release must be **LOUD**: every path that clears a lock announces it — the `set_power=1` route claims its release BEFORE the cloud send (the shadow echo of our own ON otherwise lets the device-poll reconciler steal the release silently and the actor-naming push is lost; 2026-08-05, a full forensic hunt for the user's own click). A new clear call site must notify or hand the release to a caller that does.
3. **Range-slot fields:** any new field on automation range slots MUST be added to the `normalizeRangeSlots()` whitelist in `server/src/automation-slots.ts` or it is silently dropped on save.
4. **Preset slots:** never hardcode preset slot arrays — derive from `PRESET_COUNT`/`PRESET_SLOTS` in `ac-widget.tsx` (slots are 1–10).
5. **Managed ACs are never left at generator level 0** (unrestricted) — leveling invariants in `docs/agent/ac-leveling.md`.
5b. **Never infer a physical event from meter shape alone, and never take a cost sample shorter than the physics it measures.** A drop we commanded looks exactly like a breaker trip (2026-07-28: shedding the last ACs latched a 5-min freeze + limit derate for a blackout that never happened), and a 45 s grade of a 240 s compressor ramp taught the cost model that raises are free. Third instance of the same class (2026-08-01): never sample a **residual** while the model and the meter are out of step — a turn-off's dying draw was booked as 7.1 A of phantom "house" and froze all raises for 14 min (fix: modeled-drop cooldown + boot quiet, ac-leveling SKILL invariant 20). Fourth instance (2026-08-02), grading path: a lone shed's off-drop graded a peer's still-landing cut into that room's on-cost (−4.03 A booked vs −2.3 true) and the inflated price stranded the room shed for 17 min (fix: grade windows born inside another batch's settle window never learn, SKILL invariants 22–23). Fifth and sixth instances (2026-08-02), both rise-side: an **unconfirmed ON** — ours or a household member's — books its whole compressor as "house" load (the shadow gates both `runningSetOf` and `ramping`), and a **lone shed of a still-ramping room** grades peak-minus-trough as that room's on-cost, one-way and sticky for 30 days. Same class as 5b, 20 and 23. Both classes of bug are silent — the system reports healthy while acting on fiction. Full invariants in `docs/agent/ac-leveling.md`.
5d. **A generator is not a stable line.** Its ~±1 A flicker is not load: classify raw over-limit readings against the measured flicker and judge calm on the SMOOTHED meter, never per raw reading — otherwise the over-limit bucket becomes a one-way ratchet that sheds a room while the mean sits *under* the limit (2026-08-02, five times in fifteen minutes). The smoothed overshoot is never discounted, which is what preserves a real overload's reaction time. And the reduction ladder ends **levels → fans → sub-floor levels → ONE room off**: a comfort floor is a preference, being switched off is not, and re-asserting that floor outside the raise path is a limit cycle. Invariants 24–29 in the `ac-leveling` SKILL.
5e. **The residual is the HOUSE, and a trough you cannot explain is not headroom.** Third instance of 5c, and the costliest: the power-collapse latch required the meter to fall to an absolute 5 A, silently assuming everything but the ACs draws less than that. On 2026-08-02 the AC circuit died twice on the generator with the house still drawing **5.76–6.2 A** — neither break latched, so no derate, no freeze, no FLOORS on recovery. The post-trip trough then read as *perfect calm* and the controller raised three levels into a dead line, causing the second break four minutes after the first. The floor is now relative to the pre-fall mean, every off we can know about is credited so the floor cannot confuse a trip with someone switching off the biggest room, and an unexplained fall stands calm down for two minutes. Corollary: **severity must escalate on TIME as well as magnitude** — a mean 0.6–1.0 A over is "mild" forever, and mild can only answer with level cuts whose compressors wind down over minutes the breaker does not have (invariants 31–33).

5c. **A guard must be sized against the whole quantity it guards.** Both halves of the 2026-07-31 gen trip were this: the physics envelope guarded a *breaker* but summed only the *AC* cap models, so it admitted an end-state it priced at 13.9 A that the meter then measured at 15.95 A; and the post-act over-limit bucket, meant to prevent double-cuts, was set to 2 while a single severe reading drains 3 — one stale reading shed a second room 16 s after the first. Before shipping any threshold, write down the largest single increment that can consume it and the full set of loads it is compared against. Both classes are silent: the system reports healthy while acting on fiction. Full invariants in `docs/agent/ac-leveling.md`.
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
