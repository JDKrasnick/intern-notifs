import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InternNotifsStack } from '../infra/intern-notifs-stack.js';

function snapshotTemplate(template: Record<string, unknown>) {
  // NodejsFunction assets are content-addressed bundled artifacts. Their S3
  // keys vary with esbuild/CDK staging metadata, so snapshot the infrastructure
  // contract without treating an equivalent bundle hash as a stack change.
  return JSON.parse(JSON.stringify(template), (key, value) => key === 'S3Key' && typeof value === 'string' && value.endsWith('.zip') ? '<lambda-asset>.zip' : value);
}

describe('CDK stack', () => {
  it('has durable tables and main-branch OIDC trust', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Test', { githubRepository: 'owner/repo', emailAddress: 'me@example.com' }); const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
    template.resourceCountIs('AWS::Scheduler::Schedule', 3);
    template.hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: { Statement: [{ Condition: { StringEquals: { 'token.actions.githubusercontent.com:sub': 'repo:owner/repo:ref:refs/heads/main' } } }] } });
  });
  it('keeps an infrastructure snapshot', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Snapshot', { githubRepository: 'owner/repo', emailAddress: 'me@example.com' });
    expect(snapshotTemplate(Template.fromStack(stack).toJSON())).toMatchSnapshot();
  });
  it('uses immutable IDs for GitHub repositories that opt into immutable OIDC subjects', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Immutable', { githubRepository: 'owner/repo', githubOwnerId: '123', githubRepositoryId: '456', emailAddress: 'me@example.com' });
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: { Statement: [{ Condition: { StringEquals: { 'token.actions.githubusercontent.com:sub': 'repo:owner@123/repo@456:ref:refs/heads/main' } } }] } });
  });
  it('enables a DST-aware morning digest schedule', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Schedules', { githubRepository: 'owner/repo', emailAddress: 'me@example.com' });
    Template.fromStack(stack).hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'cron(0 9 * * ? *)', ScheduleExpressionTimezone: 'America/New_York', State: 'ENABLED', FlexibleTimeWindow: { Mode: 'OFF' } });
  });
});
