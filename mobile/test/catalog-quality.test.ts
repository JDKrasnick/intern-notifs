import { describe, expect, it } from "vitest";
import { boundedCatalogText, compactLocations, presentCatalogRole, seasonLabel } from "../src/catalog-quality.js";

describe("catalog presentation hardening", () => {
  it("bounds legacy API and cache values without splitting emoji", () => {
    const value = `👩🏽‍💻 ${"engineer ".repeat(80)}`;
    expect([...boundedCatalogText(value, 40)].length).toBeLessThanOrEqual(40);
    expect([...boundedCatalogText("开发工程师".repeat(100), 12)].length).toBe(12);
  });

  it("summarizes at most twelve locations", () => {
    const locations = Array.from({ length: 15 }, (_, index) => `Location ${index + 1}`);
    expect(compactLocations(locations)).toBe("Location 1 · Location 2 + 10 more");
  });

  it("uses bounded values for visible and accessibility copy", () => {
    const role = presentCatalogRole({ company: "A".repeat(300), title: "منصب ".repeat(100), location: "Remote", season: "ongoing", compensation: { raw: "$50/hr ".repeat(50) } });
    expect([...role.company].length).toBe(160);
    expect([...role.title].length).toBeLessThanOrEqual(240);
    expect([...role.compensation].length).toBeLessThanOrEqual(160);
    expect(role.season).toBe("Season not specified");
    expect(seasonLabel("")).toBe("Season not specified");
  });
});
