import { createHash, randomUUID } from 'node:crypto';
import type { D1EmployerStore } from './employer-store.js';
import type { InternshipStore } from '../src/store.js';
import type { EmployerAuditEvent, EmployerSubmission, EmployerVerificationState } from '../src/employer-types.js';
import { automaticPublishingEligibility, verificationExpiresAt, verificationIsActive } from '../src/employer-types.js';
import { deadlineHasPassed, publishedInternshipFromSubmission } from '../src/employer-submission.js';
import type { Internship } from '../src/types.js';
import { parseEmployerBoardUrl } from '../src/employer/index.js';
import { normalizeUrl } from '../src/core/normalize.js';

const json = (status: number, value: unknown) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

function redactedEvidence(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:by|actor|email|note|token|credential)$/iu.test(key)));
}

function canonicalConfig(value: unknown): string {
  const canonical = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(canonical);
    if (!child || typeof child !== 'object') return child;
    return Object.fromEntries(Object.entries(child as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)]));
  };
  return JSON.stringify(canonical(value));
}

async function input(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > 32 * 1024) throw new Error('Request body is too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 32 * 1024) throw new Error('Request body is too large');
  let value: unknown;
  try { value = JSON.parse(text || '{}'); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object');
  return value as Record<string, unknown>;
}

function operationKey(request: Request): string {
  const value = request.headers.get('Idempotency-Key')?.trim();
  if (!value || value.length > 160) throw new Error('Idempotency-Key is required');
  return value;
}

function reviewerAudit(orgId: string, actor: string, action: string, subjectType: string, subjectId: string, timestamp: string, key: string, details?: Record<string, unknown>): EmployerAuditEvent {
  return { id: randomUUID(), organizationId: orgId, action, actorType: 'reviewer', actorId: actor, subjectType, subjectId, createdAt: timestamp, idempotencyKey: key, details };
}

export async function employerAutomaticPublishingEligibility(store: D1EmployerStore, organizationId: string, now = new Date()) {
  const [verification, submissions, reports, audits] = await Promise.all([
    store.getVerification(organizationId), store.listSubmissions(organizationId), store.listReports(organizationId), store.listAuditEvents(organizationId),
  ]);
  const latestAudit = (...actions: string[]) => audits.filter((event) => actions.includes(event.action)).map((event) => event.createdAt).sort().at(-1);
  const publishedIds = new Set(audits.filter((event) => ['submission.published', 'submission.automatically_published'].includes(event.action))
    .map((event) => event.subjectId).filter((value): value is string => Boolean(value)));
  return automaticPublishingEligibility({
    verifiedSince: verification?.verifiedAt,
    approvedSubmissionCount: Math.max(publishedIds.size, submissions.filter((item) => item.state === 'published').length),
    latestRejectionAt: latestAudit('submission.rejected') ?? submissions.filter((item) => item.state === 'rejected').map((item) => item.updatedAt).sort().at(-1),
    latestQuarantineAt: latestAudit('submission.quarantined', 'submission.quarantined_for_owner_deletion') ?? submissions.filter((item) => item.state === 'quarantined').map((item) => item.updatedAt).sort().at(-1),
    latestUpheldReportAt: latestAudit('report.upheld') ?? reports.filter((item) => item.state === 'upheld').map((item) => item.resolvedAt!).sort().at(-1),
    latestVerificationLapseAt: latestAudit('verification.expired', 'verification.revoked', 'verification.revoked_for_owner_deletion'),
  }, now);
}

export async function closeEmployerOccurrence(jobs: InternshipStore, organizationId: string, submissionId?: string, applicationUrl?: string): Promise<void> {
  if (!submissionId) return;
  const submissionsSource = `employer:${organizationId}:submission:${submissionId}`;
  const occurrences = await jobs.getSourceOccurrences(submissionsSource);
  const candidates = [...new Set(occurrences.map((occurrence) => occurrence.jobId))];
  if (!candidates.length && applicationUrl) {
    const byUrl = await jobs.findByUrl(normalizeUrl(applicationUrl));
    if (byUrl) candidates.push(byUrl.jobId);
  }
  for (const candidate of candidates) {
    const job = await jobs.getJob(candidate);
    if (!job) continue;
    const references = job.sourceReferences.map((reference) => reference.sourceId === submissionsSource ? { ...reference, state: 'closed' as const } : reference);
    await jobs.putInternship({ ...job, sourceReferences: references, open: references.some((reference) => reference.state === 'open') });
  }
}

export async function runEmployerMaintenance(store: D1EmployerStore, jobs: InternshipStore, now = new Date()): Promise<{ expiredVerifications: number; closedDeadlines: number; redactedOrganizations: number }> {
  const timestamp = now.toISOString(); let expiredVerifications = 0; let closedDeadlines = 0;
  const verified = await store.listVerificationsByState('verified');
  for (const verification of verified) {
    if (!verification.expiresAt || Date.parse(verification.expiresAt) > now.getTime()) continue;
    expiredVerifications += 1;
    await store.putVerification({ ...verification, state: 'expired', updatedAt: timestamp }, {
      id: randomUUID(), organizationId: verification.organizationId, action: 'verification.expired', actorType: 'system',
      subjectType: 'organization', subjectId: verification.organizationId, createdAt: timestamp,
    });
    const privilege = await store.getPublishingPrivilege(verification.organizationId);
    await store.putPublishingPrivilege({ organizationId: verification.organizationId, automaticPublishingEnabled: false,
      enabledAt: privilege?.enabledAt, enabledBy: privilege?.enabledBy, suspendedAt: timestamp,
      suspensionReason: 'Employer verification expired', updatedAt: timestamp }, {
      id: randomUUID(), organizationId: verification.organizationId, action: 'automatic-publishing.suspended', actorType: 'system',
      subjectType: 'organization', subjectId: verification.organizationId, details: { reason: 'Employer verification expired' }, createdAt: timestamp,
    });
    for (const source of await store.listSources(verification.organizationId)) {
      await store.putSource({ ...source, state: 'stale', reason: 'Employer verification expired; renew verification and repeat source review.', updatedAt: timestamp }, {
        id: randomUUID(), organizationId: verification.organizationId, action: 'source.stale', actorType: 'system',
        subjectType: 'source', subjectId: source.id, details: { reason: 'Employer verification expired' }, createdAt: timestamp,
      });
      if (source.sourceId) {
        const reviewed = (await store.listReviewedSources(source.provider)).find((candidate) => candidate.sourceId === source.sourceId);
        if (reviewed) await store.putReviewedSource({ ...reviewed, state: 'disabled', updatedAt: timestamp });
      }
    }
    for (const submission of await store.listSubmissions(verification.organizationId, 'published')) {
      await store.putSubmission({ ...submission, state: 'quarantined', reason: 'Employer verification expired', updatedAt: timestamp }, {
        id: randomUUID(), organizationId: verification.organizationId, action: 'submission.quarantined', actorType: 'system',
        subjectType: 'submission', subjectId: submission.id, details: { reason: 'Employer verification expired' }, createdAt: timestamp,
      });
      await closeEmployerOccurrence(jobs, verification.organizationId, submission.id, submission.applicationUrl);
    }
  }
  for (const submission of await store.listSubmissionsByState('published')) {
    if (!deadlineHasPassed(submission, now)) continue;
    closedDeadlines += 1;
    await store.putSubmission({ ...submission, state: 'closed', reason: 'Application deadline passed', closedAt: timestamp, updatedAt: timestamp }, {
      id: randomUUID(), organizationId: submission.organizationId, action: 'submission.closed', actorType: 'system',
      subjectType: 'submission', subjectId: submission.id, details: { reason: 'Application deadline passed' }, createdAt: timestamp,
    });
    await closeEmployerOccurrence(jobs, submission.organizationId, submission.id, submission.applicationUrl);
  }
  const [, , , redactedOrganizations] = await Promise.all([
    store.deleteExpiredChallenges(now), store.deleteExpiredInvitations(now),
    store.deleteIdempotencyBefore(new Date(now.getTime() - 30 * 86_400_000)), store.redactRetainedOrganizations(now),
  ]);
  return { expiredVerifications, closedDeadlines, redactedOrganizations };
}

export async function publishEmployerSubmission(jobs: InternshipStore, submission: EmployerSubmission, timestamp: string): Promise<Internship> {
  const incoming = publishedInternshipFromSubmission(submission, timestamp);
  const postingIdentity = {
    provider: 'unknown' as const, canonicalApplicationUrl: incoming.normalizedUrl,
    aliases: [{ kind: 'application-url' as const, value: incoming.normalizedUrl }], canonicalJobId: incoming.jobId,
  };
  const resolution = await jobs.claimPostingIdentity(postingIdentity, incoming.jobId);
  if (resolution.outcome === 'quarantine') throw new Error('Submission aliases conflict with more than one catalog role');
  const existing = await jobs.getJob(resolution.canonicalJobId);
  if (existing) {
    const duplicate = existing.sourceReferences.some((reference) => reference.sourceId === incoming.sourceReferences[0]!.sourceId);
    const merged: Internship = {
      ...existing,
      sourceReferences: duplicate ? existing.sourceReferences : [...existing.sourceReferences, incoming.sourceReferences[0]!],
      workAuthorizationStatus: existing.workAuthorizationStatus && existing.workAuthorizationStatus !== 'unknown' ? existing.workAuthorizationStatus : incoming.workAuthorizationStatus,
      applicationDeadline: existing.applicationDeadline ?? incoming.applicationDeadline,
      graduationWindow: existing.graduationWindow ?? incoming.graduationWindow,
      programType: existing.programType ?? incoming.programType,
      workMode: existing.workMode ?? incoming.workMode,
      open: true, lastSeenAt: timestamp,
    };
    await jobs.putInternship(merged);
    return merged;
  }
  const created = { ...incoming, jobId: resolution.canonicalJobId, postingIdentity: { ...postingIdentity, canonicalJobId: resolution.canonicalJobId } };
  await jobs.putInternshipWithNotificationEvent(created, {
    eventId: createHash('sha256').update(`employer-submission:${submission.id}`).digest('hex'), sourceId: created.sourceReferences[0]!.sourceId,
    externalId: submission.id, jobId: created.jobId, kind: 'new-job', createdAt: timestamp,
  });
  return created;
}

export async function handleEmployerOperations(request: Request, dependencies: {
  store: D1EmployerStore; jobs: InternshipStore; actor: string; now?: () => Date;
  validateReviewedHost: (host: string) => Promise<void>;
}): Promise<Response> {
  const { store, jobs, actor } = dependencies; const path = new URL(request.url).pathname;
  const timestamp = (dependencies.now ?? (() => new Date()))().toISOString();
  try {
    if (request.method === 'GET' && path === '/operations/employers/queues') {
      const [claims, reverify, sources, proposals, submissions, reports] = await Promise.all([
        store.listVerificationsByState('review-pending'), store.listVerificationsByState('expired'),
        store.listSourcesByState('pending-review'), store.listFieldProposalsByState('pending-review'),
        store.listSubmissionsByState('pending-review'), store.listReportsByState('open'),
      ]);
      return json(200, { claims, reverify, sources, proposals, submissions, reports });
    }
    if (request.method === 'GET' && path === '/operations/employers/reviewed-sources/export') {
      const sources = (await store.listReviewedSources()).map((source) => ({
        sourceId: source.sourceId, provider: source.provider, organizationId: source.organizationId,
        state: source.state, config: source.config, evidence: redactedEvidence(source.evidence),
        createdAt: source.createdAt, updatedAt: source.updatedAt,
      }));
      return json(200, { generatedAt: timestamp, sources });
    }
    const match = path.match(/^\/operations\/employers\/organizations\/([^/]+)\/(verification|sources|proposals|submissions|reports|automatic-publishing)(?:\/([^/]+))?(?:\/decision)?$/u);
    if (!match || request.method !== 'POST') return json(404, { message: 'Not found' });
    const orgId = decodeURIComponent(match[1]!); const resource = match[2]!; const resourceId = match[3] ? decodeURIComponent(match[3]) : orgId;
    const organization = await store.getOrganization(orgId); if (!organization) return json(404, { message: 'Organization not found' });
    const body = await input(request); const key = operationKey(request); const operation = `operator.${resource}.decision`;
    const currentVerification = await store.getVerification(orgId);
    const requiresActiveTrust = (resource === 'sources' && (body.decision === 'active' || body.decision === 'shadow'))
      || (resource === 'proposals' && body.decision === 'accepted')
      || (resource === 'submissions' && body.decision === 'published')
      || (resource === 'automatic-publishing' && body.enabled === true);
    if (requiresActiveTrust && (organization.state !== 'active' || !verificationIsActive(currentVerification, new Date(timestamp)))) {
      return json(409, { message: 'Active employer verification is required for this decision' });
    }
    const replayed = await store.idempotencyResult<Record<string, unknown>>(orgId, operation, key);
    if (replayed) return json(200, { ...replayed, replayed: true });
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1_000) : '';

    if (resource === 'verification') {
      const decision = body.decision as EmployerVerificationState;
      if (!['verified', 'rejected', 'revoked'].includes(decision)) throw new Error('Verification decision is not supported');
      if (decision === 'verified' && organization.state !== 'active') return json(409, { message: 'A closed organization must be explicitly reopened before verification' });
      if (decision !== 'verified' && !reason) throw new Error('A reason is required');
      const verification = { organizationId: orgId, state: decision, reason: reason || undefined, reviewedBy: actor, updatedAt: timestamp, ...(decision === 'verified' ? { verifiedAt: timestamp, expiresAt: verificationExpiresAt(timestamp) } : {}) };
      const result = { verification };
      await store.putVerification(verification, reviewerAudit(orgId, actor, `verification.${decision}`, 'organization', orgId, timestamp, key, reason ? { reason } : undefined));
      if (decision === 'revoked') {
        const retainUntil = new Date(Date.parse(timestamp) + 365 * 86_400_000).toISOString();
        await store.putOrganization({ ...organization, state: 'closed', closedAt: timestamp, retainUntil, updatedAt: timestamp },
          reviewerAudit(orgId, actor, 'organization.closed', 'organization', orgId, timestamp, `${key}:closure`, { reason, retainUntil }));
        const privilege = await store.getPublishingPrivilege(orgId);
        await store.putPublishingPrivilege({ organizationId: orgId, automaticPublishingEnabled: false, enabledAt: privilege?.enabledAt, enabledBy: privilege?.enabledBy, suspendedAt: timestamp, suspensionReason: reason, updatedAt: timestamp },
          reviewerAudit(orgId, actor, 'automatic-publishing.suspended', 'organization', orgId, timestamp, `${key}:privilege`, { reason }));
        for (const source of await store.listSources(orgId)) {
          await store.putSource({ ...source, state: 'quarantined', reason: `Organization revoked: ${reason}`, updatedAt: timestamp },
            reviewerAudit(orgId, actor, 'source.quarantined', 'source', source.id, timestamp, `${key}:source:${source.id}`, { reason }));
          if (source.sourceId) {
            const reviewed = (await store.listReviewedSources(source.provider)).find((candidate) => candidate.sourceId === source.sourceId);
            if (reviewed) await store.putReviewedSource({ ...reviewed, state: 'quarantined', updatedAt: timestamp });
          }
        }
        for (const submission of await store.listSubmissions(orgId, 'published')) {
          await store.putSubmission({ ...submission, state: 'quarantined', reason: `Organization revoked: ${reason}`, updatedAt: timestamp });
          await closeEmployerOccurrence(jobs, orgId, submission.id, submission.applicationUrl);
        }
      }
      await store.claimIdempotency(orgId, operation, key, timestamp, result);
      return json(200, result);
    }

    if (resource === 'sources') {
      const source = await store.getSource(orgId, resourceId); if (!source) return json(404, { message: 'Source not found' });
      const decision = body.decision;
      if (!['shadow', 'active', 'rejected', 'quarantined', 'disconnected'].includes(decision as string)) throw new Error('Source decision is not supported');
      if (decision !== 'shadow' && decision !== 'active' && !reason) throw new Error('A reason is required');
      if (decision === 'active' && source.state !== 'active') {
        const baseline = source.sourceId ? await jobs.getCheckpoint(`shadow-${source.sourceId}`) : undefined;
        if (!baseline?.lastSuccessAt || (baseline.successfulFetches ?? 0) < 2) throw new Error('Source promotion requires two successful shadow snapshots');
      }
      const updated = { ...source, state: decision as typeof source.state, reason: reason || undefined, updatedAt: timestamp };
      const result = { source: updated };
      if (source.sourceId && ['greenhouse', 'lever', 'ashby'].includes(source.provider)) {
        const existing = (await store.listReviewedSources(source.provider)).find((candidate) => candidate.sourceId === source.sourceId);
        if (decision === 'shadow' || decision === 'active') {
          const board = parseEmployerBoardUrl(source.url); if (!board || board.provider !== source.provider) throw new Error('Reviewed source no longer has an exact provider board identity');
          const suppliedHosts = Array.isArray(body.allowedApplicationHosts) ? body.allowedApplicationHosts.filter((host): host is string => typeof host === 'string' && Boolean(host.trim())).map((host) => host.toLowerCase()) : [];
          for (const host of suppliedHosts) await dependencies.validateReviewedHost(host);
          const status = decision === 'active' ? 'published' as const : 'shadow' as const;
          const config = source.provider === 'greenhouse' ? {
            id: source.sourceId, employerId: orgId, displayName: organization.name, aliases: [], boardToken: board.tenant,
            careersUrl: source.url, expectedBoardNames: [organization.name], admittedBoardName: organization.name,
            admittedAt: timestamp, allowedInitialHosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
            allowedFinalHosts: suppliedHosts.length ? suppliedHosts : ['boards.greenhouse.io', 'job-boards.greenhouse.io'], status,
          } : source.provider === 'lever' ? {
            id: source.sourceId, company: organization.name, site: board.tenant, careersUrl: source.url,
            admittedAt: timestamp, status, region: 'global', evidenceStatus: 'agent-verified',
          } : {
            id: source.sourceId, company: organization.name, identity: { provider: 'ashby', boardKey: board.tenant, apiRegion: 'global' },
            careersUrl: source.url, admittedAt: timestamp, evidenceState: 'ownership-verified',
            allowedApplicationHosts: (suppliedHosts.length ? suppliedHosts : ['jobs.ashbyhq.com']).map((host) => ({ host })), status,
          };
          await store.putReviewedSource({ sourceId: source.sourceId, provider: source.provider, organizationId: orgId, config,
            evidence: { reviewedBy: actor, reviewedAt: timestamp, reason: reason || 'Ownership and source contract reviewed' }, state: decision, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
        } else if (existing) {
          await store.putReviewedSource({ ...existing, state: decision === 'quarantined' ? 'quarantined' : 'disabled', updatedAt: timestamp,
            evidence: { ...existing.evidence, lastDecisionBy: actor, lastDecisionAt: timestamp, reason } });
        }
      } else if (source.sourceId && ['json-ld', 'sitemap', 'embedded'].includes(source.provider)) {
        const existing = (await store.listReviewedSources(source.provider)).find((candidate) => candidate.sourceId === source.sourceId);
        const reviewedHosts = Array.isArray(body.allowedApplicationHosts)
          ? body.allowedApplicationHosts.filter((host): host is string => typeof host === 'string' && Boolean(host.trim()))
            .map((host) => ({ host: host.trim().toLowerCase() }))
          : [];
        for (const { host } of reviewedHosts) await dependencies.validateReviewedHost(host);
        if ((decision === 'active' || decision === 'shadow') && !reviewedHosts.length) {
          throw new Error('Structured source approval requires at least one reviewed application host');
        }
        const embedded = source.provider === 'embedded' && body.embedded && typeof body.embedded === 'object' && !Array.isArray(body.embedded)
          ? body.embedded as Record<string, unknown> : undefined;
        if ((decision === 'active' || decision === 'shadow') && source.provider === 'embedded'
          && (typeof embedded?.scriptId !== 'string' || !Array.isArray(embedded.jobsPath)
            || !embedded.jobsPath.every((item) => typeof item === 'string'))) {
          throw new Error('Embedded source approval requires an exact scriptId and jobsPath');
        }
        const config = { id: source.sourceId, url: source.url, employer: { id: orgId, name: organization.name },
          allowedApplicationHosts: reviewedHosts.length ? reviewedHosts : existing?.config.allowedApplicationHosts,
          ...(embedded ? { embedded } : existing?.config.embedded ? { embedded: existing.config.embedded } : {}) };
        if (decision === 'active' && (source.state !== 'shadow' || existing?.state !== 'shadow'
          || canonicalConfig(config) !== canonicalConfig(existing.config))) {
          throw new Error('Structured source promotion must exactly match the shadow-reviewed configuration');
        }
        await store.putReviewedSource({ sourceId: source.sourceId, provider: source.provider, organizationId: orgId,
          config,
          evidence: { ...(existing?.evidence ?? {}), reviewedBy: actor, reviewedAt: timestamp, reason },
          state: decision === 'active' || decision === 'shadow' ? decision : decision === 'quarantined' ? 'quarantined' : 'disabled',
          createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
      }
      await store.putSource(updated, reviewerAudit(orgId, actor, `source.${decision}`, 'source', source.id, timestamp, key, reason ? { reason } : undefined));
      await store.claimIdempotency(orgId, operation, key, timestamp, result);
      return json(200, result);
    }

    if (resource === 'proposals') {
      const proposal = await store.getFieldProposal(orgId, resourceId); if (!proposal) return json(404, { message: 'Proposal not found' });
      const decision = body.decision; if (!['accepted', 'rejected'].includes(decision as string)) throw new Error('Proposal decision is not supported');
      if (!reason) throw new Error('A reason is required, including why observed evidence is stale or incorrect for an override');
      const updated = { ...proposal, state: decision as 'accepted' | 'rejected', reason: reason || undefined, decidedAt: timestamp, decidedBy: actor };
      const result = { proposal: updated };
      if (decision === 'accepted') {
        const job = await jobs.getJob(proposal.jobId); if (!job) return json(404, { message: 'Role not found' });
        const existing = job.employerMetadataAttribution?.[proposal.field] ?? [];
        await jobs.putInternship({ ...job, [proposal.field]: proposal.proposedValue,
          employerMetadataAttribution: { ...job.employerMetadataAttribution,
            [proposal.field]: existing.some((attribution) => attribution.proposalId === proposal.id)
              ? existing : [...existing, { organizationId: orgId, proposalId: proposal.id, evidenceAt: proposal.evidenceAt }] } });
      }
      await store.putFieldProposal(updated, reviewerAudit(orgId, actor, `proposal.${decision}`, 'field-proposal', proposal.id, timestamp, key, { reason, field: proposal.field, originalValue: proposal.originalValue, proposedValue: proposal.proposedValue }));
      await store.claimIdempotency(orgId, operation, key, timestamp, result);
      return json(200, result);
    }

    if (resource === 'submissions') {
      const submission = await store.getSubmission(orgId, resourceId); if (!submission) return json(404, { message: 'Submission not found' });
      const decision = body.decision; if (!['published', 'rejected', 'quarantined'].includes(decision as string)) throw new Error('Submission decision is not supported');
      if (decision !== 'published' && !reason) throw new Error('A reason is required');
      const updated = { ...submission, state: decision as EmployerSubmission['state'], reason: reason || undefined, updatedAt: timestamp, ...(decision === 'published' ? { publishedAt: submission.publishedAt ?? timestamp } : {}) };
      const result: { submission: EmployerSubmission; jobId?: string } = { submission: updated };
      if (decision === 'published') result.jobId = (await publishEmployerSubmission(jobs, updated, timestamp)).jobId;
      else await closeEmployerOccurrence(jobs, orgId, submission.id, submission.applicationUrl);
      await store.putSubmission(updated, reviewerAudit(orgId, actor, `submission.${decision}`, 'submission', submission.id, timestamp, key, reason ? { reason } : undefined));
      await store.claimIdempotency(orgId, operation, key, timestamp, result);
      return json(200, result);
    }

    if (resource === 'reports') {
      const report = (await store.listReports(orgId)).find((candidate) => candidate.id === resourceId); if (!report) return json(404, { message: 'Report not found' });
      const decision = body.decision; if (!['upheld', 'dismissed'].includes(decision as string) || !reason) throw new Error('A decision and reason are required');
      const updated = { ...report, state: decision as 'upheld' | 'dismissed', resolvedAt: timestamp, resolvedBy: actor };
      const result = { report: updated };
      await store.putReport(updated, reviewerAudit(orgId, actor, `report.${decision}`, 'report', report.id, timestamp, key, { reason }));
      if (decision === 'upheld') {
        const privilege = await store.getPublishingPrivilege(orgId);
        await store.putPublishingPrivilege({ organizationId: orgId, automaticPublishingEnabled: false, enabledAt: privilege?.enabledAt, enabledBy: privilege?.enabledBy, suspendedAt: timestamp, suspensionReason: `Upheld report ${report.id}: ${reason}`, updatedAt: timestamp },
          reviewerAudit(orgId, actor, 'automatic-publishing.suspended', 'organization', orgId, timestamp, `${key}:privilege`, { reason, reportId: report.id }));
        const reportedSubmission = report.submissionId ? await store.getSubmission(orgId, report.submissionId) : undefined;
        if (reportedSubmission) await store.putSubmission({ ...reportedSubmission, state: 'quarantined', reason: `Upheld report: ${reason}`, updatedAt: timestamp },
          reviewerAudit(orgId, actor, 'submission.quarantined', 'submission', reportedSubmission.id, timestamp, `${key}:submission`, { reason, reportId: report.id }));
        await closeEmployerOccurrence(jobs, orgId, report.submissionId, reportedSubmission?.applicationUrl);
      }
      await store.claimIdempotency(orgId, operation, key, timestamp, result);
      return json(200, result);
    }

    const eligibility = await employerAutomaticPublishingEligibility(store, orgId, new Date(timestamp));
    if (body.enabled === true && !eligibility.eligible) return json(409, { message: 'Organization is not eligible for automatic publishing', eligibility });
    const privilege = { organizationId: orgId, automaticPublishingEnabled: body.enabled === true, enabledAt: body.enabled === true ? timestamp : undefined, enabledBy: body.enabled === true ? actor : undefined, updatedAt: timestamp };
    const result = { privilege, eligibility };
    await store.putPublishingPrivilege(privilege, reviewerAudit(orgId, actor, `automatic-publishing.${body.enabled === true ? 'enabled' : 'disabled'}`, 'organization', orgId, timestamp, key));
    await store.claimIdempotency(orgId, operation, key, timestamp, result);
    return json(200, result);
  } catch (error) { return json(400, { message: error instanceof Error ? error.message : 'Invalid request' }); }
}
