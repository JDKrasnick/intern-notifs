export type ApplicationJobSummary = {
  jobId: string;
  company: string;
  title: string;
  applyUrl?: string;
  open: boolean;
  availability?: 'available' | 'closed' | 'catalog-review';
  unavailableReason?: string;
  postingIdentityStatus?: 'confirmed' | 'unconfirmed';
  sourceReferences?: Array<{ sourceId: string; sourceUrl: string }>;
};

export function resolveApplicationJob<T extends ApplicationJobSummary>(
  application: { jobId: string; job?: ApplicationJobSummary },
  catalogJobs: T[],
): ApplicationJobSummary | T | undefined {
  return application.job ?? catalogJobs.find((job) => job.jobId === application.jobId);
}

export type QueueEntry = {
  applicationId: string;
  status: string;
  queuedAt?: string;
  createdAt?: string;
  jobId: string;
  job?: ApplicationJobSummary;
};
export function sortApplyQueue<T extends QueueEntry>(applications: T[]): T[] {
  return applications
    .filter((application) => application.status === 'saved')
    .sort((a, b) => (a.queuedAt ?? a.createdAt ?? '').localeCompare(b.queuedAt ?? b.createdAt ?? ''));
}

export function nextAvailableQueueEntry<T extends QueueEntry>(
  queue: T[],
  catalogJobs: Array<ApplicationJobSummary>,
  fromIndex = 0,
): T | undefined {
  return queue.slice(fromIndex).find((item) => {
    const job = resolveApplicationJob(item, catalogJobs);
    const availability = job && 'availability' in job && job.availability
      ? job.availability
      : job?.open ? 'available' : 'closed';
    return availability === 'available' && Boolean(job && 'applyUrl' in job && job.applyUrl);
  });
}
