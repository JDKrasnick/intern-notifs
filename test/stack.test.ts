import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InternNotifsStack } from '../infra/intern-notifs-stack.js';

describe('CDK stack', () => {
  it('has durable tables and main-branch OIDC trust', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Test', { githubRepository: 'owner/repo', emailAddress: 'me@example.com' }); const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::DynamoDB::Table', 2);
    template.hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: { Statement: [{ Condition: { StringEquals: { 'token.actions.githubusercontent.com:sub': 'repo:owner/repo:ref:refs/heads/main' } } }] } });
  });
  it('keeps an infrastructure snapshot', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Snapshot', { githubRepository: 'owner/repo', emailAddress: 'me@example.com' });
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
  });
  it('uses immutable IDs for GitHub repositories that opt into immutable OIDC subjects', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Immutable', { githubRepository: 'owner/repo', githubOwnerId: '123', githubRepositoryId: '456', emailAddress: 'me@example.com' });
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: { Statement: [{ Condition: { StringEquals: { 'token.actions.githubusercontent.com:sub': 'repo:owner@123/repo@456:ref:refs/heads/main' } } }] } });
  });
});
