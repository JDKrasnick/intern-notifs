export function boundedCatalogText(value: unknown, maximum: number): string {
  const clean = typeof value === "string" ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : "";
  if ([...clean].length <= maximum) return clean;
  const slice = [...clean].slice(0, maximum + 1).join("");
  const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf(" · "), slice.lastIndexOf(", "));
  return [...(boundary > maximum * 0.65 ? slice.slice(0, boundary) : slice)].slice(0, maximum).join("").trim();
}

export function compactLocations(values: unknown, fallback?: unknown): string {
  const candidates = Array.isArray(values) ? values : typeof fallback === "string" ? fallback.split(/\s*(?:\n|\||;|\s\/\s)\s*/u) : [];
  const unique = [...new Set(candidates.map((item) => boundedCatalogText(item, 120)).filter(Boolean))].slice(0, 12);
  if (!unique.length) return "Location not specified";
  return boundedCatalogText(`${unique.slice(0, 2).join(" · ")}${unique.length > 2 ? ` + ${unique.length - 2} more` : ""}`, 160);
}

export function seasonLabel(value: unknown): string {
  const season = boundedCatalogText(value, 80);
  return !season || season.toLowerCase() === "ongoing" ? "Season not specified" : season;
}

export function presentCatalogRole<T extends { company?: unknown; title?: unknown; location?: unknown; locations?: unknown; season?: unknown; compensation?: { raw?: unknown } }>(role: T) {
  return {
    company: boundedCatalogText(role.company, 160) || "Unknown company",
    title: boundedCatalogText(role.title, 240) || "Role title unavailable",
    location: compactLocations(role.locations, role.location),
    season: seasonLabel(role.season),
    compensation: boundedCatalogText(role.compensation?.raw, 160),
  };
}
