import { createHash, randomUUID } from 'node:crypto';
import type { D1EmployerStore } from './employer-store.js';
import type { InternshipStore } from '../src/store.js';
import type { EmployerAuditEvent, EmployerMembershipRole, EmployerVerificationChallenge } from '../src/employer-types.js';
import { canAutomaticallyPublish, canManageEmployer, invitationIsUsable, verificationIsActive } from '../src/employer-types.js';
import { createEmployerChallenge, emailMatchesCompanyDomain, hashChallengeToken, normalizeCompanyDomain, parseEmployerBoardUrl } from '../src/employer/index.js';
import { parseEmployerSubmission } from '../src/employer-submission.js';
import { normalizeUrl } from '../src/core/normalize.js';
import { employerAutomaticPublishingEligibility, publishEmployerSubmission } from './employer-operations-api.js';

const json = (status: number, value: unknown) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const identifier = (prefix: string, value: string) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;

async function body(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > 32 * 1024) throw new Error('Request body is too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 32 * 1024) throw new Error('Request body is too large');
  const parsed = JSON.parse(text || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be an object');
  return parsed as Record<string, unknown>;
}

function idempotencyKey(request: Request): string {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key || key.length > 160) throw new Error('Idempotency-Key is required and must be at most 160 characters');
  return key;
}

function audit(input: {
  organizationId: string; action: string; actorId: string; subjectType: string;
  subjectId?: string; createdAt: string; key?: string; details?: Record<string, unknown>;
}): EmployerAuditEvent {
  return {
    id: randomUUID(), organizationId: input.organizationId, action: input.action, actorType: 'member',
    actorId: input.actorId, subjectType: input.subjectType, subjectId: input.subjectId,
    createdAt: input.createdAt, idempotencyKey: input.key, details: input.details,
  };
}

async function replay<T>(store: D1EmployerStore, orgId: string, operation: string, key: string): Promise<T | undefined> {
  return store.idempotencyResult<T>(orgId, operation, key);
}

async function claim<T extends object>(store: D1EmployerStore, orgId: string, operation: string, key: string, timestamp: string, result: T): Promise<T & { replayed?: true }> {
  if (!await store.claimIdempotency(orgId, operation, key, timestamp, result)) {
    return { ...(await replay<T>(store, orgId, operation, key) ?? result), replayed: true };
  }
  return result;
}

export interface EmployerApiDependencies {
  store: D1EmployerStore;
  jobs: InternshipStore;
  userId: string;
  userEmail: string;
  now?: () => Date;
  verifyPublishedChallenge?: (challenge: EmployerVerificationChallenge, domain: string, token: string) => Promise<boolean>;
  validateSourceUrl: (url: string) => Promise<void>;
}

async function organizationView(store: D1EmployerStore, orgId: string, userId: string) {
  const [organization, membership, verification, privilege] = await Promise.all([
    store.getOrganization(orgId), store.getMembership(orgId, userId), store.getVerification(orgId), store.getPublishingPrivilege(orgId),
  ]);
  if (!organization || !membership) return undefined;
  return {
    organizationId: organization.id, name: organization.name, domain: organization.domain, role: membership.role,
    verificationState: verification?.state ?? 'challenge-pending', verificationReason: verification?.reason,
    verificationExpiresAt: verification?.expiresAt, activeChallengeId: verification?.challengeId, privilege,
  };
}

const sourceView = (source: Awaited<ReturnType<D1EmployerStore['listSources']>>[number]) => ({
  sourceId: source.id, provider: source.provider, url: source.url, state: source.state, reason: source.reason,
});
async function sourceViews(store: D1EmployerStore, jobs: InternshipStore, orgId: string) {
  return Promise.all((await store.listSources(orgId)).map(async (source) => {
    const health = source.sourceId ? await jobs.getSourceHealth(source.sourceId) : undefined;
    const state = health?.state === 'quarantined' ? 'quarantined' as const : source.state;
    return { ...sourceView({ ...source, state }), reason: source.reason ?? health?.lastSafeDiagnostic, lastSuccessfulAt: health?.lastSuccessAt };
  }));
}
const proposalView = (proposal: Awaited<ReturnType<D1EmployerStore['listFieldProposals']>>[number]) => ({
  proposalId: proposal.id, jobId: proposal.jobId, field: proposal.field,
  originalValue: proposal.originalValue === undefined ? undefined : JSON.stringify(proposal.originalValue),
  proposedValue: typeof proposal.proposedValue === 'string' ? proposal.proposedValue : JSON.stringify(proposal.proposedValue),
  state: proposal.state, reason: proposal.reason,
});
const submissionView = (submission: Awaited<ReturnType<D1EmployerStore['listSubmissions']>>[number]) => ({
  submissionId: submission.id, title: submission.title, state: submission.state, reason: submission.reason, updatedAt: submission.updatedAt,
});

async function memberViews(store: D1EmployerStore, orgId: string) {
  const [members, invitations] = await Promise.all([store.listMemberProfiles(orgId), store.listInvitations(orgId)]);
  return [
    ...members.map((member) => ({ membershipId: `member:${member.userId}`, userId: member.userId, email: member.email, role: member.role, state: 'active' as const })),
    ...invitations.map((invitation) => ({ membershipId: `invitation:${invitation.id}`, email: invitation.email, role: invitation.role,
      state: invitation.revokedAt ? 'revoked' as const : invitation.acceptedAt ? 'active' as const : Date.parse(invitation.expiresAt) <= Date.now() ? 'expired' as const : 'invited' as const })),
  ];
}

function metadataValue(field: string, value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('proposedValue must be a non-empty short string');
  const text = value.trim();
  if (field === 'compensation') return { raw: text };
  if (field === 'programType') {
    if (!['internship', 'co-op', 'apprenticeship', 'new-grad', 'entry-level'].includes(text)) throw new Error('programType is not supported');
    return text;
  }
  if (field === 'workMode') {
    if (!['remote', 'hybrid', 'onsite', 'unspecified'].includes(text)) throw new Error('workMode is not supported');
    return text;
  }
  if (field === 'workAuthorizationStatus') {
    if (!['sponsorship-available', 'no-sponsorship', 'existing-authorization-required', 'citizenship-required', 'unknown'].includes(text)) throw new Error('workAuthorizationStatus is not supported');
    return text;
  }
  if (field === 'applicationDeadline' && text === 'rolling') return { kind: 'rolling' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${field} must be valid structured JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field} must be a structured object`);
  return parsed;
}

export async function handleEmployerApi(request: Request, dependencies: EmployerApiDependencies): Promise<Response> {
  const { store, userId } = dependencies;
  const url = new URL(request.url);
  const path = url.pathname;
  const timestamp = (dependencies.now ?? (() => new Date()))().toISOString();
  try {
    if (request.method === 'GET' && path === '/employer/organizations') {
      const memberships = await store.listOrganizationsForUser(userId);
      const organizations = await Promise.all(memberships.map(({ organization }) => organizationView(store, organization.id, userId)));
      return json(200, { organizations: organizations.filter(Boolean) });
    }
    if (request.method === 'POST' && path === '/employer/organizations') {
      const input = await body(request); const key = idempotencyKey(request);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const domain = typeof input.domain === 'string' ? normalizeCompanyDomain(input.domain) : undefined;
      if (!name || name.length > 200 || !domain) throw new Error('A valid organization name and domain are required');
      const deterministicId = identifier('org', `${userId}:${key}`);
      const priorClaim = await store.getOrganization(deterministicId);
      if (priorClaim) {
        if (priorClaim.name !== name || priorClaim.domain !== domain) return json(409, { message: 'Idempotency-Key was already used for a different organization claim' });
        const view = await organizationView(store, priorClaim.id, userId);
        if (view) return json(200, { organization: view, replayed: true });
        await store.putMembership({ organizationId: priorClaim.id, userId, role: 'owner', createdAt: timestamp, updatedAt: timestamp }, audit({ organizationId: priorClaim.id, action: 'membership.created', actorId: userId, subjectType: 'membership', subjectId: userId, createdAt: timestamp, key: `${key}:owner` }));
        await store.putVerification({ organizationId: priorClaim.id, state: 'challenge-pending', updatedAt: timestamp });
        await claim(store, priorClaim.id, 'organization.claim', key, timestamp, { organizationId: priorClaim.id });
        return json(201, { organization: await organizationView(store, priorClaim.id, userId), recovered: true });
      }
      const existing = await store.getOrganizationByDomain(domain);
      if (existing) {
        const view = await organizationView(store, existing.id, userId);
        return view ? json(200, { organization: view, replayed: true }) : json(409, { message: 'That employer domain is already claimed' });
      }
      const organization = { id: deterministicId, name, domain, state: 'active' as const, createdAt: timestamp, updatedAt: timestamp };
      const created = await store.createOrganization(organization, audit({ organizationId: organization.id, action: 'organization.claimed', actorId: userId, subjectType: 'organization', subjectId: organization.id, createdAt: timestamp, key }));
      if (!created) {
        const raced = await store.getOrganization(deterministicId);
        if (!raced || raced.name !== name || raced.domain !== domain) return json(409, { message: 'Idempotency-Key was already used for a different organization claim' });
      }
      await store.putMembership({ organizationId: organization.id, userId, role: 'owner', createdAt: timestamp, updatedAt: timestamp }, audit({ organizationId: organization.id, action: 'membership.created', actorId: userId, subjectType: 'membership', subjectId: userId, createdAt: timestamp, key: `${key}:owner` }));
      await store.putVerification({ organizationId: organization.id, state: 'challenge-pending', updatedAt: timestamp });
      await claim(store, organization.id, 'organization.claim', key, timestamp, { organizationId: organization.id });
      return json(201, { organization: await organizationView(store, organization.id, userId) });
    }

    const invitationAccept = path.match(/^\/employer\/invitations\/([^/]+)\/accept$/u);
    if (request.method === 'POST' && invitationAccept) {
      const token = decodeURIComponent(invitationAccept[1]!); const invitation = await store.invitationByTokenHash(await hashChallengeToken(token));
      if (!invitation || invitation.email.toLowerCase() !== dependencies.userEmail.toLowerCase()) {
        return json(410, { message: 'Invitation is invalid, expired, or belongs to another account' });
      }
      const key = idempotencyKey(request); const result = { organizationId: invitation.organizationId, role: invitation.role };
      if (await replay(store, invitation.organizationId, 'invitation.accept', key)) return json(200, { ...result, replayed: true });
      if (invitation.acceptedAt) {
        const acceptedMembership = await store.getMembership(invitation.organizationId, userId);
        if (!acceptedMembership) return json(409, { message: 'Invitation acceptance is incomplete; contact support' });
        return json(200, await claim(store, invitation.organizationId, 'invitation.accept', key, timestamp, result));
      }
      if (!invitationIsUsable(invitation, new Date(timestamp))) {
        return json(410, { message: 'Invitation is invalid, expired, or belongs to another account' });
      }
      await store.putMembership({ organizationId: invitation.organizationId, userId, role: invitation.role, createdAt: timestamp, updatedAt: timestamp }, audit({ organizationId: invitation.organizationId, action: 'membership.created', actorId: userId, subjectType: 'membership', subjectId: userId, createdAt: timestamp, key }));
      await store.putInvitation({ ...invitation, acceptedAt: timestamp }, audit({ organizationId: invitation.organizationId, action: 'invitation.accepted', actorId: userId, subjectType: 'invitation', subjectId: invitation.id, createdAt: timestamp, key: `${key}:invitation` }));
      await claim(store, invitation.organizationId, 'invitation.accept', key, timestamp, result);
      return json(200, result);
    }

    const orgMatch = path.match(/^\/employer\/organizations\/([^/]+)(?:\/(.*))?$/u);
    if (!orgMatch) return json(404, { message: 'Not found' });
    const orgId = decodeURIComponent(orgMatch[1]!); const suffix = orgMatch[2] ?? '';
    const membership = await store.getMembership(orgId, userId);
    if (!membership) return json(404, { message: 'Organization not found' });
    const organization = await store.getOrganization(orgId);
    if (!organization) return json(404, { message: 'Organization not found' });

    if (request.method === 'GET' && !suffix) {
      const [view, members, sources, proposals, submissions] = await Promise.all([
        organizationView(store, orgId, userId), memberViews(store, orgId),
        sourceViews(store, dependencies.jobs, orgId), store.listFieldProposals(orgId), store.listSubmissions(orgId),
      ]);
      return json(200, { organization: view,
        members: members.filter((member) => !member.membershipId.startsWith('invitation:') || member.state !== 'active'),
        invitations: members.filter((member) => member.membershipId.startsWith('invitation:')),
        sources, proposals: proposals.map(proposalView), submissions: submissions.map(submissionView) });
    }
    if (request.method === 'GET' && suffix === 'members') return json(200, { members: (await memberViews(store, orgId)).filter((member) => member.state === 'active' && !member.membershipId.startsWith('invitation:')) });
    if (request.method === 'GET' && suffix === 'invitations') return json(200, { invitations: (await memberViews(store, orgId)).filter((member) => member.membershipId.startsWith('invitation:')) });
    if (request.method === 'GET' && suffix === 'sources') return json(200, { sources: await sourceViews(store, dependencies.jobs, orgId) });
    if (request.method === 'GET' && suffix === 'proposals') return json(200, { proposals: (await store.listFieldProposals(orgId)).map(proposalView) });
    if (request.method === 'GET' && suffix === 'submissions') return json(200, { submissions: (await store.listSubmissions(orgId)).map(submissionView) });

    if (organization.state !== 'active') return json(409, { message: 'This organization is closed and cannot be changed' });

    if (request.method === 'POST' && suffix === 'challenges') {
      if (!canManageEmployer(membership.role, 'verification')) return json(403, { message: 'Owner access is required' });
      const input = await body(request); const key = idempotencyKey(request); const operation = 'challenge.create';
      const prior = await replay<{ challenge: { id: string } }>(store, orgId, operation, key);
      if (prior) return json(200, { ...prior, replayed: true });
      const method = input.method;
      if (!['email-domain', 'dns-txt', 'well-known'].includes(method as string)) throw new Error('Challenge method is not supported');
      if (method === 'email-domain') {
        const matches = emailMatchesCompanyDomain(dependencies.userEmail, organization.domain);
        if (!matches) return json(409, { message: 'Your verified account email must exactly match the claimed company domain' });
        await store.putVerification({ organizationId: orgId, state: 'review-pending', updatedAt: timestamp }, audit({ organizationId: orgId, action: 'verification.challenge_completed', actorId: userId, subjectType: 'organization', subjectId: orgId, createdAt: timestamp, key }));
        const result = await claim(store, orgId, operation, key, timestamp, { challenge: { id: identifier('challenge', key), organizationId: orgId, method: 'email-domain' as const, tokenHash: '', expiresAt: timestamp, createdAt: timestamp, completedAt: timestamp } });
        return json(201, result);
      }
      const generated = await createEmployerChallenge({ now: new Date(timestamp) });
      const challenge: EmployerVerificationChallenge = { id: identifier('challenge', `${orgId}:${key}`), organizationId: orgId, method: method as 'dns-txt' | 'well-known', tokenHash: generated.challenge.tokenHash, expiresAt: generated.challenge.expiresAt, createdAt: timestamp };
      await store.putChallenge(challenge, audit({ organizationId: orgId, action: 'verification.challenge_created', actorId: userId, subjectType: 'verification-challenge', subjectId: challenge.id, createdAt: timestamp, key }));
      await store.putVerification({ organizationId: orgId, state: 'challenge-pending', challengeId: challenge.id, updatedAt: timestamp });
      await claim(store, orgId, operation, key, timestamp, { challenge: { id: challenge.id } });
      return json(201, { challenge: { ...challenge, tokenHash: undefined }, token: generated.token });
    }

    const challengeMatch = suffix.match(/^challenges\/([^/]+)\/verify$/u);
    if (request.method === 'POST' && challengeMatch) {
      if (!canManageEmployer(membership.role, 'verification')) return json(403, { message: 'Owner access is required' });
      const input = await body(request); const key = idempotencyKey(request); const token = typeof input.token === 'string' ? input.token : '';
      const prior = await replay<{ verificationState: 'review-pending' }>(store, orgId, 'challenge.verify', key);
      if (prior) return json(200, { ...prior, replayed: true });
      const challenge = await store.getChallenge(orgId, decodeURIComponent(challengeMatch[1]!));
      if (!challenge || await hashChallengeToken(token) !== challenge.tokenHash) return json(410, { message: 'Challenge is invalid, expired, or already used' });
      if (!challenge.completedAt) {
        if (Date.parse(challenge.expiresAt) <= Date.parse(timestamp)) return json(410, { message: 'Challenge is invalid, expired, or already used' });
        if (!dependencies.verifyPublishedChallenge || !await dependencies.verifyPublishedChallenge(challenge, organization.domain, token)) return json(409, { message: 'The verification token was not found. Publish it and try again.' });
        if (!await store.consumeChallenge(challenge.id, timestamp)) {
          const raced = await store.getChallenge(orgId, challenge.id);
          if (!raced?.completedAt) return json(410, { message: 'Challenge is invalid, expired, or already used' });
        }
      }
      const currentVerification = await store.getVerification(orgId);
      if (currentVerification
        && (currentVerification.state !== 'challenge-pending' || currentVerification.challengeId !== challenge.id)) {
        return json(200, await claim(store, orgId, 'challenge.verify', key, timestamp, { verificationState: 'review-pending' }));
      }
      await store.putVerification({ organizationId: orgId, state: 'review-pending', challengeId: challenge.id, updatedAt: timestamp }, audit({ organizationId: orgId, action: 'verification.challenge_completed', actorId: userId, subjectType: 'verification-challenge', subjectId: challenge.id, createdAt: timestamp, key }));
      return json(200, await claim(store, orgId, 'challenge.verify', key, timestamp, { verificationState: 'review-pending' }));
    }

    if (request.method === 'POST' && suffix === 'invitations') {
      if (!canManageEmployer(membership.role, 'members')) return json(403, { message: 'Owner access is required' });
      const input = await body(request); const key = idempotencyKey(request); const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const role = input.role as EmployerMembershipRole;
      if (!/^\S+@\S+\.\S+$/u.test(email) || !['owner', 'editor'].includes(role)) throw new Error('A valid email and role are required');
      const generated = await createEmployerChallenge({ now: new Date(timestamp), ttlMs: 7 * 86_400_000 });
      const invitation = { id: identifier('invite', `${orgId}:${key}`), organizationId: orgId, email, role, tokenHash: generated.challenge.tokenHash, expiresAt: generated.challenge.expiresAt, createdAt: timestamp };
      const publicInvitation = { membershipId: `invitation:${invitation.id}`, email, role, state: 'invited' as const };
      const prior = await replay<{ invitation: typeof publicInvitation }>(store, orgId, 'invitation.create', key);
      if (prior) return json(200, { ...prior, replayed: true });
      await store.putInvitation(invitation, audit({ organizationId: orgId, action: 'invitation.created', actorId: userId, subjectType: 'invitation', subjectId: invitation.id, createdAt: timestamp, key }));
      await claim(store, orgId, 'invitation.create', key, timestamp, { invitation: publicInvitation });
      return json(201, { invitation: publicInvitation, token: generated.token });
    }

    const memberMatch = suffix.match(/^members\/([^/]+)$/u);
    if (request.method === 'DELETE' && memberMatch) {
      if (!canManageEmployer(membership.role, 'members')) return json(403, { message: 'Owner access is required' });
      const target = decodeURIComponent(memberMatch[1]!); const key = idempotencyKey(request);
      if (target === userId) return json(409, { message: 'Transfer ownership before removing yourself' });
      const prior = await replay<{ removed: string }>(store, orgId, 'membership.remove', key);
      if (prior) return json(200, { ...prior, replayed: true });
      await store.removeMembership(orgId, target, audit({ organizationId: orgId, action: 'membership.removed', actorId: userId, subjectType: 'membership', subjectId: target, createdAt: timestamp, key }));
      const result = await claim(store, orgId, 'membership.remove', key, timestamp, { removed: target });
      return json(200, result);
    }

    if (request.method === 'POST' && suffix === 'sources') {
      if (!canManageEmployer(membership.role, 'sources')) return json(403, { message: 'Owner or editor access is required' });
      if (!verificationIsActive(await store.getVerification(orgId), new Date(timestamp))) return json(409, { message: 'Verify the organization before connecting a source' });
      const input = await body(request); const key = idempotencyKey(request); const rawUrl = typeof input.url === 'string' ? input.url : '';
      await dependencies.validateSourceUrl(rawUrl);
      const board = parseEmployerBoardUrl(rawUrl); const provider = input.provider ?? board?.provider ?? 'json-ld';
      if (['greenhouse', 'lever', 'ashby'].includes(provider as string) && board?.provider !== provider) throw new Error('Submit the exact provider board URL');
      if (!['greenhouse', 'lever', 'ashby', 'json-ld', 'sitemap', 'embedded'].includes(provider as string)) throw new Error('Source provider is not supported');
      const parsed = new URL(rawUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Source URL must use HTTPS');
      const source = { id: identifier('source', `${orgId}:${key}`), organizationId: orgId, provider: provider as 'greenhouse', url: board?.boardUrl ?? parsed.href, state: 'pending-review' as const, reason: 'A reviewer must confirm ownership, destination hosts, and a complete shadow baseline.', sourceId: identifier(String(provider), `${orgId}:${board?.tenant ?? parsed.href}`), createdAt: timestamp, updatedAt: timestamp };
      const prior = await replay<{ source: ReturnType<typeof sourceView> }>(store, orgId, 'source.create', key);
      if (prior) return json(200, { ...prior, replayed: true });
      await store.putSource(source, audit({ organizationId: orgId, action: 'source.created', actorId: userId, subjectType: 'source', subjectId: source.id, createdAt: timestamp, key }));
      const result = await claim(store, orgId, 'source.create', key, timestamp, { source: sourceView(source) });
      return json(201, result);
    }

    if (request.method === 'POST' && suffix === 'proposals') {
      if (!canManageEmployer(membership.role, 'proposals')) return json(403, { message: 'Owner or editor access is required' });
      if (!verificationIsActive(await store.getVerification(orgId), new Date(timestamp))) return json(409, { message: 'Verify the organization before proposing metadata' });
      const input = await body(request); const key = idempotencyKey(request);
      const jobId = typeof input.jobId === 'string' ? input.jobId : ''; const field = typeof input.field === 'string' ? input.field : '';
      const allowedFields = ['applicationDeadline', 'graduationWindow', 'programType', 'workMode', 'compensation', 'workAuthorizationStatus'];
      if (!jobId || !allowedFields.includes(field) || input.proposedValue === undefined) throw new Error('jobId, a supported field, and proposedValue are required');
      const job = await dependencies.jobs.getJob(jobId); if (!job) return json(404, { message: 'Role not found' });
      const proposedValue = metadataValue(field, input.proposedValue);
      const current = job[field as keyof typeof job];
      const missing = current === undefined || current === null || current === '' || current === 'unknown';
      const matching = !missing && JSON.stringify(current) === JSON.stringify(proposedValue);
      const state = missing || matching ? 'accepted' as const : 'pending-review' as const;
      const proposal = { id: identifier('proposal', `${orgId}:${key}`), organizationId: orgId, jobId, field, originalValue: current, proposedValue, evidenceAt: timestamp, state, createdBy: userId, createdAt: timestamp, ...(state === 'accepted' ? { decidedAt: timestamp, decidedBy: 'automatic-policy' } : {}) };
      const prior = await replay<{ proposal: ReturnType<typeof proposalView> }>(store, orgId, 'proposal.create', key);
      if (prior) return json(200, { ...prior, replayed: true });
      if (state === 'accepted') {
        const existing = job.employerMetadataAttribution?.[field] ?? [];
        await dependencies.jobs.putInternship({
          ...job, ...(missing ? { [field]: proposedValue } : {}),
          employerMetadataAttribution: { ...job.employerMetadataAttribution,
            [field]: existing.some((attribution) => attribution.proposalId === proposal.id)
              ? existing : [...existing, { organizationId: orgId, proposalId: proposal.id, evidenceAt: timestamp }] },
        });
      }
      await store.putFieldProposal(proposal, audit({ organizationId: orgId, action: state === 'accepted' ? 'proposal.automatically_accepted' : 'proposal.created', actorId: userId, subjectType: 'field-proposal', subjectId: proposal.id, createdAt: timestamp, key,
        details: { jobId, field, originalValue: current, proposedValue } }));
      const result = await claim(store, orgId, 'proposal.create', key, timestamp, { proposal: proposalView(proposal) });
      return json(201, result);
    }

    if (request.method === 'POST' && suffix === 'submissions') {
      if (!canManageEmployer(membership.role, 'submissions')) return json(403, { message: 'Owner or editor access is required' });
      if (!verificationIsActive(await store.getVerification(orgId), new Date(timestamp))) return json(409, { message: 'Verify the organization before submitting a role' });
      const input = await body(request); const key = idempotencyKey(request);
      const prior = await replay<{ submission: ReturnType<typeof submissionView> }>(store, orgId, 'submission.create', key);
      if (prior) return json(200, { ...prior, replayed: true });
      if (typeof input.applicationUrl === 'string') await dependencies.validateSourceUrl(input.applicationUrl);
      const hosts = (await store.listSources(orgId)).filter((source) => ['shadow', 'active'].includes(source.state)).map((source) => new URL(source.url).hostname);
      let submission = parseEmployerSubmission({ body: input, organizationId: orgId, organizationName: organization.name, organizationDomain: organization.domain, userId, allowedApplicationHosts: hosts, id: identifier('submission', `${orgId}:${key}`), now: timestamp });
      await store.putSubmission(submission, audit({ organizationId: orgId, action: 'submission.created', actorId: userId, subjectType: 'submission', subjectId: submission.id, createdAt: timestamp, key }));
      if (submission.state === 'pending-review') {
        const [verification, privilege, eligibility] = await Promise.all([
          store.getVerification(orgId), store.getPublishingPrivilege(orgId), employerAutomaticPublishingEligibility(store, orgId, new Date(timestamp)),
        ]);
        if (canAutomaticallyPublish({ organization, verification, privilege, eligibility }, new Date(timestamp))) {
          submission = { ...submission, state: 'published', publishedAt: timestamp };
          await publishEmployerSubmission(dependencies.jobs, submission, timestamp);
          await store.putSubmission(submission, audit({ organizationId: orgId, action: 'submission.automatically_published', actorId: userId, subjectType: 'submission', subjectId: submission.id, createdAt: timestamp, key: `${key}:published` }));
        }
      }
      const result = await claim(store, orgId, 'submission.create', key, timestamp, { submission: submissionView(submission) });
      return json(201, result);
    }

    const closeMatch = suffix.match(/^submissions\/([^/]+)\/close$/u);
    if (request.method === 'POST' && closeMatch) {
      if (!canManageEmployer(membership.role, 'submissions')) return json(403, { message: 'Owner or editor access is required' });
      const submission = await store.getSubmission(orgId, decodeURIComponent(closeMatch[1]!));
      if (!submission) return json(404, { message: 'Submission not found' });
      const key = idempotencyKey(request); const closed = { ...submission, state: 'closed' as const, reason: 'Closed by employer', closedAt: timestamp, updatedAt: timestamp };
      const prior = await replay<{ submission: ReturnType<typeof submissionView> }>(store, orgId, 'submission.close', key);
      if (prior) return json(200, { ...prior, replayed: true });
      await store.putSubmission(closed, audit({ organizationId: orgId, action: 'submission.closed', actorId: userId, subjectType: 'submission', subjectId: closed.id, createdAt: timestamp, key }));
      const role = await dependencies.jobs.findByUrl(normalizeUrl(closed.applicationUrl));
      if (role?.sourceReferences.some((reference) => reference.provenance === 'employer-submitted' && reference.externalId === closed.id)) {
        const references = role.sourceReferences.map((reference) => reference.externalId === closed.id ? { ...reference, state: 'closed' as const } : reference);
        await dependencies.jobs.putInternship({ ...role, open: references.some((reference) => reference.state === 'open'), sourceReferences: references });
      }
      return json(200, await claim(store, orgId, 'submission.close', key, timestamp, { submission: submissionView(closed) }));
    }
    return json(404, { message: 'Not found' });
  } catch (error) {
    return json(error instanceof SyntaxError ? 400 : 400, { message: error instanceof Error ? error.message : 'Invalid request' });
  }
}
