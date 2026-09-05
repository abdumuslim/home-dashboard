// The one predicate that decides whether a leveler power event physically
// restarted the ACs. It lives here because BOTH sides ask it: the collector
// (drop the pre-cycle fan/swing intent) and the v2 controller (release the
// manual level pin and fan exemption). Two copies of this question would drift,
// and the failure is silent on both sides.

/**
 * Which leveler power-event kinds actually cut mains to the ACs. A REAL source
 * transition, a power collapse and an AC-circuit-dead latch restart the units;
 * a bare meter-telemetry gap ("ESP gap Ns") or a frozen meter says nothing
 * about the line. Since the 2026-08-29 CT02 switch the meter arrives over MQTT
 * and blips routinely (broker restarts, WiFi hiccups, the meter's own reboot),
 * and every blip was wiping the user's fan/swing intent (2026-08-31).
 * "source none → X" is excluded for the same reason `acSourceCycleAt` excludes
 * it: only the SERVER restarted. It is not merely a harmless no-op on empty
 * boot maps, because the leveler's source also resets to "none" after a long
 * enough meter outage, and then the first reading back would wipe LIVE manual
 * intent on what is still a pure telemetry event.
 * ⚠ A NEW event kind must decide its membership here explicitly: the default is
 * "does not restart the ACs", so a kind that does restart them must be added.
 */
export function powerEventRestartsAcs(kind: string): boolean {
  return (kind.startsWith("source ") && !kind.startsWith("source none"))
    || kind.includes("power collapse")
    || kind.startsWith("AC circuit dead");
}
