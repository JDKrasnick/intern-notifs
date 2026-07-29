import type { GreenhouseJob, GreenhouseJobsResponse } from '../../src/sources/greenhouse.js';
import type { ReviewedGreenhouseSource } from '../../src/sources/greenhouse-config.js';

/**
 * Sanitized, deterministic Greenhouse test material. Descriptions are minimal
 * and no live tracking parameters are embedded. Two boards exercise both the
 * standard Greenhouse-hosted host pattern and a documented custom-host case.
 */
export const acmeSource: ReviewedGreenhouseSource = {
  id: 'greenhouse-acmerobotics',
  employerId: 'acme-robotics',
  displayName: 'Acme Robotics',
  aliases: ['Acme', 'ACME Robotics'],
  boardToken: 'acmerobotics',
  careersUrl: 'https://job-boards.greenhouse.io/acmerobotics',
  expectedBoardNames: ['Acme Robotics'],
  admittedBoardName: 'Acme Robotics',
  admittedAt: '2026-07-24T18:00:00Z',
  allowedInitialHosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
  allowedFinalHosts: ['job-boards.greenhouse.io'],
  status: 'shadow',
};

export const globexSource: ReviewedGreenhouseSource = {
  id: 'greenhouse-globex',
  employerId: 'globex',
  displayName: 'Globex Corporation',
  aliases: ['Globex'],
  boardToken: 'globex',
  careersUrl: 'https://careers.globex.test/jobs',
  expectedBoardNames: ['Globex Corporation'],
  admittedBoardName: 'Globex Corporation',
  admittedAt: '2026-07-24T18:00:00Z',
  allowedInitialHosts: ['boards.greenhouse.io', 'careers.globex.test'],
  allowedFinalHosts: ['careers.globex.test'],
  status: 'shadow',
  hostExceptionReason: 'Globex hosts its official apply flow on careers.globex.test.',
};

export const technicalInternship: GreenhouseJob = {
  id: 5001,
  internal_job_id: 9001,
  title: 'Software Engineering Intern, Summer 2027',
  location: { name: 'New York, NY (Hybrid)' },
  updated_at: '2026-07-20T12:00:00Z',
  absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/5001',
  content: '&lt;p&gt;Join our platform team. Applicants must be a U.S. citizen. Pays $45/hour.&lt;/p&gt;',
  departments: [{ name: 'Engineering' }],
  offices: [{ name: 'New York' }],
};

export const nontechnicalInternship: GreenhouseJob = {
  id: 5002,
  internal_job_id: 9002,
  title: 'Marketing Intern',
  location: { name: 'Remote' },
  updated_at: '2026-07-19T12:00:00Z',
  absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/5002',
  content: '&lt;p&gt;Support brand campaigns.&lt;/p&gt;',
  departments: [{ name: 'Marketing' }],
};

export const technicalFullTime: GreenhouseJob = {
  id: 5003,
  internal_job_id: 9003,
  // Description-only lifecycle bait: prose says "internship" but the title does not.
  title: 'Senior Data Scientist',
  location: { name: 'San Francisco, CA' },
  updated_at: '2026-07-18T12:00:00Z',
  absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/5003',
  content: '&lt;p&gt;This is not an internship posting; ignore the word internship here.&lt;/p&gt;',
  departments: [{ name: 'Data' }],
};

export const prospectPost: GreenhouseJob = {
  id: 5004,
  internal_job_id: null,
  title: 'Machine Learning Intern (Prospect)',
  location: { name: 'Remote' },
  updated_at: '2026-07-17T12:00:00Z',
  absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/5004',
  content: '&lt;p&gt;General prospect pool.&lt;/p&gt;',
};

export const acmeJobsResponse: GreenhouseJobsResponse = {
  jobs: [technicalInternship, nontechnicalInternship, technicalFullTime, prospectPost],
  meta: { total: 4 },
};
