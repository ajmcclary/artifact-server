import {describe, expect, test} from "vitest";

import {isVersionContentUrl} from "@/review/version-content-url";

const application = "https://artifacts.example.test";
const lease = "https://v-abc.content.example.test/";

describe("version content address", () => {
  test("accepts the lease's own per-version content origin", () => {
    expect(isVersionContentUrl(lease, lease, application)).toBe(true);
    expect(isVersionContentUrl("https://v-def.content.example.test/index.html", lease, application)).toBe(true);
  });

  test("refuses other schemes, ports, depths, the application origin and malformed input", () => {
    expect(isVersionContentUrl("javascript:alert(1)", lease, application)).toBe(false);
    expect(isVersionContentUrl("http://v-abc.content.example.test/", lease, application)).toBe(false);
    expect(isVersionContentUrl("https://v-abc.content.example.test:8443/", lease, application)).toBe(false);
    expect(isVersionContentUrl("https://a.b.content.example.test/", lease, application)).toBe(false);
    expect(isVersionContentUrl("https://attacker.example/", lease, application)).toBe(false);
    expect(isVersionContentUrl(lease, lease, "https://v-abc.content.example.test")).toBe(false);
    expect(isVersionContentUrl("not a url", lease, application)).toBe(false);
    expect(isVersionContentUrl("data:text/html,hi", "data:text/html,hi", application)).toBe(false);
  });
});
