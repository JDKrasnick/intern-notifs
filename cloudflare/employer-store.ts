import { createHash } from 'node:crypto';
import type {
  EmployerAuditEvent,
  EmployerFieldProposal,
  EmployerInvitation,
  EmployerMembership,
  EmployerOrganization,
  EmployerPublishingPrivilege,
  EmployerReport,
  EmployerSourceConnection,
  EmployerSubmission,
  EmployerVerification,
  EmployerVerificationChallenge,
  ReviewedSourceRecord,
} from '../src/employer-types.js';
import type { D1Database, D1PreparedStatement } from './types.js';

type Row = Record<string, string | number | null>;

const optional = (value: string | null): string | undefined => value ?? undefined;
const flag = (value: number): boolean => value === 1;

function auditPseudonym(organizationId: string, kind: string, value: string): string {
  return `sha256:${createHash('sha256').update(`${organizationId}:${kind}:${value}`).digest('hex')}`;
}

function auditValues(event: EmployerAuditEvent): unknown[] {
  const details = event.details ? {
    evidenceDigest: auditPseudonym(event.organizationId, 'details', JSON.stringify(event.details)),
    fields: Object.keys(event.details).sort(),
  } : undefined;
  const subjectId = event.subjectId && event.subjectType === 'membership'
    ? auditPseudonym(event.organizationId, 'membership-subject', event.subjectId)
    : event.subjectId;
  return [event.id, event.organizationId, event.action, event.actorType,
    event.actorId ? auditPseudonym(event.organizationId, 'actor', event.actorId) : null,
    event.subjectType, subjectId ?? null, details ? JSON.stringify(details) : null,
    event.createdAt, event.idempotencyKey ? auditPseudonym(event.organizationId, 'idempotency', event.idempotencyKey) : null];
}

/** D1 persistence boundary for employer-scoped state. Authorization stays in the API layer. */
export class D1EmployerStore {
  constructor(private readonly db: D1Database) {}

  private auditStatement(event: EmployerAuditEvent): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO employer_audit_events
        (id, organization_id, action, actor_type, actor_id, subject_type, subject_id, details, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).bind(...auditValues(event));
  }

  async appendAuditEvent(event: EmployerAuditEvent): Promise<boolean> {
    return (await this.auditStatement(event).run()).meta.changes > 0;
  }

  async listAuditEvents(organizationId: string): Promise<EmployerAuditEvent[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_audit_events WHERE organization_id = ? ORDER BY created_at, id')
      .bind(organizationId).all<Row>();
    return rows.results.map((row) => ({
      id: row.id as string, organizationId: row.organization_id as string, action: row.action as string,
      actorType: row.actor_type as EmployerAuditEvent['actorType'], actorId: optional(row.actor_id as string | null),
      subjectType: row.subject_type as string, subjectId: optional(row.subject_id as string | null),
      details: row.details ? JSON.parse(row.details as string) as Record<string, unknown> : undefined,
      createdAt: row.created_at as string, idempotencyKey: optional(row.idempotency_key as string | null),
    }));
  }

  /** Returns false when this organization/operation/key was already handled. */
  async claimIdempotency(organizationId: string, operation: string, key: string, createdAt: string, result?: unknown): Promise<boolean> {
    const response = await this.db.prepare(`
      INSERT INTO employer_idempotency_keys (organization_id, operation, idempotency_key, result_json, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).bind(organizationId, operation, key, result === undefined ? null : JSON.stringify(result), createdAt).run();
    return response.meta.changes > 0;
  }

  async idempotencyResult<T>(organizationId: string, operation: string, key: string): Promise<T | undefined> {
    const row = await this.db.prepare('SELECT result_json FROM employer_idempotency_keys WHERE organization_id = ? AND operation = ? AND idempotency_key = ?')
      .bind(organizationId, operation, key).first<{ result_json: string | null }>();
    return row?.result_json ? JSON.parse(row.result_json) as T : undefined;
  }

  async deleteIdempotencyBefore(before: Date): Promise<number> {
    return (await this.db.prepare('DELETE FROM employer_idempotency_keys WHERE created_at < ?').bind(before.toISOString()).run()).meta.changes;
  }

  async putOrganization(value: EmployerOrganization, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_organizations (id, name, domain, state, created_at, updated_at, closed_at, retain_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, domain=excluded.domain, state=excluded.state,
        updated_at=excluded.updated_at, closed_at=excluded.closed_at, retain_until=excluded.retain_until
    `).bind(value.id, value.name, value.domain.toLowerCase().replace(/\.$/u, ''), value.state, value.createdAt, value.updatedAt,
      value.closedAt ?? null, value.retainUntil ?? null);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  /** Creates an organization identity exactly once; unlike putOrganization, conflicts never rewrite its name or domain. */
  async createOrganization(value: EmployerOrganization, event: EmployerAuditEvent): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`
        INSERT INTO employer_organizations (id, name, domain, state, created_at, updated_at, closed_at, retain_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).bind(value.id, value.name, value.domain.toLowerCase().replace(/\.$/u, ''), value.state, value.createdAt, value.updatedAt,
        value.closedAt ?? null, value.retainUntil ?? null),
      this.auditStatement(event),
    ]);
    return results[0]!.meta.changes > 0;
  }

  async getOrganization(id: string): Promise<EmployerOrganization | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_organizations WHERE id = ?').bind(id).first<Row>();
    return row ? { id: row.id as string, name: row.name as string, domain: row.domain as string,
      state: row.state as EmployerOrganization['state'], createdAt: row.created_at as string,
      updatedAt: row.updated_at as string, closedAt: optional(row.closed_at as string | null),
      retainUntil: optional(row.retain_until as string | null) } : undefined;
  }

  async getOrganizationByDomain(domain: string): Promise<EmployerOrganization | undefined> {
    const row = await this.db.prepare('SELECT id FROM employer_organizations WHERE domain = ? COLLATE NOCASE')
      .bind(domain.toLowerCase().replace(/\.$/u, '')).first<{ id: string }>();
    return row ? this.getOrganization(row.id) : undefined;
  }

  async listOrganizations(state?: EmployerOrganization['state']): Promise<EmployerOrganization[]> {
    const rows = await this.db.prepare(`SELECT id FROM employer_organizations${state ? ' WHERE state = ?' : ''} ORDER BY created_at`)
      .bind(...(state ? [state] : [])).all<{ id: string }>();
    const values = await Promise.all(rows.results.map((row) => this.getOrganization(row.id)));
    return values.filter((value): value is EmployerOrganization => value !== undefined);
  }

  async putMembership(value: EmployerMembership, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_memberships (organization_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(organization_id, user_id) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at
    `).bind(value.organizationId, value.userId, value.role, value.createdAt, value.updatedAt);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async getMembership(organizationId: string, userId: string): Promise<EmployerMembership | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_memberships WHERE organization_id = ? AND user_id = ?')
      .bind(organizationId, userId).first<Row>();
    return row ? { organizationId: row.organization_id as string, userId: row.user_id as string,
      role: row.role as EmployerMembership['role'], createdAt: row.created_at as string, updatedAt: row.updated_at as string } : undefined;
  }

  async listMemberships(organizationId: string): Promise<EmployerMembership[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_memberships WHERE organization_id = ? ORDER BY created_at')
      .bind(organizationId).all<Row>();
    return Promise.all(rows.results.map((row) => this.getMembership(row.organization_id as string, row.user_id as string)))
      .then((values) => values.filter((value): value is EmployerMembership => value !== undefined));
  }

  async listMemberProfiles(organizationId: string): Promise<Array<EmployerMembership & { email: string }>> {
    const rows = await this.db.prepare(`
      SELECT m.*, u.email FROM employer_memberships m
      JOIN auth_users u ON u.user_id = m.user_id
      WHERE m.organization_id = ? ORDER BY m.created_at
    `).bind(organizationId).all<Row>();
    return rows.results.map((row) => ({
      organizationId: row.organization_id as string, userId: row.user_id as string,
      role: row.role as EmployerMembership['role'], createdAt: row.created_at as string,
      updatedAt: row.updated_at as string, email: row.email as string,
    }));
  }

  async listOrganizationsForUser(userId: string): Promise<Array<{ organization: EmployerOrganization; membership: EmployerMembership }>> {
    const rows = await this.db.prepare('SELECT organization_id FROM employer_memberships WHERE user_id = ? ORDER BY created_at')
      .bind(userId).all<{ organization_id: string }>();
    const values = await Promise.all(rows.results.map(async (row) => {
      const [organization, membership] = await Promise.all([
        this.getOrganization(row.organization_id), this.getMembership(row.organization_id, userId),
      ]);
      return organization && membership ? { organization, membership } : undefined;
    }));
    return values.filter((value): value is { organization: EmployerOrganization; membership: EmployerMembership } => value !== undefined);
  }

  /** Removes account-linked access while retaining an organization-level deletion audit. */
  async removeUserAccess(userId: string, email?: string): Promise<number> {
    const [memberships, invitations] = await Promise.all([
      this.db.prepare('SELECT organization_id FROM employer_memberships WHERE user_id = ?').bind(userId).all<{ organization_id: string }>(),
      email ? this.db.prepare('SELECT id, organization_id FROM employer_invitations WHERE email = ? COLLATE NOCASE')
        .bind(email.toLowerCase()).all<{ id: string; organization_id: string }>() : Promise.resolve({ results: [] }),
    ]);
    const timestamp = new Date().toISOString();
    const statements = [
      ...memberships.results.map((row) => this.auditStatement({
        id: crypto.randomUUID(), organizationId: row.organization_id, action: 'membership.account_deleted', actorType: 'system',
        subjectType: 'membership', subjectId: userId, createdAt: timestamp,
      })),
      ...invitations.results.map((row) => this.auditStatement({
        id: crypto.randomUUID(), organizationId: row.organization_id, action: 'invitation.account_deleted', actorType: 'system',
        subjectType: 'invitation', subjectId: row.id, createdAt: timestamp,
      })),
      this.db.prepare('DELETE FROM employer_memberships WHERE user_id = ?').bind(userId),
    ];
    if (email) statements.push(this.db.prepare('DELETE FROM employer_invitations WHERE email = ? COLLATE NOCASE').bind(email.toLowerCase()));
    const results = await this.db.batch(statements);
    return results.slice(email ? -2 : -1).reduce((count, result) => count + result.meta.changes, 0);
  }

  /** Removes private account/workflow data after the one-year retention window while preserving provenance parents and immutable audits. */
  async redactRetainedOrganizations(now: Date): Promise<number> {
    const rows = await this.db.prepare("SELECT id FROM employer_organizations WHERE state = 'closed' AND retain_until IS NOT NULL AND retain_until <= ?")
      .bind(now.toISOString()).all<{ id: string }>();
    for (const { id } of rows.results) {
      const timestamp = now.toISOString();
      await this.db.batch([
        this.auditStatement({ id: crypto.randomUUID(), organizationId: id, action: 'organization.retention_redacted', actorType: 'system',
          subjectType: 'organization', subjectId: id, createdAt: timestamp }),
        this.db.prepare("UPDATE employer_verifications SET challenge_id = NULL, reviewed_by = CASE WHEN reviewed_by IS NULL THEN NULL ELSE 'redacted' END WHERE organization_id = ?").bind(id),
        this.db.prepare('DELETE FROM employer_verification_challenges WHERE organization_id = ?').bind(id),
        this.db.prepare('DELETE FROM employer_invitations WHERE organization_id = ?').bind(id),
        this.db.prepare('DELETE FROM employer_memberships WHERE organization_id = ?').bind(id),
        this.db.prepare('DELETE FROM employer_idempotency_keys WHERE organization_id = ?').bind(id),
        this.db.prepare("UPDATE employer_field_proposals SET created_by = 'redacted', decided_by = CASE WHEN decided_by IS NULL THEN NULL ELSE 'redacted' END WHERE organization_id = ?").bind(id),
        this.db.prepare("UPDATE employer_submissions SET created_by = 'redacted', private_review_note = NULL WHERE organization_id = ?").bind(id),
        this.db.prepare("UPDATE employer_reports SET reporter_key = 'redacted', details = NULL, resolved_by = CASE WHEN resolved_by IS NULL THEN NULL ELSE 'redacted' END WHERE organization_id = ?").bind(id),
        this.db.prepare("UPDATE employer_publishing_privileges SET enabled_by = CASE WHEN enabled_by IS NULL THEN NULL ELSE 'redacted' END WHERE organization_id = ?").bind(id),
        this.db.prepare("UPDATE employer_organizations SET name = 'Retained employer', domain = ?, retain_until = NULL, updated_at = ? WHERE id = ?")
          .bind(`retained-${id}.invalid`, timestamp, id),
      ]);
    }
    return rows.results.length;
  }

  async removeMembership(organizationId: string, userId: string, event: EmployerAuditEvent): Promise<boolean> {
    const [result] = await this.db.batch([
      this.db.prepare('DELETE FROM employer_memberships WHERE organization_id = ? AND user_id = ?').bind(organizationId, userId),
      this.auditStatement(event),
    ]);
    return result.meta.changes > 0;
  }

  async putInvitation(value: EmployerInvitation, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_invitations (id, organization_id, email, role, token_hash, expires_at, created_at, accepted_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET accepted_at=excluded.accepted_at, revoked_at=excluded.revoked_at
    `).bind(value.id, value.organizationId, value.email.toLowerCase(), value.role, value.tokenHash, value.expiresAt,
      value.createdAt, value.acceptedAt ?? null, value.revokedAt ?? null);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async invitationByTokenHash(tokenHash: string): Promise<EmployerInvitation | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_invitations WHERE token_hash = ?').bind(tokenHash).first<Row>();
    return row ? this.invitation(row) : undefined;
  }

  async getInvitation(organizationId: string, id: string): Promise<EmployerInvitation | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_invitations WHERE organization_id = ? AND id = ?')
      .bind(organizationId, id).first<Row>();
    return row ? this.invitation(row) : undefined;
  }

  async listInvitations(organizationId: string): Promise<EmployerInvitation[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_invitations WHERE organization_id = ? ORDER BY created_at')
      .bind(organizationId).all<Row>();
    return rows.results.map((row) => this.invitation(row));
  }

  private invitation(row: Row): EmployerInvitation {
    return { id: row.id as string, organizationId: row.organization_id as string, email: row.email as string,
      role: row.role as EmployerInvitation['role'], tokenHash: row.token_hash as string, expiresAt: row.expires_at as string,
      createdAt: row.created_at as string, acceptedAt: optional(row.accepted_at as string | null), revokedAt: optional(row.revoked_at as string | null) };
  }

  /** Invitations remain for a seven-day operational grace period after expiry. */
  async deleteExpiredInvitations(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    return (await this.db.prepare('DELETE FROM employer_invitations WHERE expires_at <= ?').bind(cutoff).run()).meta.changes;
  }

  async putChallenge(value: EmployerVerificationChallenge, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_verification_challenges (id, organization_id, method, token_hash, expires_at, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET completed_at=excluded.completed_at
    `).bind(value.id, value.organizationId, value.method, value.tokenHash, value.expiresAt, value.createdAt, value.completedAt ?? null);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async challengeByTokenHash(tokenHash: string): Promise<EmployerVerificationChallenge | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_verification_challenges WHERE token_hash = ?').bind(tokenHash).first<Row>();
    return row ? { id: row.id as string, organizationId: row.organization_id as string,
      method: row.method as EmployerVerificationChallenge['method'], tokenHash: row.token_hash as string,
      expiresAt: row.expires_at as string, createdAt: row.created_at as string,
      completedAt: optional(row.completed_at as string | null) } : undefined;
  }

  async getChallenge(organizationId: string, id: string): Promise<EmployerVerificationChallenge | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_verification_challenges WHERE organization_id = ? AND id = ?')
      .bind(organizationId, id).first<Row>();
    return row ? { id: row.id as string, organizationId: row.organization_id as string,
      method: row.method as EmployerVerificationChallenge['method'], tokenHash: row.token_hash as string,
      expiresAt: row.expires_at as string, createdAt: row.created_at as string,
      completedAt: optional(row.completed_at as string | null) } : undefined;
  }

  /** Challenge secrets are deleted as soon as expired; completed challenges cannot be replayed. */
  async consumeChallenge(id: string, completedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE employer_verification_challenges SET completed_at = ?
      WHERE id = ? AND completed_at IS NULL AND expires_at > ?
    `).bind(completedAt, id, completedAt).run();
    return result.meta.changes > 0;
  }

  async deleteExpiredChallenges(now: Date): Promise<number> {
    return (await this.db.prepare('DELETE FROM employer_verification_challenges WHERE expires_at <= ?').bind(now.toISOString()).run()).meta.changes;
  }

  async putVerification(value: EmployerVerification, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_verifications (organization_id, state, challenge_id, reason, reviewed_by, updated_at, verified_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id) DO UPDATE SET state=excluded.state,
        challenge_id=excluded.challenge_id, reason=excluded.reason, reviewed_by=excluded.reviewed_by,
        updated_at=excluded.updated_at, verified_at=excluded.verified_at, expires_at=excluded.expires_at
    `).bind(value.organizationId, value.state, value.challengeId ?? null, value.reason ?? null, value.reviewedBy ?? null,
      value.updatedAt, value.verifiedAt ?? null, value.expiresAt ?? null);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async getVerification(organizationId: string): Promise<EmployerVerification | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_verifications WHERE organization_id = ?').bind(organizationId).first<Row>();
    return row ? { organizationId: row.organization_id as string, state: row.state as EmployerVerification['state'],
      challengeId: optional(row.challenge_id as string | null), reason: optional(row.reason as string | null),
      reviewedBy: optional(row.reviewed_by as string | null), updatedAt: row.updated_at as string,
      verifiedAt: optional(row.verified_at as string | null), expiresAt: optional(row.expires_at as string | null) } : undefined;
  }

  async listVerificationsByState(state: EmployerVerification['state']): Promise<EmployerVerification[]> {
    const rows = await this.db.prepare('SELECT organization_id FROM employer_verifications WHERE state = ? ORDER BY updated_at')
      .bind(state).all<{ organization_id: string }>();
    const values = await Promise.all(rows.results.map((row) => this.getVerification(row.organization_id)));
    return values.filter((value): value is EmployerVerification => value !== undefined);
  }

  async expireVerifications(now: Date): Promise<number> {
    return (await this.db.prepare(`
      UPDATE employer_verifications SET state = 'expired', updated_at = ?
      WHERE state = 'verified' AND expires_at <= ?
    `).bind(now.toISOString(), now.toISOString()).run()).meta.changes;
  }

  async putSource(value: EmployerSourceConnection, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_source_connections (id, organization_id, provider, url, state, reason, source_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, url=excluded.url,
        state=excluded.state, reason=excluded.reason, source_id=excluded.source_id, updated_at=excluded.updated_at
    `).bind(value.id, value.organizationId, value.provider, value.url, value.state, value.reason ?? null,
      value.sourceId ?? null, value.createdAt, value.updatedAt);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async listSources(organizationId: string): Promise<EmployerSourceConnection[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_source_connections WHERE organization_id = ? ORDER BY created_at')
      .bind(organizationId).all<Row>();
    return rows.results.map((row) => ({ id: row.id as string, organizationId: row.organization_id as string,
      provider: row.provider as EmployerSourceConnection['provider'], url: row.url as string,
      state: row.state as EmployerSourceConnection['state'], reason: optional(row.reason as string | null),
      sourceId: optional(row.source_id as string | null), createdAt: row.created_at as string, updatedAt: row.updated_at as string }));
  }

  async getSource(organizationId: string, id: string): Promise<EmployerSourceConnection | undefined> {
    const values = await this.db.prepare('SELECT * FROM employer_source_connections WHERE organization_id = ? AND id = ?')
      .bind(organizationId, id).all<Row>();
    const row = values.results[0];
    return row ? this.source(row) : undefined;
  }

  async listSourcesByState(state: EmployerSourceConnection['state']): Promise<EmployerSourceConnection[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_source_connections WHERE state = ? ORDER BY updated_at')
      .bind(state).all<Row>();
    return rows.results.map((row) => this.source(row));
  }

  private source(row: Row): EmployerSourceConnection {
    return { id: row.id as string, organizationId: row.organization_id as string,
      provider: row.provider as EmployerSourceConnection['provider'], url: row.url as string,
      state: row.state as EmployerSourceConnection['state'], reason: optional(row.reason as string | null),
      sourceId: optional(row.source_id as string | null), createdAt: row.created_at as string, updatedAt: row.updated_at as string };
  }

  async putReviewedSource(value: ReviewedSourceRecord): Promise<void> {
    await this.db.prepare(`
      INSERT INTO reviewed_source_registry (source_id, provider, organization_id, config_json, evidence_json, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET provider=excluded.provider,
        organization_id=excluded.organization_id, config_json=excluded.config_json, evidence_json=excluded.evidence_json,
        state=excluded.state, updated_at=excluded.updated_at
    `).bind(value.sourceId, value.provider, value.organizationId ?? null, JSON.stringify(value.config),
      JSON.stringify(value.evidence), value.state, value.createdAt, value.updatedAt).run();
  }

  async listReviewedSources(provider?: ReviewedSourceRecord['provider'], states?: ReviewedSourceRecord['state'][]): Promise<ReviewedSourceRecord[]> {
    if (states?.length === 0) return [];
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (provider) { conditions.push('provider = ?'); values.push(provider); }
    if (states) { conditions.push(`state IN (${states.map(() => '?').join(', ')})`); values.push(...states); }
    const rows = await this.db.prepare(`SELECT * FROM reviewed_source_registry${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY source_id`)
      .bind(...values).all<Row>();
    return rows.results.map((row) => ({ sourceId: row.source_id as string,
      provider: row.provider as ReviewedSourceRecord['provider'], organizationId: optional(row.organization_id as string | null),
      config: JSON.parse(row.config_json as string) as Record<string, unknown>,
      evidence: JSON.parse(row.evidence_json as string) as Record<string, unknown>,
      state: row.state as ReviewedSourceRecord['state'], createdAt: row.created_at as string, updatedAt: row.updated_at as string }));
  }

  async putFieldProposal(value: EmployerFieldProposal, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_field_proposals (id, organization_id, job_id, field, original_value, proposed_value, evidence_at, state, reason, created_by, created_at, decided_at, decided_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,
        reason=excluded.reason, decided_at=excluded.decided_at, decided_by=excluded.decided_by
    `).bind(value.id, value.organizationId, value.jobId, value.field,
      value.originalValue === undefined ? null : JSON.stringify(value.originalValue), JSON.stringify(value.proposedValue),
      value.evidenceAt, value.state, value.reason ?? null, value.createdBy, value.createdAt,
      value.decidedAt ?? null, value.decidedBy ?? null);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async listFieldProposals(organizationId: string, state?: EmployerFieldProposal['state']): Promise<EmployerFieldProposal[]> {
    const query = `SELECT * FROM employer_field_proposals WHERE organization_id = ?${state ? ' AND state = ?' : ''} ORDER BY created_at`;
    const rows = await this.db.prepare(query).bind(organizationId, ...(state ? [state] : [])).all<Row>();
    return rows.results.map((row) => ({ id: row.id as string, organizationId: row.organization_id as string,
      jobId: row.job_id as string, field: row.field as string,
      originalValue: row.original_value === null ? undefined : JSON.parse(row.original_value as string),
      proposedValue: JSON.parse(row.proposed_value as string) as unknown, evidenceAt: row.evidence_at as string,
      state: row.state as EmployerFieldProposal['state'], reason: optional(row.reason as string | null),
      createdBy: row.created_by as string, createdAt: row.created_at as string,
      decidedAt: optional(row.decided_at as string | null), decidedBy: optional(row.decided_by as string | null) }));
  }

  async getFieldProposal(organizationId: string, id: string): Promise<EmployerFieldProposal | undefined> {
    const values = await this.db.prepare('SELECT * FROM employer_field_proposals WHERE organization_id = ? AND id = ?')
      .bind(organizationId, id).all<Row>();
    const row = values.results[0];
    return row ? this.fieldProposal(row) : undefined;
  }

  async listFieldProposalsByState(state: EmployerFieldProposal['state']): Promise<EmployerFieldProposal[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_field_proposals WHERE state = ? ORDER BY created_at')
      .bind(state).all<Row>();
    return rows.results.map((row) => this.fieldProposal(row));
  }

  private fieldProposal(row: Row): EmployerFieldProposal {
    return { id: row.id as string, organizationId: row.organization_id as string,
      jobId: row.job_id as string, field: row.field as string,
      originalValue: row.original_value === null ? undefined : JSON.parse(row.original_value as string),
      proposedValue: JSON.parse(row.proposed_value as string) as unknown, evidenceAt: row.evidence_at as string,
      state: row.state as EmployerFieldProposal['state'], reason: optional(row.reason as string | null),
      createdBy: row.created_by as string, createdAt: row.created_at as string,
      decidedAt: optional(row.decided_at as string | null), decidedBy: optional(row.decided_by as string | null) };
  }

  async putSubmission(value: EmployerSubmission, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_submissions (id, organization_id, title, company, program_type, discipline, location, work_mode, season, application_url, deadline, deadline_timezone, work_authorization, compensation, graduation_window, private_review_note, state, reason, created_by, created_at, updated_at, published_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, program_type=excluded.program_type, discipline=excluded.discipline,
        location=excluded.location, work_mode=excluded.work_mode, season=excluded.season, application_url=excluded.application_url,
        deadline=excluded.deadline, deadline_timezone=excluded.deadline_timezone, work_authorization=excluded.work_authorization,
        compensation=excluded.compensation, graduation_window=excluded.graduation_window, private_review_note=excluded.private_review_note,
        state=excluded.state, reason=excluded.reason, updated_at=excluded.updated_at, published_at=excluded.published_at, closed_at=excluded.closed_at
    `).bind(value.id, value.organizationId, value.title, value.company, value.programType, value.discipline,
      value.location, value.workMode, value.season, value.applicationUrl, value.deadline, value.deadlineTimezone ?? null,
      value.workAuthorization, value.compensation ?? null, value.graduationWindow ?? null, value.privateReviewNote ?? null,
      value.state, value.reason ?? null, value.createdBy, value.createdAt, value.updatedAt, value.publishedAt ?? null, value.closedAt ?? null);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async getSubmission(organizationId: string, id: string): Promise<EmployerSubmission | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_submissions WHERE organization_id = ? AND id = ?')
      .bind(organizationId, id).first<Row>();
    return row ? this.submission(row) : undefined;
  }

  async listSubmissions(organizationId: string, state?: EmployerSubmission['state']): Promise<EmployerSubmission[]> {
    const query = `SELECT * FROM employer_submissions WHERE organization_id = ?${state ? ' AND state = ?' : ''} ORDER BY created_at`;
    const rows = await this.db.prepare(query).bind(organizationId, ...(state ? [state] : [])).all<Row>();
    return rows.results.map((row) => this.submission(row));
  }

  async listSubmissionsByState(state: EmployerSubmission['state']): Promise<EmployerSubmission[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_submissions WHERE state = ? ORDER BY updated_at')
      .bind(state).all<Row>();
    return rows.results.map((row) => this.submission(row));
  }

  private submission(row: Row): EmployerSubmission {
    return { id: row.id as string, organizationId: row.organization_id as string, title: row.title as string,
      company: row.company as string, programType: row.program_type as string, discipline: row.discipline as string,
      location: row.location as string, workMode: row.work_mode as string, season: row.season as string,
      applicationUrl: row.application_url as string, deadline: row.deadline as EmployerSubmission['deadline'],
      deadlineTimezone: optional(row.deadline_timezone as string | null), workAuthorization: row.work_authorization as EmployerSubmission['workAuthorization'],
      compensation: optional(row.compensation as string | null), graduationWindow: optional(row.graduation_window as string | null),
      privateReviewNote: optional(row.private_review_note as string | null), state: row.state as EmployerSubmission['state'],
      reason: optional(row.reason as string | null), createdBy: row.created_by as string, createdAt: row.created_at as string,
      updatedAt: row.updated_at as string, publishedAt: optional(row.published_at as string | null), closedAt: optional(row.closed_at as string | null) };
  }

  async putReport(value: EmployerReport, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_reports (id, organization_id, submission_id, reporter_key, category, details, state, created_at, resolved_at, resolved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,
        resolved_at=excluded.resolved_at, resolved_by=excluded.resolved_by
    `).bind(value.id, value.organizationId, value.submissionId ?? null, value.reporterKey, value.category,
      value.details ?? null, value.state, value.createdAt, value.resolvedAt ?? null, value.resolvedBy ?? null);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async listReports(organizationId: string, state?: EmployerReport['state']): Promise<EmployerReport[]> {
    const query = `SELECT * FROM employer_reports WHERE organization_id = ?${state ? ' AND state = ?' : ''} ORDER BY created_at`;
    const rows = await this.db.prepare(query).bind(organizationId, ...(state ? [state] : [])).all<Row>();
    return rows.results.map((row) => ({ id: row.id as string, organizationId: row.organization_id as string,
      submissionId: optional(row.submission_id as string | null), reporterKey: row.reporter_key as string,
      category: row.category as EmployerReport['category'], details: optional(row.details as string | null),
      state: row.state as EmployerReport['state'], createdAt: row.created_at as string,
      resolvedAt: optional(row.resolved_at as string | null), resolvedBy: optional(row.resolved_by as string | null) }));
  }

  async listReportsByState(state: EmployerReport['state']): Promise<EmployerReport[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_reports WHERE state = ? ORDER BY created_at')
      .bind(state).all<Row>();
    return rows.results.map((row) => this.report(row));
  }

  private report(row: Row): EmployerReport {
    return { id: row.id as string, organizationId: row.organization_id as string,
      submissionId: optional(row.submission_id as string | null), reporterKey: row.reporter_key as string,
      category: row.category as EmployerReport['category'], details: optional(row.details as string | null),
      state: row.state as EmployerReport['state'], createdAt: row.created_at as string,
      resolvedAt: optional(row.resolved_at as string | null), resolvedBy: optional(row.resolved_by as string | null) };
  }

  async putPublishingPrivilege(value: EmployerPublishingPrivilege, event?: EmployerAuditEvent): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO employer_publishing_privileges (organization_id, automatic_publishing_enabled, enabled_at, enabled_by, suspended_at, suspension_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id) DO UPDATE SET automatic_publishing_enabled=excluded.automatic_publishing_enabled,
        enabled_at=excluded.enabled_at, enabled_by=excluded.enabled_by, suspended_at=excluded.suspended_at,
        suspension_reason=excluded.suspension_reason, updated_at=excluded.updated_at
    `).bind(value.organizationId, value.automaticPublishingEnabled ? 1 : 0, value.enabledAt ?? null,
      value.enabledBy ?? null, value.suspendedAt ?? null, value.suspensionReason ?? null, value.updatedAt);
    await (event ? this.db.batch([statement, this.auditStatement(event)]) : statement.run());
  }

  async getPublishingPrivilege(organizationId: string): Promise<EmployerPublishingPrivilege | undefined> {
    const row = await this.db.prepare('SELECT * FROM employer_publishing_privileges WHERE organization_id = ?')
      .bind(organizationId).first<Row>();
    return row ? { organizationId: row.organization_id as string, automaticPublishingEnabled: flag(row.automatic_publishing_enabled as number),
      enabledAt: optional(row.enabled_at as string | null), enabledBy: optional(row.enabled_by as string | null),
      suspendedAt: optional(row.suspended_at as string | null), suspensionReason: optional(row.suspension_reason as string | null),
      updatedAt: row.updated_at as string } : undefined;
  }
}
