import { describe, expect, it } from "vitest";
import { settingsDestinations } from "../src/settings.js";

describe("profile settings navigation", () => {
  it("keeps profile settings in three focused destinations", () => {
    expect(settingsDestinations.map(({ id }) => id)).toEqual([
      "user-info",
      "job-preferences",
      "app-account",
    ]);
  });

  it("gives every destination reviewable navigation copy", () => {
    for (const destination of settingsDestinations) {
      expect(destination.title).not.toBe("");
      expect(destination.description).not.toBe("");
      expect(destination.accessibilityHint).not.toBe("");
    }
  });
});
