import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GreenhouseMonitoringStack } from '../infra/greenhouse-monitoring-stack.js';
import { InternNotifsStack } from '../infra/intern-notifs-stack.js';
import { LeverMonitoringStack } from '../infra/lever-monitoring-stack.js';
import { AshbyMonitoringStack } from '../infra/ashby-monitoring-stack.js';
import { SOURCE_POLL_CADENCE } from '../src/source-poll-cadence.js';

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
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
    });
    template.resourceCountIs('AWS::Scheduler::Schedule', 4);
    template.resourceCountIs('AWS::SQS::Queue', 1);
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
    Template.fromStack(stack).hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: SOURCE_POLL_CADENCE.schedules.github,
      ScheduleExpressionTimezone: 'UTC',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 0 } },
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'cron(0 9 * * ? *)', ScheduleExpressionTimezone: 'America/New_York', State: 'ENABLED', FlexibleTimeWindow: { Mode: 'OFF' } });
    Template.fromStack(stack).hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(42 8 * * ? *)', ScheduleExpressionTimezone: 'UTC', State: 'ENABLED',
      Target: { Input: '{"command":"audit-catalog-indexes"}' },
    });
  });
  it('alarms when a polled source stops producing trusted snapshots', () => {
    const app = new cdk.App(); const stack = new InternNotifsStack(app, 'Alarms', { githubRepository: 'owner/repo', emailAddress: 'me@example.com' });
    const template = Template.fromStack(stack);
    for (const provider of ['github', 'lever']) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'InternNotifs/Ingestion',
        MetricName: 'StaleSourceCount',
        Dimensions: [{ Name: 'provider', Value: provider }],
        Threshold: 1,
        DatapointsToAlarm: provider === 'lever' ? 1 : 6,
        TreatMissingData: 'breaching',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'InternNotifs/Ingestion',
        MetricName: 'SourceFetchFailure',
        Dimensions: [{ Name: 'provider', Value: provider }],
        Threshold: 3,
      });
    }
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Duration',
      Statistic: 'Maximum',
      Threshold: 180000,
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'InternNotifs/Catalog', MetricName: 'CatalogIndexMismatchCount', Threshold: 1,
      TreatMissingData: 'breaching', Dimensions: [{ Name: 'Service', Value: 'catalog' }],
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 7);
  });
  it('queues Greenhouse boards every half hour with bounded worker concurrency', () => {
    const app = new cdk.App(); const stack = new GreenhouseMonitoringStack(app, 'Greenhouse', { internshipsTableName: 'internships', usersTableName: 'users', emailAddress: 'me@example.com' }); const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SQS::Queue', 3);
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: SOURCE_POLL_CADENCE.schedules.greenhouse, State: 'ENABLED' });
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 9 ? * MON *)',
      ScheduleExpressionTimezone: 'America/New_York',
      State: 'ENABLED',
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 4 },
    });
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 120 });
    expect(snapshotTemplate(template.toJSON())).toMatchSnapshot();
  });
  it('queues Lever boards every half hour with bounded worker concurrency', () => {
    const app = new cdk.App(); const stack = new LeverMonitoringStack(app, 'Lever', { internshipsTableName: 'internships', usersTableName: 'users' }); const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SQS::Queue', 3);
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: SOURCE_POLL_CADENCE.schedules.lever, State: 'ENABLED' });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 4 },
    });
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 120 });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'SourceFreshnessMinutes', Period: 3600, Threshold: 90, TreatMissingData: 'breaching',
    });
    expect(snapshotTemplate(template.toJSON())).toMatchSnapshot();
  });
  it('queues Ashby boards on a staggered half-hour schedule with bounded concurrency', () => {
    const app = new cdk.App(); const stack = new AshbyMonitoringStack(app, 'Ashby', { internshipsTableName: 'internships', usersTableName: 'users' }); const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SQS::Queue', 3);
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: SOURCE_POLL_CADENCE.schedules.ashby, State: 'ENABLED' });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 10, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 4 } });
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 120 });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'SourceFreshnessMinutes', Period: 3600, Threshold: 90, TreatMissingData: 'breaching',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/intern-notifs/operations/ashby/queue-url' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/intern-notifs/operations/ashby/dead-letter-queue-url' });
  });
});
