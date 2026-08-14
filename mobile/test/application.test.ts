import { describe, expect, it } from "vitest";
import { resolveApplicationJob } from "../src/application";

const embeddedJob = {
  jobId: "closed-role",
  company: "Acme",
  title: "Software Intern",
  applyUrl: "https://example.test/apply",
  open: false,
};

describe("resolveApplicationJob", () => {
  it("uses the embedded application summary when the role is absent from the catalog page", () => {
    expect(resolveApplicationJob({ jobId: embeddedJob.jobId, job: embeddedJob }, [])).toEqual(embeddedJob);
  });

  it("falls back to a matching catalog role for newly created application responses", () => {
    expect(resolveApplicationJob({ jobId: embeddedJob.jobId }, [{ ...embeddedJob, open: true }])).toMatchObject({
      jobId: embeddedJob.jobId,
      open: true,
    });
  });
});
