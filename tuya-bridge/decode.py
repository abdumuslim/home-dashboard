#!/usr/bin/env python3
"""Decode a Tuya electricity-monitor DP phase blob into (voltage, current, power).

The QS-WIFI-CT02 2-clamp meter reports each phase as an 8-byte big-endian blob,
base64-encoded in the DP `value` field:

    bytes[0:2]  uint16  voltage * 10   -> volts
    bytes[2:5]  uint24  current * 1000 -> amps
    bytes[5:8]  uint24  power   * 1000 -> kilowatts

dpId 6 = phase_a, dpId 7 = phase_b.

Run `python decode.py` to execute the known-vector selftest.
"""
import base64
from typing import NamedTuple


class PhaseReading(NamedTuple):
    voltage: float  # volts
    current: float  # amps
    power: float    # kilowatts


def _uint_be(data: bytes) -> int:
    return int.from_bytes(data, byteorder="big")


def decode_phase(value_b64: str) -> PhaseReading:
    """Decode a base64 DP blob into a PhaseReading. Raises ValueError if malformed."""
    raw = base64.b64decode(value_b64)
    if len(raw) < 8:
        raise ValueError(f"phase blob too short: {len(raw)} bytes (need 8)")
    voltage = _uint_be(raw[0:2]) / 10
    current = _uint_be(raw[2:5]) / 1000
    power = _uint_be(raw[5:8]) / 1000
    return PhaseReading(voltage=voltage, current=current, power=power)


if __name__ == "__main__":
    # Known vector from the paired QS-WIFI-CT02: 208.1 V, 4.668 A, 0.920 kW.
    VECTOR = "CCEAEjwAA5g="
    expected = PhaseReading(208.1, 4.668, 0.920)
    got = decode_phase(VECTOR)
    print(f"decode({VECTOR!r}) -> V={got.voltage} A={got.current} kW={got.power}")
    if got != expected:
        print(f"SELFTEST FAILED: expected V={expected.voltage} A={expected.current} kW={expected.power}")
        raise SystemExit(1)
    print("SELFTEST PASSED")
