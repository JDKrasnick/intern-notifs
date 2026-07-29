import { describe, expect, it } from 'vitest';
import {
  createApplicationSession,
  transitionApplicationSession,
  type ApplicationFieldDraft,
} from '../src/application-automation.js';

const exactField: ApplicationFieldDraft = {
  key: 'first_name',
  label: 'First name',
  required: true,
  resolved: true,
  classification: 'standard',
  confidence: 'exact',
  valueRef: { source: 'profile', key: 'contact.name' },
  maskedPreview: 'J•••',
};

const unresolvedField: ApplicationFieldDraft = {
  key: 'sponsorship',
  label: 'Will you need sponsorship?',
  required: true,
  resolved: false,
  classification: 'sensitive',
  confidence: 'unknown',
};

function session(mode: 'headed' | 'headless' = 'headed') {
  return createApplicationSession({
    sessionId: 'session-1',
    userId: 'student-1',
    applicationId: 'application-1',
    jobId: 'job-1',
    mode,
    now: '2026-07-20T12:00:00.000Z',
  });
}

describe('application automation session', () => {
  it('prepares a headed draft but leaves final submission to the user', () => {
    const filling = transitionApplicationSession(session(), { type: 'start' }, '2026-07-20T12:01:00.000Z');
    const review = transitionApplicationSession(filling, { type: 'fill-completed', fields: [exactField] }, '2026-07-20T12:02:00.000Z');
    expect(review.status).toBe('awaiting-user-review');

    const ready = transitionApplicationSession(review, { type: 'review-approved', actor: 'user' }, '2026-07-20T12:03:00.000Z');
    expect(ready).toMatchObject({ status: 'ready-for-user-submit', reviewedAt: '2026-07-20T12:03:00.000Z' });

    const submitted = transitionApplicationSession(ready, { type: 'submission-confirmed', actor: 'user' }, '2026-07-20T12:04:00.000Z');
    expect(submitted).toMatchObject({ status: 'submitted', submittedAt: '2026-07-20T12:04:00.000Z' });
  });

  it('pauses a headless runner for a user-completed portal challenge and resumes it', () => {
    const filling = transitionApplicationSession(session('headless'), { type: 'start' }, '2026-07-20T12:01:00.000Z');
    const paused = transitionApplicationSession(filling, { type: 'verification-required', reason: 'captcha' }, '2026-07-20T12:02:00.000Z');
    expect(paused).toMatchObject({
      status: 'awaiting-user-verification',
      verification: { reason: 'captcha', resumeStatus: 'filling' },
    });

    const resumed = transitionApplicationSession(paused, { type: 'verification-completed', actor: 'user' }, '2026-07-20T12:03:00.000Z');
    expect(resumed).toMatchObject({ status: 'filling', verification: { completedAt: '2026-07-20T12:03:00.000Z' } });
  });

  it('requires missing answers before the review checkpoint', () => {
    const filling = transitionApplicationSession(session(), { type: 'start' }, '2026-07-20T12:01:00.000Z');
    const needsInput = transitionApplicationSession(filling, { type: 'fill-completed', fields: [unresolvedField] }, '2026-07-20T12:02:00.000Z');
    expect(needsInput.status).toBe('needs-input');

    const stillNeedsInput = transitionApplicationSession(needsInput, { type: 'answers-updated', fields: [unresolvedField] }, '2026-07-20T12:03:00.000Z');
    expect(stillNeedsInput.status).toBe('needs-input');

    const readyToReview = transitionApplicationSession(needsInput, {
      type: 'answers-updated',
      fields: [{ ...unresolvedField, resolved: true, confidence: 'exact', valueRef: { source: 'user', key: 'sponsorship' } }],
    }, '2026-07-20T12:04:00.000Z');
    expect(readyToReview.status).toBe('awaiting-user-review');
  });

  it('can interrupt the final page for verification without losing review approval', () => {
    const filling = transitionApplicationSession(session(), { type: 'start' }, '2026-07-20T12:01:00.000Z');
    const review = transitionApplicationSession(filling, { type: 'fill-completed', fields: [exactField] }, '2026-07-20T12:02:00.000Z');
    const ready = transitionApplicationSession(review, { type: 'review-approved', actor: 'user' }, '2026-07-20T12:03:00.000Z');
    const paused = transitionApplicationSession(ready, { type: 'verification-required', reason: 'mfa' }, '2026-07-20T12:04:00.000Z');
    const resumed = transitionApplicationSession(paused, { type: 'verification-completed', actor: 'user' }, '2026-07-20T12:05:00.000Z');
    expect(resumed).toMatchObject({ status: 'ready-for-user-submit', reviewedAt: '2026-07-20T12:03:00.000Z' });
  });

  it('invalidates approval when a field changes after review', () => {
    const filling = transitionApplicationSession(session(), { type: 'start' }, '2026-07-20T12:01:00.000Z');
    const review = transitionApplicationSession(filling, { type: 'fill-completed', fields: [exactField] }, '2026-07-20T12:02:00.000Z');
    const ready = transitionApplicationSession(review, { type: 'review-approved', actor: 'user' }, '2026-07-20T12:03:00.000Z');
    expect(ready.approvalDigest).toBe(ready.fieldPlanDigest);

    const changed = transitionApplicationSession(ready, {
      type: 'answers-updated',
      fields: [{ ...exactField, maskedPreview: 'A•••' }],
    }, '2026-07-20T12:04:00.000Z');
    expect(changed).toMatchObject({ status: 'awaiting-user-review', approvalDigest: undefined });
    expect(() => transitionApplicationSession(changed, { type: 'submission-confirmed', actor: 'user' }, '2026-07-20T12:05:00.000Z'))
      .toThrow('Cannot apply submission-confirmed');
  });

  it('rejects skipped checkpoints and any transition after a terminal state', () => {
    expect(() => transitionApplicationSession(session(), { type: 'submission-confirmed', actor: 'user' }, '2026-07-20T12:01:00.000Z'))
      .toThrow('Cannot apply submission-confirmed');

    const cancelled = transitionApplicationSession(session(), { type: 'cancel' }, '2026-07-20T12:01:00.000Z');
    expect(() => transitionApplicationSession(cancelled, { type: 'start' }, '2026-07-20T12:02:00.000Z'))
      .toThrow('Cannot apply start');
  });

  it('stores only a value reference and masked preview in the durable draft', () => {
    expect(exactField).not.toHaveProperty('value');
    expect(exactField.valueRef).toEqual({ source: 'profile', key: 'contact.name' });
    expect(exactField.maskedPreview).toBe('J•••');
  });
});
