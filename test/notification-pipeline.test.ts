import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ses from 'aws-cdk-lib/aws-ses';
import { describe, expect, it } from 'vitest';
import { NotificationPipeline } from '../infra/notification-pipeline.js';

function pipelineStack(releaseWindow = cdk.Duration.seconds(8)) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'PipelineTest');
  const catalogTable = new dynamodb.Table(stack, 'Catalog', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
  });
  const usersTable = new dynamodb.Table(stack, 'Users', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  });
  const handler = (id: string) => new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ batchItemFailures: [] });'),
  });
  const identity = new ses.EmailIdentity(stack, 'EmailIdentity', {
    identity: ses.Identity.email('alerts@example.com'),
  });
  new NotificationPipeline(stack, 'Pipeline', {
    catalogTable,
    usersTable,
    emailIdentity: identity,
    releaseWindow,
    handlers: {
      streamPublisher: handler('StreamPublisher'),
      aggregationWorker: handler('AggregationWorker'),
      flushWorker: handler('FlushWorker'),
      pushWorker: handler('PushWorker'),
      emailWorker: handler('EmailWorker'),
      receiptWorker: handler('ReceiptWorker'),
    },
  });
  return stack;
}

describe('NotificationPipeline', () => {
  it('builds encrypted SNS/SQS fanout with 14-day dead-letter queues', () => {
    const template = Template.fromStack(pipelineStack());
    template.resourceCountIs('AWS::SNS::Topic', 2);
    template.resourceCountIs('AWS::SNS::Subscription', 3);
    template.resourceCountIs('AWS::SQS::Queue', 11);
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    template.hasResourceProperties('AWS::SQS::Queue', {
      DelaySeconds: 8,
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 4 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      RawMessageDelivery: true,
      FilterPolicy: { channel: ['push'] },
      Protocol: 'sqs',
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      RawMessageDelivery: true,
      FilterPolicy: { channel: ['email'] },
      Protocol: 'sqs',
    });
  });

  it('uses partial batches, bounded retries and queue-age alarms', () => {
    const template = Template.fromStack(pipelineStack());
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 6);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 10,
      MaximumRetryAttempts: 3,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 4 },
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateAgeOfOldestMessage',
      Period: 60,
      Threshold: 60,
      EvaluationPeriods: 2,
      TreatMissingData: 'notBreaching',
    });
  });

  it('rejects release windows outside the one-to-ten-second product boundary', () => {
    expect(() => pipelineStack(cdk.Duration.seconds(11))).toThrow(/between one and ten seconds/);
    expect(() => pipelineStack(cdk.Duration.seconds(0))).toThrow(/between one and ten seconds/);
  });
});
