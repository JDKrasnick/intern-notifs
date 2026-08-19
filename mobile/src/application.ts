export type ApplicationJobSummary = {
  jobId: string;
  company: string;
  title: string;
  applyUrl: string;
  open: boolean;
  sourceReferences?: Array<{ sourceId: string; sourceUrl: string }>;
};

export function resolveApplicationJob<T extends ApplicationJobSummary>(
  application: { jobId: string; job?: ApplicationJobSummary },
  catalogJobs: T[],
): ApplicationJobSummary | T | undefined {
  return application.job ?? catalogJobs.find((job) => job.jobId === application.jobId);
}
