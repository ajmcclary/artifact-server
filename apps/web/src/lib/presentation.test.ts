import {describe, expect, test} from "vitest";

import {formatTimestamp} from "./presentation";

const iso = (year: number, month: number, day: number, hour: number, minute: number): string =>
  new Date(year, month - 1, day, hour, minute).toISOString();

describe("formatTimestamp", () => {
  test("prints MM/DD/YYYY and a 12-hour clock in local time", () => {
    expect(formatTimestamp(iso(2026, 4, 14, 15, 5))).toBe("04/14/2026 3:05 PM");
    expect(formatTimestamp(iso(2026, 12, 31, 0, 0))).toBe("12/31/2026 12:00 AM");
    expect(formatTimestamp(iso(2026, 1, 2, 12, 30))).toBe("01/02/2026 12:30 PM");
  });

  test("returns an unreadable value unchanged", () => {
    expect(formatTimestamp("not a time")).toBe("not a time");
    expect(formatTimestamp("")).toBe("");
  });
});
