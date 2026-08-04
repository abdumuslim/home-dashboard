import { describe, it, expect } from "vitest";
import {
  LEVEL_HOLD_RELEASE_C,
  LEVEL_HOLD_TTL_MS,
  levelHoldDetail,
  levelHoldExpiresAt,
  levelHoldFloor,
  levelHoldLive,
  recordLevelHold,
  type LevelHold,
} from "./level-hold.js";

const T0 = 1_700_000_000_000;
const hold = (over: Partial<LevelHold> = {}): LevelHold => ({
  level: 1,
  outdoorC: 44.1,
  observedAt: T0,
  ...over,
});

describe("level-hold — the learned non-cooling hold", () => {
  it("binds while the outdoor temperature is at or above the observation", () => {
    expect(levelHoldLive(hold(), 44.1, T0 + 1000)).toBe(true);
    expect(levelHoldLive(hold(), 47, T0 + 1000)).toBe(true);
    expect(levelHoldFloor(hold(), 47, T0 + 1000, 3)).toBe(2);
  });

  it("releases only a release-hysteresis BELOW the observation, so a wobble cannot flap the ladder", () => {
    // Exactly at the bar, and inside the hysteresis band: still binding.
    expect(levelHoldLive(hold(), 44.1 - LEVEL_HOLD_RELEASE_C, T0 + 1000)).toBe(true);
    expect(levelHoldLive(hold(), 44.1 - LEVEL_HOLD_RELEASE_C - 0.01, T0 + 1000)).toBe(false);
    expect(levelHoldFloor(hold(), 43, T0 + 1000, 3)).toBe(1);
  });

  it("lapses on its own TTL even in the heat that armed it", () => {
    expect(levelHoldLive(hold(), 47, T0 + LEVEL_HOLD_TTL_MS - 1)).toBe(true);
    expect(levelHoldLive(hold(), 47, T0 + LEVEL_HOLD_TTL_MS)).toBe(false);
    expect(levelHoldExpiresAt(hold())).toBe(T0 + LEVEL_HOLD_TTL_MS);
  });

  it("HOLDS on a dead outdoor feed — the weather is not mild because the station went quiet", () => {
    expect(levelHoldLive(hold(), null, T0 + 1000)).toBe(true);
    expect(levelHoldFloor(hold(), null, T0 + 1000, 3)).toBe(2);
    // …but the TTL still retires it, so a permanently dead feed cannot pin a
    // room's floor forever.
    expect(levelHoldLive(hold(), null, T0 + LEVEL_HOLD_TTL_MS)).toBe(false);
  });

  it("keeps the LOWER observation and the LATER clock when evidence repeats", () => {
    const first = hold({ outdoorC: 39, observedAt: T0 });
    const hotter = hold({ outdoorC: 44, observedAt: T0 + 60_000 });
    const merged = recordLevelHold(first, hotter);
    // L1 failing at 39° implies it fails at 44° — the colder bar is the binding
    // one and a hotter afternoon must not raise it.
    expect(merged.outdoorC).toBe(39);
    // …but the renewed evidence is evidence NOW: the TTL runs from the latest.
    expect(merged.observedAt).toBe(T0 + 60_000);
  });

  it("takes a colder observation even when it arrives first-in-time", () => {
    const merged = recordLevelHold(hold({ outdoorC: 44, observedAt: T0 + 60_000 }), hold({ outdoorC: 38, observedAt: T0 }));
    expect(merged.outdoorC).toBe(38);
    expect(merged.observedAt).toBe(T0 + 60_000);
  });

  it("never names a level the firmware does not have", () => {
    expect(levelHoldFloor(hold({ level: 3 }), 47, T0, 3)).toBe(3);
    expect(levelHoldFloor(null, 47, T0, 3)).toBe(1);
  });

  it("explains itself for the status card", () => {
    expect(levelHoldDetail(hold())).toContain("44.1°C outdoor");
    expect(levelHoldDetail(hold())).toContain("43.6°C");
  });
});
