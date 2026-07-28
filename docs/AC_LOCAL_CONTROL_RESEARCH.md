---
type: Reference
title: 'Local AC Control — Universality & Commercial Feasibility'
description: 'Can one device control every brand of AC locally over UART? Protocol-family landscape, connector/voltage variance, commercial precedent, and the Iraq market picture. Background research for the TCL cloud-free migration.'
tags: [home, dashboard, claude-code, ac, local-control, research, current]
maintainer: claude-code
timestamp: 2026-07-28
---

# Local AC Control — Universality & Commercial Feasibility

**Research date:** 2026-07-28
**Question:** Are AC Wi-Fi dongle ports universal across brands, or does each brand have its own?
Can a commercial product be one device, or does it need a different device per AC type?

**Related:** current TCL cloud path → [tcl-ac.md](agent/tcl-ac.md); the generator-mode controller
that motivates local control → [ac-leveling.md](agent/ac-leveling.md).

---

## Executive summary

| Claim | Verdict |
|---|---|
| One connector fits all brands | **No** — confirmed |
| One voltage / logic level fits all brands | **No** — confirmed |
| One protocol fits all brands | **No** — confirmed |
| A single *hardware* design can cover most brands (with a per-brand cable) | **Yes** — confirmed by existing products |
| ~10 protocol families cover most of the market | **Yes** — confirmed |
| Auto-detecting the brand/protocol in firmware is proven | **Cannot confirm** — plausible, but nobody ships it |

**Bottom line:** universal *hardware* yes, universal *cable and protocol* no. The viable product is
**one board + a per-brand pigtail (~$0.50) + ~8 firmware drivers**. That is exactly how every
established commercial player does it.

**Second finding, specific to Iraq:** a large share of the installed base has no data port at all
(see [§6](#6-the-alhafidh-finding--the-non-connected-market)). That market needs a *different*
product — IR control closed-looped with current sensing — which our existing amp-modeling work
uniquely enables.

---

## 1. What actually varies per brand

### Connectors — every family differs, and some brands differ from themselves

| Brand | Connector |
|---|---|
| Daikin | S21: JST EH 5-pin (2.5 mm) on older units, JST PAP-05V-S (2.0 mm) on newer — Daikin sells the **EKRS21 adapter to convert between its own two variants** |
| Mitsubishi Electric | CN105, 5-pin JST PA |
| TCL | USB-A-shaped port on some units, bare 4-pin `CN16` header on others — *within the same brand* |
| Midea | USB-A-shaped (UART on the pins, not real USB) |
| Haier | USB-shaped connector, also just UART |
| Panasonic | CZ-TACG1 — different connector family again |

### Voltage — not universal

- **Daikin S21:** pin 1 is 5 V but [cannot source enough current for an ESP32 — you power from pin 4's 12–14 V through a buck converter](https://codeberg.org/RevK/ESP32-Faikout/wiki/Wiring).
- **Mitsubishi CN105:** [carries both 5 V and 12 V](https://esphome.io/components/climate/mitsubishi_cn105/).
- **TCL / Midea:** typically 5 V.

### Logic levels — not universal

Split between 3.3 V and 5 V TTL depending on family. Requires level shifting or auto-sensing.

### Protocols — completely different framing per family

No shared standard exists. Each family required independent reverse engineering.

---

## 2. Protocols consolidate into ~10 families

This is what makes a product viable. OEM manufacturing means a handful of protocols cover most of
the market.

| Family | Brands it covers | Open-source status |
|---|---|---|
| **Midea** | ~40 brands: Carrier, Toshiba, Electrolux, Comfee, Senville, Pioneer, Lennox, Trane, Beko, Inventor, Kaisai, Qlima, Royal Clima, Neoclima, Mr. Cool, Friedrich, Goodman, Kenmore, some Samsung/LG… | Excellent — [MideaUART](https://github.com/dudanov/MideaUART), [mideahvac-dongle](https://github.com/reneklootwijk/mideahvac-dongle) |
| **Gree** | Gree + **TOSOT** + KINGHOME + wide OEM footprint (world's largest residential AC maker); modules CS532AE/AH/AX | Good — [gree-hvac-protocol](https://github.com/bekmansurov/gree-hvac-protocol), [esphome_gree_ac](https://github.com/piotrva/esphome_gree_ac) |
| **Daikin S21** | Daikin | Excellent — [ESP32-Faikin](https://github.com/revk/ESP32-Faikin), [esphome-daikin-s21](https://github.com/joshbenner/esphome-daikin-s21) |
| **Mitsubishi Electric CN105** | Mitsubishi Electric | Excellent — [official ESPHome component](https://esphome.io/components/climate/mitsubishi_cn105/) |
| **Samsung NASA / non-NASA** | Samsung (two generations = two drivers) | Good — [esphome_samsung_ac](https://github.com/kumy/esphome_samsung_ac) |
| **Panasonic** | Panasonic | Good — [esphome-panasonic-ac](https://github.com/DomiStyle/esphome-panasonic-ac) |
| **Haier** | Haier, **GE Appliances**, some Hisense — two incompatible variants (hOn / SmartAir2) | Good — [haier-esphome](https://github.com/paveldn/haier-esphome) |
| **LG** | LG — own protocol, not Midea | Good — [esphome-lg-controller](https://github.com/JanM321/esphome-lg-controller) (PREMTB001/100 wired bus, protocol documented) |
| **TCL** | TCL, Kesser, Pioneer, DAIZUKI ([per AC-hack](https://github.com/adaasch/AC-hack)) | Partial — [tclac](https://github.com/I-am-nightingale/tclac); **generator mode unmapped — our project** |
| **Tuya-MCU** | Cross-brand standardized datapoints — but some ACs use custom serial instead of standard DPID traffic | [Documented by Tuya](https://developer.tuya.com/en/docs/iot/wbr3-module-mcu-serial-communication-instructions?id=K9pfgdk62ae6g) |
| Mitsubishi Heavy, Fujitsu, Toshiba VRF | separate families each | Varies |

---

## 3. Commercial precedent — the incumbents all ship brand-specific SKUs

- **Intesis / HMS Networks** — separate part number per brand family:
  `INWMPDAI001I000` (Daikin), `INWMPMIT001I000` (Mitsubishi Electric), `INWMPPAN001I000`
  (Panasonic), `INWMPLGE001R000` (LG), `INWMPTOS001R000` (Toshiba) — and even **two per brand** for
  Fujitsu (`INWMPFGL001I000` for the CN connector vs `INWMPFGL001R000` for the RC bus).
  Their one product literally named "**Universal**" (`INWMPUNI001I000`) is **infrared** — the
  incumbent concluded universal-wired isn't practical and fell back to IR.
- **Airzone Aidoo Pro** — markets "80+ brands, 12,000+ models," delivered as brand-specific SKUs:
  `AZAI6WSPLGE` (LG), `AZAI6WSPSA2` (Samsung NASA), `AZAI6WSPMEL` (Mitsubishi Electric),
  `AZAI6WSPGG2`/`GG3` (general groups).
- **[SLWF-01pro](https://smlight.tech/product/slwf-01)** (SMLIGHT, ~$25–30) — closest existing
  product to what we would build: ESP-based, ESPHome, sold on Amazon/AliExpress/Tindie. Covers
  **only the Midea family** — still ~40 brands. Explicitly warns compatibility isn't guaranteed and
  newer units may use newer protocols.

**Read:** brand-specific is the industry norm, and the price band between SLWF-01pro (~$25,
one family) and Intesis/Airzone (€150–250, brand SKUs) is where a multi-driver product would sit.

---

## 4. Viable product architecture

**Universal brains + per-brand pigtail + multi-driver firmware.** The expensive part is universal;
the brand-specific part is a cable.

| Layer | Universal? | Notes |
|---|---|---|
| ESP32 + Wi-Fi + MQTT + OTA | ✅ Yes | One board for everything |
| Power input | ✅ Yes | Wide-input buck (5–16 V) covers 5 V TCL/Midea and 12–14 V Daikin/Mitsubishi |
| Logic level | ✅ Yes | Bidirectional level shifter + auto-sense 3.3 V / 5 V |
| Board-side connector | ✅ Yes | One generic 6-pin JST on the board |
| **Cable to the AC** | ❌ **Per brand** | ~$0.50 pigtail per family — the only per-brand BOM item |
| Protocol driver | ❌ Per family, same firmware image | Selected at setup, or auto-detected (unproven) |

---

## 5. Brand-specific verdicts

| Brand | Protocol family | Confirmed? | Notes |
|---|---|---|---|
| **TOSOT** | **Gree** | ✅ **Yes** | TOSOT is Gree's own brand — [Gree Electric operates GREE, TOSOT, KINGHOME](https://gree-na.com/about/); TOSOT units pair through the **Gree+ app**. One Gree driver covers both — free coverage. |
| **LG** | **LG's own** (not Midea) | ✅ **Yes** | Two entry points: the [PWFMDD200 SmartThinQ Wi-Fi module](https://www.supplyhouse.com/LG-PWFMDD200-LG-Wi-Fi-Module-w-SmartThinQ-Compatibility) on mini-splits, and the wired-controller bus — [reverse-engineered with a working ESPHome component](https://github.com/JanM321/esphome-lg-controller). Real work, but the path exists. |
| **GE** | **Haier** (most likely) | ⚠️ **Partial** | GE Appliances has been Haier-owned since 2016; [Haier protocols are well covered](https://github.com/paveldn/haier-esphome) but in **two incompatible variants** (hOn / SmartAir2). Cautions: some GE-branded ACs in some markets are Midea-built; **newer Haier ESP32 modules ship encrypted — signed firmware only, so the stock module cannot be reflashed**, it must be replaced. |
| **Alhafidh** | — | ❌ **Cannot confirm** | OEM undisclosed. See below — the more useful finding is that their lineup has no Wi-Fi at all. |

---

## 6. The Alhafidh finding — the non-connected market

Their [full AC catalogue](https://alhafidh.com/en/collections/air-conditioners): ~25 models, 1–3 ton,
inverter and ON/OFF, R22/R410/R32 — and **not a single Wi-Fi or app-connected model.** Naming is
`HA-H18R410INV3`-style; they also resell genuine Panasonic units alongside the house brand.
Based in Baghdad (Karada Kharidge).

This matters more than knowing their OEM: **no Wi-Fi option usually means no UART dongle port.**
A large share of the Iraqi installed base is like this — dumb ACs with only an IR remote. A dongle
product cannot serve them.

**But we can.** For a dumb AC, IR control is universal but *blind* — the known weakness of
Sensibo/Tado and why Intesis's "universal" SKU is the weak one in their lineup. We already have the
missing half: **per-AC amp models and a whole-house CT meter** (see [ac-leveling.md](agent/ac-leveling.md)).
IR out + current sensing back = closed-loop control of an AC with no data port at all. Generator
*levels* can't be set on a dumb unit, but it can be observed and shed/cycled — which the leveler
already does. Nobody ships that combination.

---

## 7. Fastest way to classify any brand — ask which app it uses

No need to open a unit. The pairing app identifies the protocol family almost every time:

| App | Family |
|---|---|
| Gree+ / TOSOT+ / EWPE Smart | **Gree** |
| AC Freedom / NetHome Plus / Midea Air | **Midea** (~40 brands) |
| TCL Home | **TCL** |
| hOn / SmartAir2 | **Haier** (incl. GE) |
| Tuya Smart / Smart Life | **Tuya-MCU** — cross-brand, standardized datapoints |
| LG ThinQ / SmartThinQ | **LG** |
| SmartThings | **Samsung** (NASA vs non-NASA = 2 drivers) |
| Onecta / Daikin Mobile Controller | **Daikin S21** |
| MELCloud | **Mitsubishi Electric CN105** |
| Comfort Cloud | **Panasonic** |
| *No app at all* | **No data port — IR + current sensing is the only path** |

Note the Tuya row: many small and regional brands don't write their own firmware, they buy a Tuya
module. If Alhafidh ever ships a smart model, Tuya is the most likely answer — and one Tuya-MCU
driver would cover a whole tail of regional brands at once.

---

## 8. Coverage picture for Iraq

| Tier | Brands | Driver cost |
|---|---|---|
| **Most units per driver** | Gree **+ TOSOT**, Midea family (~40 brands), TCL | 3 drivers |
| **Meaningful volume** | Haier **+ GE**, Hisense, Samsung, LG | 4 drivers (Haier ×2 variants, Samsung ×2) |
| **Tuya tail** | assorted regional / no-name smart units | 1 driver, unknown but possibly large payoff |
| **No data port** | Alhafidh and most budget/older stock | Not addressable by a dongle — IR + CT instead |

**One hardware platform, per-brand pigtail, ~8 firmware drivers** gets the connected market. The
non-connected market is proportionally bigger in Iraq than in Europe and needs the second product.

---

## 9. Strategic considerations before committing

**1. GPL licensing is a real constraint.** ESPHome is GPLv3, and most components above are
GPL-derived. Shipping a commercial product built on them obligates offering source. Not a blocker
(many vendors do it) but it must be deliberate — or write clean-room drivers from the separately
documented protocol specs.

**2. Certification.** CE/FCC/RED for a radio product, liability for a device wired into
mains-adjacent HVAC equipment, and the warranty-voiding question for end users. This is the real
cost gap between a DIY board and a sellable product — typically thousands of dollars.

**3. The actual differentiator isn't the dongle — it's generator mode.** Nobody in the competitive
set does current-capping automation. Intesis, Airzone, Sensibo and SLWF-01pro all assume unlimited
grid power. **Generator-aware AC load management is unserved, and Iraq/the region is exactly where
it matters most.** The Smart AC Leveling controller is the novel asset; the dongle is just the
actuator that frees it from the manufacturer's cloud. Lead with *"keeps your ACs running on
generator without tripping the breaker,"* not *"another local AC control module."*

---

## 10. What cannot be confirmed

- **Comprehensive Gree OEM rebrand list** — protocol is reverse-engineered and documented, but no
  authoritative list of which brands ship Gree boards.
- **Reliable auto-detection of protocol family** — technically plausible (sniff idle traffic, match
  framing signatures), but no shipping product does it. Treat as R&D, not a given.
- **Precise market share per family in Iraq/the region** — needs local distributor data.
- **Alhafidh's OEM** — undisclosed; their units appear to have no smart/Wi-Fi variant at all.
- **Whether GE units sold in Iraq are Haier-built or Midea-built** — varies by market.
- **Whether TCL's generator-mode byte exists on the UART at all** — the open question gating both
  the household migration and the commercial thesis.

---

## Sources

**Protocol / firmware projects**
- [I-am-nightingale/tclac](https://github.com/I-am-nightingale/tclac) — TCL ESPHome component
- [adaasch/AC-hack](https://github.com/adaasch/AC-hack) — TCL-family UART protocol doc
- [dudanov/MideaUART](https://github.com/dudanov/MideaUART) · [reneklootwijk/mideahvac-dongle](https://github.com/reneklootwijk/mideahvac-dongle) — Midea
- [bekmansurov/gree-hvac-protocol](https://github.com/bekmansurov/gree-hvac-protocol) · [piotrva/esphome_gree_ac](https://github.com/piotrva/esphome_gree_ac) — Gree
- [revk/ESP32-Faikin](https://github.com/revk/ESP32-Faikin) · [joshbenner/esphome-daikin-s21](https://github.com/joshbenner/esphome-daikin-s21) · [wiring/pinout](https://codeberg.org/RevK/ESP32-Faikout/wiki/Wiring) — Daikin
- [ESPHome mitsubishi_cn105](https://esphome.io/components/climate/mitsubishi_cn105/) · [echavet/MitsubishiCN105ESPHome](https://github.com/echavet/MitsubishiCN105ESPHome) — Mitsubishi Electric
- [paveldn/haier-esphome](https://github.com/paveldn/haier-esphome) — Haier / GE
- [JanM321/esphome-lg-controller](https://github.com/JanM321/esphome-lg-controller) — LG
- [kumy/esphome_samsung_ac](https://github.com/kumy/esphome_samsung_ac) — Samsung
- [DomiStyle/esphome-panasonic-ac](https://github.com/DomiStyle/esphome-panasonic-ac) — Panasonic
- [Tuya WBR3 MCU serial protocol](https://developer.tuya.com/en/docs/iot/wbr3-module-mcu-serial-communication-instructions?id=K9pfgdk62ae6g) · [openshwprojects/OpenBK7231T_App](https://github.com/openshwprojects/OpenBK7231T_App)

**Commercial products**
- [Intesis WiFi series manual (HMS Networks)](https://www.hms-networks.com/docs/default-source/products/intesis/manuals-and-guides---manuals/user-manual-inwmpxxx001xx00.pdf)
- [Airzone Aidoo Pro](https://www.airzonecontrol.com/na/en/control-solutions/aidoo/pro/)
- [SMLIGHT SLWF-01pro](https://smlight.tech/product/slwf-01)

**Brand / corporate**
- [Gree Electric — GREE, TOSOT, KINGHOME brands](https://gree-na.com/about/)
- [LG PWFMDD200 module](https://www.supplyhouse.com/LG-PWFMDD200-LG-Wi-Fi-Module-w-SmartThinQ-Compatibility)
- [ALHAFIDH air conditioner catalogue](https://alhafidh.com/en/collections/air-conditioners)
