# tuya-bridge

Shadow power feed. Subscribes to Tuya Sharing-SDK MQTT pushes for one QS-WIFI-CT02
2-clamp meter and forwards each phase reading to the dashboard as an ESP-shaped
POST (`{"v","i1","i2"}`) at `/api/power/tuya-ingest` — a path isolated from the
AC-leveling controller. It never touches the real ESP `/api/power/ingest`.

Required env: `TUYA_DEVICE_ID`, `TUYA_INGEST_TOKEN`.
Optional: `TARGET_URL` (default `http://dashboard:8000/api/power/tuya-ingest`),
`TUYA_TOKEN_FILE` (default `/data/token_info.json`), `PHASE_A_ROLE` (`i1`|`i2`,
default `i1`; phase_b takes the other slot), `WATCHDOG_S` (default `90`).

Seed the token bundle by copying your operator machine's `token_info.json`
(keys: client_id, user_code, terminal_id, endpoint, t, uid, expire_time,
access_token, refresh_token) into the `tuya_bridge_data` volume at `/data/token_info.json`;
the bridge rewrites it in place on refresh. Run `python decode.py` for the DP-decode selftest.
