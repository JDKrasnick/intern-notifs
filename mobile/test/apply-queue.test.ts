import { describe, expect, it } from "vitest";
import { nextAvailableQueueEntry, sortApplyQueue, type QueueEntry } from "../src/application";

const entry = (overrides: Partial<QueueEntry> & { jobId: string }): QueueEntry => ({
  applicationId: `app-${overrides.jobId}`,
  status: "saved",
  ...overrides,
});

describe("sortApplyQueue", () => {
  it("keeps only queued saved roles ordered by queue time", () => {
    const applications = [
      entry({ jobId: "b", queuedAt: "2026-09-03T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ jobId: "applied", status: "applied", queuedAt: "2026-09-01T00:00:00.000Z" }),
      entry({ jobId: "legacy", createdAt: "2026-09-02T00:00:00.000Z" }),
      entry({ jobId: "dequeued", createdAt: "2026-09-01T00:00:00.000Z" }),
      entry({ jobId: "a", queuedAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(sortApplyQueue(applications).map((item) => item.jobId)).toEqual(["a", "b"]);
  });
});

describe("nextAvailableQueueEntry", () => {
  const catalog = [
    { jobId: "closed", company: "Acme", title: "Closed Role", open: false },
    { jobId: "open", company: "Acme", title: "Open Role", applyUrl: "https://example.test/apply", open: true },
    { jobId: "no-url", company: "Acme", title: "No URL Role", open: true },
  ];
  const queue = [
    entry({ jobId: "closed", queuedAt: "2026-09-01T00:00:00.000Z" }),
    entry({ jobId: "review", queuedAt: "2026-09-02T00:00:00.000Z", job: { jobId: "review", company: "Acme", title: "Review Role", open: true, availability: "catalog-review" as const } }),
    entry({ jobId: "no-url", queuedAt: "2026-09-03T00:00:00.000Z" }),
    entry({ jobId: "open", queuedAt: "2026-09-04T00:00:00.000Z" }),
  ];

  it("skips closed, catalog-review, and url-less entries", () => {
    expect(nextAvailableQueueEntry(queue, catalog)?.jobId).toBe("open");
  });

  it("respects the current queue position", () => {
    expect(nextAvailableQueueEntry(queue, catalog, 3)?.jobId).toBe("open");
    expect(nextAvailableQueueEntry(queue, catalog, 4)).toBeUndefined();
  });
});
