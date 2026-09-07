import { describe, expect, it } from "vitest";
import { disciplineStyleFor } from "../../shared/discipline-display.js";

describe("discipline display", () => {
  it("maps catalog API labels to their canonical palette", () => {
    expect(disciplineStyleFor("Cloud/Infra").label).toBe("Infra");
    expect(disciplineStyleFor("Quant/Fintech").label).toBe("Quant");
  });
});
