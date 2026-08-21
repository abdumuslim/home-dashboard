---
type: Plan
title: 'CT02 open-firmware flash plan (option E)'
description: 'Turn-by-turn workbook for flashing the QS-WIFI-S04-CT02 to send power readings directly to our server — alternating Claude/Abdu steps with hard gates and a CURRENT STEP pointer'
tags: [home, dashboard, power, tuya, claude-code, current]
maintainer: claude-code
timestamp: 2026-08-19
---

# CT02 flashing plan (option E) — the turn-by-turn workbook

**Goal:** flash the QS-WIFI-S04-CT02 with open firmware (OpenBeken or ESPHome/LibreTiny) so it
sends both clamp currents + voltage **directly to our server** every 1–5 s — no Tuya cloud, no
zombie states (2 offline episodes in the cloud shadow's first 24 h: one 43-min self-healed, one
needing a manual power-cycle). Chosen by the user 2026-08-18 over option C (LAN box). The cloud
shadow feed (P2, commit `9f6aea9`) **keeps running untouched until F6**.

**Session starter:** `Continue the CT02 flashing plan — read docs/CT02_FLASH_PLAN.md and pick
up at the CURRENT STEP marker.`

**Ground rules (SINGLE-UNIT plan — user decision 2026-08-19, no second unit):** we flash the
one paired unit, so the **factory-firmware backup is sacred**: F2 reads the flash TWICE,
compares SHA256, and stores copies in TWO places before anything is written. Restoring that
dump returns the device to full Tuya/cloud function (keys live in flash — no re-pairing).
The cloud shadow feed is DOWN while the unit is on the bench (fail-safe: ESP authoritative,
staleness honest) and permanently once open firmware is written — F4 failure path = restore
the dump → shadow feed resumes → fall back to option C. Never re-pair in the app at any point
(the local_key rotates and invalidates the banked one). Every phase ends at a GATE — do not
skip. Update the CURRENT STEP line after every completed step. Device identity, credentials,
DP table, and the P0–P2 history: `docs/agent/operations.md` → "Tuya / ZheerHome CT02"
(local-only/gitignored) and the project auto-memory.

## ⟦CURRENT STEP: **F4 SUBSTANTIALLY PASSED 2026-08-21 late evening — FACTORY CALIBRATION CONFIRMED, NO TRIM NEEDED (KU/KIA/KIB stay 1.0).** Clamp A (on Abdu's-AC line, the P1 placement) validated across the range: idle 0.18 A, full grid-level compressor **plateau 4.14 A vs the stock-firmware P1 log's 4.27–4.53 A p25–p75 on the SAME conductor** — within day-to-day variance. Clamp B correctly reads 0.000 (its conductor was zero in the P1 era too — NOT a fault); **B's live-load spot-check is the one F4 residual** (move clamp B onto a live conductor once, watch it read). Voltage 215 V / 49.56 Hz grid — plausible; no independent reference exists (ESP's voltage field is unused/always 0) — optional later: multimeter → trim KU. 0 RX errors all session. ⚠ 2026-08-21 lesson: a wrong 40× KIA trim was applied for ~2 min from misidentifying clamp A's conductor (coincidental ratio-tracking vs the ESP) — REVERTED; **always confirm clamp placement with the user before trimming.** NEXT = **F5: server integration** — MQTT feed (device topic `ln882hC25E1088`, broker = our VPS mosquitto; EXTEND the mosquitto passwd-regen recipe or deploys silently kill the feed!), server-side subscriber → shadow-ingest path, tests + implementer/Codex review per policy, ≥48 h side-by-side vs ESP. Then F6 (clamps→mains, promotion detector).⟧

## ⟦F3-STAGE-2 RECORD (2026-08-21) — custom driver build, review, OTA, bring-up⟧

- **Driver:** NEW `src/driver/drv_hlw8112_uart.c` in OpenBK7231T_App (+ gate `ENABLE_DRIVER_HLW8112UART`
  in the `PLATFORM_LN882H` block, table entry `"HLW8112"`, prototypes in `drv_local.h`, source listed in
  `platforms/obk_main.cmake`, 9-bit-word-when-parity fix in `hal_uart_ln882h.c`). **Transport = OpenBeken's
  existing generic UART (UART2 peripheral, already pinned PA2/PA3)** — NOT UART1 (its IRQ symbol is owned by
  the SDK's `serial_hw.c`; UART2-on-the-same-pads is electrically identical). Protocol: 9600 **8E1** (works),
  runtime-overridable `startDriver HLW8112 [baud] [parity 0/1/2]`; frames `[0xA5][reg…][~sum]` per datasheet;
  init SYSCON=0x0F04, EMUCON=0x0003, HFConst=0x1103, EMUCON2=0x03FF; coefficients 0x70–0x77 validated against
  0x6F checksum. Energy accumulation is **RAM-only on LN882H** (flash-vars API absent — documented in the
  driver + MANIFEST). Trim commands mirror the SPI driver (`HLW8112_SetResistorGain`, `clear_energy`).
- **Review trail:** Fable review + **Codex gpt-5.6-sol xhigh ×2** — round 1 FIX-FIRST (5 findings, all fixed:
  clear-on-read energy commit-per-read, dead PF/apparent channels removed, restore-once-per-boot, trim
  validation, parity-3 9N1 edge), round 2 all RESOLVED + 1 new (baud=0 div-by-zero → clamped). Build green.
- **Build recipe (WSL Ubuntu 24.04, works):** repo `D:\dev\ct02-obk\OpenBK7231T_App` (+ `sdk/OpenLN882H`
  submodule), CI-pinned gcc-arm 10.3-2021.10 in `~/toolchains` (WSL), `apt: build-essential cmake srecord`;
  `make APP_VERSION=<v> APP_NAME=OpenLN882H VARIANT=default OpenLN882H` → `output/<v>/OpenLN882H_<v>.bin`
  + `_OTA.bin`. Spec + staging in `D:\dev\ct02-obk\` (`HLW8112_UART_IMPLEMENTATION_SPEC.md`, `staging/`).
  Big TLS downloads flake on Windows (git/IWR die mid-pack) — **use curl.exe with `--retry`, or WSL-side.**
- **OTA (proven):** `curl --data-binary @<..._OTA.bin> http://192.168.51.164/api/ota` (200 + `{"size":N}`)
  → `curl -X POST http://192.168.51.164/api/reboot` → back in ~10 s. Safe Mode (5 failed boots) fences the
  driver and reopens the web server — OTA is the recovery path too; the UART rig is retired to undo-only.
- **⚠ Bench gotcha (cost ~1 h):** the **HLW8112 is powered from the mains-side supply only** — on stick-USB
  bench power the WL2S runs but the meter chip is DEAD (all reads time out). Meter bring-up/tests need the
  unit on mains (wireless-only then: NEVER PC-wired while mains-connected). Also: the status **LED glows dim
  under OpenBeken** — the stock LED pin isn't configured yet (floating GPIO); assign the pin role in the web
  UI later if wanted.
- Startup command set + reboot-verified: `startcmd: "startDriver HLW8112"`.

## ⟦RESUME CHECKPOINT — F3 Stage-1 validation flash (2026-08-21)⟧

**Decision — staged F3:** flash STOCK OpenBeken first (validate flash+boot+Wi-Fi), THEN a 2nd flash
with the custom HLW8112 driver. Image for stage 1: **`C:\Users\Abdu\.tuya-ct02\firmware\OpenLN882H_1.18.302.bin`**
(official OpenBeken LN882H release, SHA256 `C308C01F…AD175`). Metering won't work after stage 1 —
expected (no driver yet). **Nothing has been erased or written — factory firmware intact; backup1.bin
is still a valid restore.**

**⚠ TOOL BUG — ROOT CAUSE REVISED 2026-08-21 (the 460k patch was NOT enough; do not lose this):**
`SharpLN882HTool.exe -wf` hard-codes `change_baudrate(921600)`, and the earlier diagnosis ("link
can't hold 921600, 460800 is fine") was WRONG — a 460800-patched copy (`SharpLN882HTool_460k.exe`)
hung at the exact same re-sync. Source reading (github openshwprojects/SharpLN882HTool,
`LN882HFlasher.cs`) showed why: **the successful F2 reads never exercise the loader's `baudrate`
command at all** (`read_flash_to_file` bakes the baud into the dumper RAMCODE bytes before upload),
while the write path sends `baudrate <n>\r\n` and **immediately** reassigns `_port.BaudRate` — on
this CH340 the switch clobbers the command tail still in the TX FIFO, so the loader stays at 115200
while the host moves, deadlocking at ANY target speed. **Fix = don't change baud at all:
`SharpLN882HTool_115k.exe`** (stock exe, write-path ldc.i4 @0x10B1 operand → 115200; bytes
0x10B3/0x10B4 = C2 01; only 2 bytes differ from stock). `change_baudrate(115200)` is then harmless
whether or not the loader parses the command — both sides stay at 115200. Write of the 735 KB image
takes ~2 min. **USE `SharpLN882HTool_115k.exe` FOR ALL WRITES** (`_460k.exe` is dead, kept only as
provenance). Reads may keep using stock `-rf 460800`.

**Last blocker when paused:** the patched write stalled at the *initial* boot-ROM sync (chip not
answering "version") — i.e. the chip was NOT in download mode → **A9→GND jumper likely worked loose
during power-cycling.** (Every prior run — 2×`-i`, 2 reads, and the 1st write attempt — connected
first try, so the rig/wiring/pins are all proven; this is just the removable A9 clip.)

**RESUME STEPS — ✅ EXECUTED 2026-08-21 (steps 1–5 done; write succeeded via `_115k.exe`, not
`_460k.exe` — see revised tool-bug note above). Only step 6 (first boot) remains:**
1. **Re-seat the A9→GND jumper** so it solidly connects the `A9` pad to a `GND` pad.
2. Power-cycle: unplug stick from USB, 5 s, replug (A9 grounded).
3. **Non-destructive confirm:** run `SharpLN882HTool_460k.exe -p COM3 -i` (or the stock exe — `-i`
   is identical). Success = it prints flash id `0xEB6015` / 2 MB / UID `0x43313231…`. If it still
   hangs → A9 still not grounded (or chip not in boot mode); re-check the jumper.
4. Power-cycle again (RAMCODE-loaded-per-invocation gotcha: every tool run needs a fresh power-cycle).
5. **Write:** `SharpLN882HTool_460k.exe -p COM3 -wf C:\Users\Abdu\.tuya-ct02\firmware\OpenLN882H_1.18.302.bin`
   — expect: ram-loader upload @115200 → `change_baudrate 460800` → startaddr/upgrade → YModem file
   send → `filecount` → `Flash done!`. ~1–2 min. (Run it backgrounded + watch the output file.)
6. On `Flash done!`: **unplug, REMOVE the A9 jumper**, power on normally (via stick USB is fine).
   Device should boot OpenBeken → broadcast open AP `OpenLN882H_XXXX` / `OpenBK_XXXX`. Connect a
   phone/PC, browse `192.168.4.1`, set home Wi-Fi. That validates Stage 1.

**Then F3 Stage-2 (Claude builds, next write session):** build OpenBeken LN882H with a custom
`drv_hlw8112_uart` (UART1 = **PA2 TX / PA3 RX**; keep OpenBeken log console OFF PA2/PA3 → UART0/GPIOB9;
frame `[0xA5][0xEA][reg|wr][data MSB-first][~sum]`; init regs reg0=0xF04/0xEC3/0xE82(temp)+reg2=0x1103
+reg0x13=0x3FF; calibration chip-resident). Plan: `candidates/HLW8112_DRIVER_PLAN.md`. Then 2nd flash
(same patched-tool recipe), then F4 light calibration trim, F5 MQTT server integration, F6 mains.

---

## ⟦(prior) F3 prep — COMPLETE: interface = UART1 on PA2/PA3 (HIGH conf, disasm-proven)⟧

**2026-08-21 — UART1 GPIO pins RESOLVED (capstone disasm, HIGH confidence): HLW8112 sits on
`GPIOA_2 (PA2) = UART1_TX` and `GPIOA_3 (PA3) = UART1_RX`.** Proven at call site exec 0x1001769C:
`hal_gpio_pin_afio_select(GPIOA_BASE, PIN_2, UART1_TX=6)` + `(GPIOA_BASE, PIN_3, UART1_RX=7)`,
literals resolved against flash bytes. **Elegant consequence — PA2/PA3 are the SAME physical pins
as the flash/download header:** the boot ROM uses PA2/PA3 for serial download (what LibreTiny
calls the "flashing port"; our front `TX`/`RX` pads), and the running app re-muxes those same pins
to UART1 for the meter (the back `RX1`/`TX1` pads). Front `TX/RX` and back `RX1/TX1` are therefore
the same net. The stock app's OWN log console is UART0 on `GPIOB_9` (separate) — the disasm found a
sibling `UART0_TX → GPIOB9` mux, confirming the split.
- **⚠ F3 driver design constraint (the one thing this creates):** OpenBeken's LN882H build must NOT
  put its log console on PA2/PA3 — those belong to the HLW8112 UART1 driver. Point OpenBeken's
  console at UART0/GPIOB9 (as stock does) or disable it, and bind `drv_hlw8112_uart` to UART1
  (PA2/PA3). Otherwise console spew and meter traffic collide on one bus.
- Optional physical confirmation (2 min, at F3 start): continuity-beep front `TX`↔back `TX1` and
  front `RX`↔back `RX1` — they should beep (same net). A scope on RX1/TX1 at boot shows async
  serial, not SPI.
- **F3 prep is now complete on the analysis side** — interface, frame format, init presets,
  calibration model, AND pins are all known. Remaining F3 work is pure build+write (Claude builds
  the image + driver; user runs the flash-write session with the rig still wired).

**2026-08-21 — dump analysis COMPLETE (capstone disasm vs the official lightningsemi/ln882h SDK;
`C:\Users\Abdu\.tuya-ct02\analysis\ANALYSIS.md`, Fable-reviewed). The last architectural fork is
RESOLVED:**
- **INTERFACE = UART, HIGH confidence.** The stock driver drives the HLW8112 over **LN882H UART1
  (base 0x40003000)**. Proven by tracing `Init_HLW8112` → register-write wrapper (frames
  `[0xA5][0xEA][reg|writebit][data MSB-first][~sum checksum]` — classic HLW UART format) → a
  byte-poll TX loop → the SDK's generic UART HAL that branches on 0x40002000/3000/4000; `UART1_BASE`
  literals sit inside that HAL and **`SPI0/1_BASE` appear NOWHERE in the 2 MB image.** The board's
  `RX1 TX1` back-side pads = LN882H UART1 RX/TX. **→ Driver Variant 1 (`drv_hlw8112_uart`,
  BL0942-pattern) is THE path; the soft-SPI variant is dropped. No SPI HAL needed.**
- **Concrete driver facts extracted:** init register presets reg0 = 0xF04/0xEC3/0xE82
  (temp-banded ≤70 / 70–130 / >130 °C), then reg2 = 0x1103, reg0x13 = 0x3FF; sample normalization
  constants 2^-23 and 1000.0.
- **Calibration is CHIP-RESIDENT, not a flash blob:** the on-flash `setting` KV record is all-zero;
  K1a/K1a2/K1b/K2 are recomputed every boot from live HLW8112 register reads (5-sample average).
  So our driver reads the same coefficient registers and gets the same per-unit trim — **factory
  calibration effectively travels in the HLW8112 itself; F4 recalibration may be a light trim, not
  a from-scratch cal.**
- **Restore story CONFIRMED solid:** Wi-Fi station config is in the flash dump; Tuya identity
  (uuid/auth_key/local_key) is NOT in flash — almost certainly in the LN882H **eFuse** (untouched
  by flashing). So restoring backup1.bin to THIS chip returns full factory/Tuya function without
  re-pairing. The dump is a valid undo.
- **Partition map (for the writer):** BOOT 0x0–0x6000 · PART_TAB 0x6000–0x7000 (holds boot baud
  0xE1000=921600, ATE addr) · APP 0x7100–~0xF0150 (exec base 0x10007100) · ~840 KB blank incl.
  unwritten OTA slot · NVDS/KV 0x1C2000–~0x1E2000 · ~84 KB high-entropy tail 0x1EB000–0x200000
  (unidentified, unrelated to metering).
- **⚠ Remaining F3-prep gap:** which physical LN882H GPIO pins are muxed to UART1 on this board
  (the OpenBeken driver needs the pin numbers to bind UART1 RX/TX). Extract from the dump's pinmux
  config next, or trace `RX1`/`TX1` pads → module castellations with a meter.

**2026-08-21 ~10:45–11:15 — F2 bench session SUCCEEDED on the first attempt:**
- Wiring per FLASHING_WL2S.md §1 worked as drawn (TX/RX orientation guess was right; stick-3V3
  powering sufficient; A9→GND jumper entered download mode first try).
- `-i`: flash id `0xEB6015`, **2 MB**, flash UID `0x433132313833372E30300700D20055FF`
  (OTP MAC blank; `get_m_local_mac` placeholder 10:10:10:10:10:10).
- **Backups: 3 full reads, 2 tools, ONE hash** — `backup1.bin` + `backup2.bin`
  (SharpLN882HTool, 460800, 47.5 s each, power-cycle between) + `backup3_ltchiptool.bin`
  (ltchiptool @115200, 329 s) — **all SHA256
  `E471993BD33F8C349AFA52F8BFB7859E6D9511889F546035D8CA38A007009373`**, 2,097,152 bytes each.
  Stored: `C:\Users\Abdu\.tuya-ct02\firmware\` + VPS `/root/ct02-backup/` (remote-hash-verified).
- Gotcha for future sessions: **the tool needs the chip freshly power-cycled per invocation**
  (a prior run leaves RAMCODE loaded; the next sync then hangs → the one 10-min timeout of the
  session). Power-cycle with A9 held low before every SharpLN882HTool/ltchiptool run.
- Dump sanity: ARM vector table at 0x0, ~49.5% 0xFF (normal), strings `tuya`/`ssid`/`wifi`/
  `LN882` present — and **`hlw`@0xDC294 + `HLW`@0xDC4C5: the stock app drives the HLW8112
  directly, confirmed from the binary itself.**
- Remaining F2 work (Claude, offline): carve the Tuya config/KV partition, determine the
  HLW8112 interface (UART vs SPI) + exact pins from the stock app's config/strings, confirm
  restore-completeness (Wi-Fi/local_key material present in dump).

**2026-08-21 — LN882H flash-path research DONE (5-agent workflow, source-verified, drafts
adversarially reviewed + fixed). VERDICT: GO.** Everything needed for F2 is confirmed:
- **WL2S = LN882H locked** (Tuya WL2H-U datasheet + multiple Elektroda WL2S teardowns).
  Flash UART = **TX0/RX0** (our front `TX`/`RX` pads, near-certain; if no handshake, swap).
  **Boot entry = jumper `A9`→GND before power-on and hold it the whole session** (wire jumper —
  the tactile button's relation to A9 is UNCONFIRMED, don't rely on it). Release + power-cycle
  when done.
- **Tools:** primary = **SharpLN882HTool** (OpenBeken author; CLI verified from source:
  `-p COMx -i` info/connectivity, `-rf 460800 backup.bin` full read w/ chip-reported size,
  `-ef` erase, `-wf image.bin` write; handshake always at 115200). Cross-check reader =
  **ltchiptool 4.14.4 (already installed, LN882H listed)** — but its LN882H raw-.bin WRITE path
  had an open bug fix during research → **writes go through SharpLN882HTool only**. Avoid the
  Chinese vendor CMD tool (unverifiable provenance).
- **Image:** OpenBeken `OpenLN882H_<ver>.bin` (release asset `OpenLN882H_1.18.302.bin`
  confirmed to exist). Stock LN882H build ships ENABLE_MQTT (+TuyaMCU+BL0942, both moot now);
  no HTTP push on LN882H → **MQTT is the transport**, as planned. Safe Mode recovery confirmed
  generic (5 fast power-cycles → autoexec+drivers skipped, web server up; `SafeMode 5` for
  staged autoexec tests).
- **Full procedure with the sacred double-read/SHA256/two-location backup gate is written and
  review-verified: `C:\Users\Abdu\.tuya-ct02\candidates\FLASHING_WL2S.md`**. Candidate set
  patched for the HLW8112 reality + Fable-reviewed (2026-08-21): `openbeken_interim_autoexec.txt`
  (Wi-Fi+MQTT only, first boot), `HLW8112_DRIVER_PLAN.md` (custom driver: UART variant vs
  soft-SPI variant, register map RmsIA/IB/U 0x24-0x26, Vref 1.25 V, SetResistorGain calibration
  vs 1R00 burdens + ~1 MΩ divider, upstream endgame); TuyaMCU/BL0942 autoexecs supersede-marked.
- **Adapter status: QUALIFIED ✅ (2026-08-21).** CH340 on COM3 OK; 3V3 pin measures 3.30 V
  (earlier 1.6 V TXD reading was a user wiring slip — round-1 loopback ran with no bridge wire).
  **Loopback PASS: 256/256 bytes intact at 115200/460800/921600, plus 32 KB sustained at 921600
  byte-perfect. TXD idle = 3.30 V vs GND (measured with COM3 held open) → 3.3 V logic →
  DIRECT wiring, no series resistor.** (The two earlier 1.6 V readings were probe-placement
  slips — measured TXD-to-RXD instead of TXD-to-GND.) Adapter cleared on every axis.

**2026-08-21 — Telesky USB-TTL confirmed working: CH340 driver installed (official signed
CH341SER.EXE from wch-ic.com), device enumerates as `USB-SERIAL CH340 (COM3)`, status OK.**

**2026-08-21 — HLW8112 driver-support research verdict (deep web sweep, sources verified):**
- **OpenBeken HAS an HLW8112 driver (`HLW8112SPI`, `src/driver/drv_hlw8112.c`) but it is
  SPI-only AND build-gated to PLATFORM_BEKEN** (`OBK_VARIANT_HLW8112` exists only in the Beken
  block of `obk_config.h`; no LN882H release asset includes it). Calibration commands exist
  (`HLW8112_SetClock`, `HLW8112_SetResistorGain KU KIA KIB`, `HLW8112_SetEnergyStat`,
  `clear_energy`), channels exposed as Current/Power A+B, Energy Import/Export per channel.
- **ESPHome: no mainline HLW8112**; the one external component (BmdOnline/esphome_hlw811x,
  2026-03) is ESP32-only + SPI-only. **LibreTiny's LN882H port has NO SPI or I²C at all**
  (docs.libretiny.eu status page) and native ESPHome LN882H support is an open, unanswered
  feature request → **ESPHome is definitively OUT on the stock module.**
- **Interface discrepancy to resolve:** community HLW8112 Tuya boards (all Beken/Realtek-based:
  PJ-1103A, PM01_A002, PC311-W-TY) are SPI-strapped, but OUR board's `RX1 TX1` pads suggest
  UART mode (HLW8112 is UART/SPI dual-mode via a SEL pin; fixed 9600-baud UART per secondary
  sources — UNCERTAIN). **No WL2S+HLW8112 pairing exists anywhere in the community record —
  we are first.** Resolution paths: F2 dump's GPIO/config analysis, or a multimeter continuity
  beep from RX1/TX1 pads to the HLW8112 pins.
- **Practical bottom line — every route converges on a small custom OpenBeken driver for the
  LN882H build:** if the chip is UART-strapped, write `drv_hlw8112_uart` following the BL0942
  driver pattern (registers RmsIA 0x24 / RmsIB 0x25 / RmsU 0x26, Vref 1.25 V, per the MahdaSystem
  HLW811x reference driver); if SPI-strapped, same driver but **bit-banged soft-SPI over GPIOs**
  (no LN882H SPI HAL needed at our 1–5 s cadence). Reference C drivers exist (MahdaSystem/HLW811x,
  libmcu/hlw811x, BabyOS `b_drv_hlw811x.c`). Fallback option C′ (module transplant to CB2S +
  Beken HLW8112SPI build) exists but is last-resort — custom driver on stock hardware is preferred.
  GO/NO-GO verdict waits only on the LN882H flash-path confirmation (backup read is the sacred
  gate and is driver-independent).

**2026-08-21 ~09:12 — photo #4 (chip close-up) LOCKS the identity: the metering IC is a
Hiliwei HLW8112** (marking `HLW8112 / 2502L1D`, TSSOP-16) — dual current channel + voltage,
UART/SPI selectable. Datasheet pin naming matches the board silkscreen (IAP/IAN/IBP/IBN)
exactly. NOT a BL0939. Consequence: dual-clamp is native to the chip, but the **driver-support
question moves to HLW8112** — OpenBeken support is UNCERTAIN (research running; BL0939/BL0942
are well-supported, HLW8112 may not be). If no driver exists anywhere usable, the fallback is
writing a small OpenBeken C driver against the HLW8112 UART register protocol — feasible, the
protocol is documented — decided at the GO/NO-GO.

**2026-08-21 ~09:05 — photos #2 (full front) + #3 (back) close most of F1:**
- Board model **SM04-2WSY**, rev 251024-VER1. Front holds ONLY the WL2S module + PSU parts;
  **there is NO separate MCU anywhere** — the app's "MCU Module v1.3.1" line is the known
  single-chip-reporting-twice artifact. **The TuyaMCU scenario is effectively dead.**
- Back side: **exactly ONE metering IC** (SSOP/TSSOP ~16-pin) fed by BOTH clamps — terminal
  silkscreen **IBN / IBP / IAN / IAP / ACL / ACN**, per-channel **1R00 burden resistors**, a
  **5× 200 kΩ divider chain** from ACL for voltage sense, and **`RX1 TX1` test pads** routing
  toward the module → the chip speaks UART. Prime suspect: **Belling BL0939** (dual-current-channel
  UART metering IC; OpenBeken and ESPHome both have drivers). One chip, two channels — the old
  "2× BL0942 on a shared UART" worry evaporates if confirmed. Outstanding: a close-up of the
  chip's top marking to lock the identity.
- Flash header confirmed on front: **+5V / GND / GND / 3V3 / RX / TX / A9** — `A9` is suspected
  to be the LN882H boot-strap pin (research verifying). Back `RX1/TX1` = metering-chip UART
  test pads — i.e. flash UART and metering UART appear to be SEPARATE. Ideal topology.
- ⚠️ **Safety:** the PSU is almost certainly a non-isolated mains buck (typical for these
  meters). The standing rule is absolute: never wired to the PC while mains-connected, and give
  the bulk caps a minute to bleed after unplugging from mains.

**2026-08-21 — F1 opened early by photo #1 (front/top of PCB):** the Wi-Fi module is **WL2S**
(label `Model:WL2S  P/N:y9g02y32lud3olto  S/N:ZQRI18SY00452`), board silkscreen `251024-VER1.0:A`
— **NOT the CB2S/BK7231N the S10 sibling teardown suggested.** WL2S is believed to be an
**LN882H**-based module (verification + flash-path research running this session); consequences if
confirmed: ESPHome/LibreTiny is OUT (no LN882H support), OpenBeken remains the path (it has an
LN882H port), and the Beken-specific tools (BK7231GUIFlashTool, bk7231tools) become moot. The
board hands us a labeled program header: **GND / 3V3 / TX / RX / GND / +5V** pads, plus an `A9`
pad and a tactile button — wiring will be easy. Still needed to close F1: **back-side + lower-board
photos** (metering ICs, any separate MCU — the "MCU Module v1.3.1" line still points at TuyaMCU)
and a sharp close-up of the module's castellated pin row (labels read fuzzily as `EN ADC A10 A12 A7`).

**Adapter check (2026-08-21):** the user's USB ISP (AVR SPI programmer) and ST-Link V2 (SWD/SWIM
probe) do **NOT** fit — neither speaks UART, and the chip's ROM bootloader is UART-only. A
**CH340G / CP2102 / FT232 USB-UART adapter is still required.** (The ST-Link's 3.3 V pin could at
most serve as a weak backup bench supply; keep it around for the long-shot case that F1 reveals an
ST metering MCU worth dumping.)

**Firmware version RECORDED (2026-08-19, app Device Update page): Main Module v1.3.1 /
MCU Module v1.3.1.** The separate "MCU Module" line raises the odds this is a **TuyaMCU
architecture** (dedicated metering MCU ↔ Wi-Fi module over the TuyaMCU serial protocol) — if
F1/F2 confirm that, dual-clamp on open firmware becomes EASY (OpenBeken/ESPHome TuyaMCU
support; the shared-UART BL0942 concern evaporates). Identical version strings can also mean a
single-chip design reporting twice — photos decide. ⚠️ The app's **Auto Upgrade toggle was ON**
— user asked to turn it OFF (an OTA mid-plan could shift the mapped DP behavior; a factory
restore would also try to re-upgrade itself).

## F0 findings (2026-08-19 morning, LAN probes from the home PC)

- **Local protocol v3.5** (tinytuya scan) → recent firmware → **tuya-cloudcutter is ruled out;
  serial flash is the confirmed path.** The app's firmware-version string is now only
  nice-to-have (still worth grabbing from device → ✏️ → Device Update before flashing).
- **LAN address `192.168.51.98`** (DHCP — worth pinning a static lease in the router), MAC
  `00:33:7a:32:44:cb`, firmware-level product key `3iiwuobwmyivjk9f` (distinct from the cloud
  product_id — this is the key profile databases index by).
- **OPTION C IS FULLY PROVEN on stock firmware:** tinytuya v3.5 (`set_version(3.5)` +
  persistent socket — the plain constructor arg HANGS, known gotcha) authenticates with the
  banked local_key and `updatedps([6,7,…])` returns **fresh on-demand phase readings ~1–3 s
  apart** (measured live: 6.033 A / 1.265 kW mid-compressor), coexisting with the live cloud
  session. Probe scripts: `C:\Users\Abdu\.tuya-ct02\local_probe*.py`. The single-unit risk
  story improves: even a failed flash+restore leaves local polling as a working transport.
- **Local DP surface is richer than the cloud's 6 DPs:** dp48 = total active power (W),
  dp53 = power factor (×0.01), dp1/dp2 = energy counters (NOT saturated locally; dp2 ticks in
  0.01 kWh), dp103 "warning" / dp113 "monitor" / dp124 "normal" / dp125 "warn" enums (meaning
  TBD — F2's schema extraction should name them), dp49 frequency ×0.01 Hz. dp6/dp7 raw phase
  blobs are excluded from plain status but arrive via `updatedps`. Feed all of this into the
  open-firmware config at F2/F3.

## Known facts (so no session re-derives them)

- ~~Sibling teardown (S10-CT02): **CB2S module (BK7231N)** + **2× BL0942** metering ICs on ONE
  shared UART~~ — **OVERTURNED for this unit 2026-08-21: the S04's module is a WL2S** (see the F1
  note at the top). The 2× BL0942 metering layout from the sibling may still hold for the metering
  side — unverified until the remaining photos/dump.
- ~~Dual-clamp on open firmware is UNPROVEN on shared-UART wiring~~ — **RESOLVED 2026-08-21:
  the board has ONE dual-current-channel metering IC, CONFIRMED as Hiliwei HLW8112 (photo #4),
  not two BL0942s.** Dual-clamp is native to the chip. The open question is now **driver
  support for HLW8112** in OpenBeken's LN882H build (research running); fallback if absent =
  write a small OpenBeken C driver for the HLW8112 UART register protocol.
- Cloud push binary DP format (dp6/dp7): `>H` voltage×10, u24 mA, u24 W — decoder in
  `tuya-bridge/decode.py` (and `C:\Users\Abdu\.tuya-ct02\`).
- Our mosquitto broker on the VPS is internet-reachable on 1883 with password auth (the
  Qingping feeds through it) — the likely transport for the flashed unit (F5 decides). ⚠️ The
  mosquitto passwd regen recipe in `docs/agent/operations.md` currently recreates ONLY the
  `qingping` user — F5 must extend it or every later deploy silently breaks the meter's feed.

## F0 — Procurement & prep

- [x] **ABDU:** ~~get a 3.3 V USB-UART adapter~~ FOUND 2026-08-21: **Telesky "Auto Programmer"
      USB-TTL stick** (pinout: GND①/TCK②/RXD③/RST④/TXD⑤/3V3⑥/5V0⑦/3V3⑨, N.C⑧⑩ — an STC-style
      auto-programmer, almost certainly CH340-based; TCK/RST are for STC auto-reset, ignore them).
      ⚠️ Two checks before first use: (1) **logic level** — measure TXD-to-GND idle voltage while
      plugged in; ~3.3 V = wire direct, ~5 V = put ~1 kΩ in series on stick-TXD → board-RX
      (board TX → stick RXD is safe either way) — STILL PENDING (or default to the 1 kΩ resistor);
      (2) ~~COM port/driver~~ DONE 2026-08-21: CH340 driver installed, **COM3** enumerates OK. Powering: prefer stick **5V0 →
      board `+5V` pad** so the board's own AMS1117-33 regulates (confirm at F1 close that the +5V
      pad feeds the LDO input); the stick's 3V3 pin is the weaker fallback.
      *(USB ISP + ST-Link V2 also offered — unsuitable, no UART; see top note.)*
- [x] **ABDU:** ~~read the **firmware version**~~ DONE 2026-08-19: Main Module v1.3.1 /
      MCU Module v1.3.1 (see top note). ✅ **Auto-Upgrade OFF confirmed by user 2026-08-21** —
      NO-GO/restore paths are now OTA-safe.
- [x] **CLAUDE:** ~~check tuya-cloudcutter~~ ruled out earlier by local protocol v3.5 (F0
      findings). 2026-08-21: tool prep re-scoped to the WL2S chip's toolchain (research running);
      candidate OpenBeken configs + flashing guide being drafted into
      `C:\Users\Abdu\.tuya-ct02\candidates\`. ESPHome YAML dropped if LN882H is confirmed.
- **GATE F0→F1:** adapter in hand + firmware version recorded. *(Version ✓; adapter still
  missing — F1 photo work proceeds in parallel since the case is already open.)*

## F1 — Photo gate (identity verification)

- [ ] **ABDU:** power the unit down (shadow feed goes quiet — expected, fail-safe), open the
      case; photograph BOTH PCB sides + close-ups of the Wi-Fi module marking, the metering IC
      markings, and the traces between them.
      *(Photos #1–#4 received 2026-08-21 — DONE: front, back, and chip close-up. Metering IC
      confirmed HLW8112.)*
- [~] **CLAUDE:** identification mostly delivered 2026-08-21 (see top note): module = WL2S
      (LN882H believed, verification running); metering = single dual-channel UART IC, BL0939
      suspected; no separate MCU → direct-read architecture; pin map = front header
      +5V/GND/3V3/RX/TX/A9 (A9 = suspected boot pin) for flashing, back RX1/TX1 = metering UART.
      Remaining: chip-marking confirmation + flash-procedure verification → then GO/NO-GO.
- **GATE F1→F2:** flashable module confirmed + pin map delivered. (NO-GO → close the unit,
  power it back up — shadow feed resumes — and fall back to option C.)

## F2 — Backup & dump analysis (the reverse-engineering step)

- [ ] **ABDU:** solder/hold wires per the pin map; connect the UART adapter; power the board
      from 3.3 V (NEVER mains-connected while wired to the PC).
- [ ] **CLAUDE:** run the flash **READ TWICE** — two full factory-firmware backups, SHA256
      MUST match between reads (mismatch = wiring/power problem, fix before anything else) →
      store in `C:\Users\Abdu\.tuya-ct02\firmware\` AND a second location. This dump is the
      single-unit plan's ONLY undo — nothing is ever written until it is verified.
- [ ] **CLAUDE:** run bk7231tools/upk2esphome on the dump → extract the Tuya config partition
      (GPIO/UART/baud/DP schema) → determine HOW stock reads two metering ICs; finalize the
      open-firmware config (and whether a wire must move to UART2).
- **GATE F2→F3:** backup double-read-verified + dual-clamp mechanism understood.

## F3 — Flash & first boot — ✅ COMPLETE 2026-08-21 (see F3-STAGE-2 RECORD at top)

- [x] **CLAUDE:** ~~build/choose the image~~ staged: stock OpenBeken 1.18.302 first (validation), then
      custom `hlwdev3` with `drv_hlw8112_uart` (built in WSL, delivered via OTA).
- [x] **ABDU:** bootloader mode via A9→GND jumper; UART write with `SharpLN882HTool_115k.exe`.
- [x] **CLAUDE:** firmware written (`Flash done!`); stage-2 via OTA (no rig).
- [x] **ABDU:** joined `OpenLN882H_C25E1088` AP, set home Wi-Fi → `192.168.51.164`.
- [x] **CLAUDE:** telemetry LIVE — coefficients valid, 207–213 V / 49.5 Hz on grid; driver
      auto-starts (`startcmd`), reboot-verified.
- **GATE F3→F4:** ✅ PASSED — flashed unit on Wi-Fi reporting real mains telemetry.

## F4 — Dual-clamp validation & calibration (THE project gate)

- [ ] **ABDU:** clamp both CTs on known loads (e.g., clamp A back on Abdu's AC line; clamp B
      on another live conductor).
- [ ] **CLAUDE:** log flashed-unit readings vs the ESP; calibrate gains; check 1–5 s cadence,
      restart behavior, Wi-Fi-loss watchdog.
- **GATE F4→F5:** both channels accurate (target ±0.2 A across the range) and stable.
  FAIL → single-clamp verdict → decide: UART2 rewire attempt / restore the factory dump
  (cloud shadow resumes) / option C.

## F5 — Server integration

- [ ] **CLAUDE:** implement the direct feed — likely MQTT to our VPS mosquitto (dedicated
      user; **extend the passwd-regen recipe**) with a small server-side subscriber mapping
      into the shadow-ingest path, OR plain HTTP if the firmware's TLS allows Cloudflare.
      Tests + review (implementer + Codex per routing policy) + deploy.
- [ ] **BOTH:** the flashed unit runs ≥48 h as a feed beside the ESP; compare coverage.
- **GATE F5→F6:** flashed feed ≥ the old cloud feed on coverage with zero fabricated readings.

## F6 — Promotion to the mains

- [ ] **ABDU:** move the clamps to the mains conductors (grid→i1, gen→i2 — physically
      verified with Claude watching live data).
- [ ] **CLAUDE:** P3-style 48 h side-by-side vs the ESP on the SAME conductors; then build
      P4's promotion detector (ESP silent ≥3 min + weather/AC feeds alive + flashed feed at
      mains-level → LOUD promotion) against this feed.
- Endgame: ESP decommission per the P4 criteria in the project plan of record.
