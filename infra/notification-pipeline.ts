import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import type * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface NotificationPipelineProps {
  catalogTable: dynamodb.ITable;
  usersTable: dynamodb.ITable;
  emailIdentity: ses.IEmailIdentity;
  /** The employer aggregation window. SNS/SQS supports at most 900 seconds; product policy caps this at ten. */
  releaseWindow?: cdk.Duration;
  handlers: {
    streamPublisher: lambda.IFunction;
    aggregationWorker: lambda.IFunction;
    flushWorker: lambda.IFunction;
    pushWorker: lambda.IFunction;
    emailWorker: lambda.IFunction;
    receiptWorker: lambda.IFunction;
  };
}

/**
 * Durable transport for catalog releases and personalized notification intents.
 *
 * Business workers are deliberately selected through PIPELINE_COMMAND so the
 * transport remains reusable while sharing one bundled Lambda entry point.
 */
export class NotificationPipeline extends Construct {
  readonly candidateTopic: sns.Topic;
  readonly intentTopic: sns.Topic;
  readonly candidateQueue: sqs.Queue;
  readonly delayedFlushQueue: sqs.Queue;
  readonly pushQueue: sqs.Queue;
  readonly emailQueue: sqs.Queue;
  readonly receiptQueue: sqs.Queue;
  readonly streamPublisher: lambda.IFunction;
  readonly aggregationWorker: lambda.IFunction;
  readonly flushWorker: lambda.IFunction;
  readonly pushWorker: lambda.IFunction;
  readonly emailWorker: lambda.IFunction;
  readonly receiptWorker: lambda.IFunction;

  constructor(scope: Construct, id: string, props: NotificationPipelineProps) {
    super(scope, id);

    const releaseWindow = props.releaseWindow ?? cdk.Duration.seconds(8);
    if (releaseWindow.toSeconds() < 1 || releaseWindow.toSeconds() > 10) {
      throw new Error('Notification release window must be between one and ten seconds.');
    }

    const key = new kms.Key(this, 'Key', {
      enableKeyRotation: true,
      description: 'Encrypts notification pipeline topics.',
    });
    this.candidateTopic = new sns.Topic(this, 'CandidateTopic', {
      masterKey: key,
      displayName: 'Internship release candidates',
    });
    this.intentTopic = new sns.Topic(this, 'IntentTopic', {
      masterKey: key,
      displayName: 'Personalized notification intents',
    });

    const queue = (queueId: string, dlqId: string, options: Partial<sqs.QueueProps> = {}) => {
      const deadLetterQueue = new sqs.Queue(this, dlqId, {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: cdk.Duration.days(14),
      });
      const workQueue = new sqs.Queue(this, queueId, {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: cdk.Duration.days(1),
        visibilityTimeout: cdk.Duration.minutes(2),
        deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 4 },
        ...options,
      });
      new cloudwatch.Alarm(this, `${queueId}AgeAlarm`, {
        metric: workQueue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(1) }),
        threshold: 60,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${queueId} has not drained within the immediate notification latency budget.`,
      });
      return workQueue;
    };

    this.candidateQueue = queue('CandidateQueue', 'CandidateDeadLetterQueue');
    this.delayedFlushQueue = queue('DelayedFlushQueue', 'DelayedFlushDeadLetterQueue', {
      deliveryDelay: releaseWindow,
    });
    this.pushQueue = queue('PushQueue', 'PushDeadLetterQueue');
    this.emailQueue = queue('EmailQueue', 'EmailDeadLetterQueue');
    this.receiptQueue = queue('ReceiptQueue', 'ReceiptDeadLetterQueue');

    this.candidateTopic.addSubscription(new subscriptions.SqsSubscription(this.candidateQueue, {
      rawMessageDelivery: true,
    }));
    this.intentTopic.addSubscription(new subscriptions.SqsSubscription(this.pushQueue, {
      rawMessageDelivery: true,
      filterPolicy: { channel: sns.SubscriptionFilter.stringFilter({ allowlist: ['push'] }) },
    }));
    this.intentTopic.addSubscription(new subscriptions.SqsSubscription(this.emailQueue, {
      rawMessageDelivery: true,
      filterPolicy: { channel: sns.SubscriptionFilter.stringFilter({ allowlist: ['email'] }) },
    }));

    this.streamPublisher = props.handlers.streamPublisher;
    this.aggregationWorker = props.handlers.aggregationWorker;
    this.flushWorker = props.handlers.flushWorker;
    this.pushWorker = props.handlers.pushWorker;
    this.emailWorker = props.handlers.emailWorker;
    this.receiptWorker = props.handlers.receiptWorker;

    const streamFailureQueue = new sqs.Queue(this, 'StreamFailureQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.streamPublisher.addEventSource(new lambdaEventSources.DynamoEventSource(props.catalogTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      bisectBatchOnError: false,
      retryAttempts: 3,
      reportBatchItemFailures: true,
      onFailure: new lambdaEventSources.SqsDlq(streamFailureQueue),
    }));
    this.streamPublisher.addEventSource(new lambdaEventSources.DynamoEventSource(props.usersTable, {
      // Start at the beginning of the newly enabled stream so an outbox written
      // while this mapping is being deployed cannot be stranded.
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      bisectBatchOnError: false,
      retryAttempts: 3,
      reportBatchItemFailures: true,
      onFailure: new lambdaEventSources.SqsDlq(streamFailureQueue),
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.isEqual('INSERT'),
        dynamodb: { Keys: { sk: { S: lambda.FilterRule.beginsWith('PIPELINE_RECEIPT_OUTBOX#') } } },
      })],
    }));

    const consume = (handler: lambda.IFunction, source: sqs.IQueue) => handler.addEventSource(new lambdaEventSources.SqsEventSource(source, {
      batchSize: 10,
      maxConcurrency: 4,
      reportBatchItemFailures: true,
    }));
    consume(this.aggregationWorker, this.candidateQueue);
    consume(this.flushWorker, this.delayedFlushQueue);
    consume(this.pushWorker, this.pushQueue);
    consume(this.emailWorker, this.emailQueue);
    consume(this.receiptWorker, this.receiptQueue);

    props.catalogTable.grantStreamRead(this.streamPublisher);
    props.usersTable.grantStreamRead(this.streamPublisher);
    this.candidateTopic.grantPublish(this.streamPublisher);
    props.catalogTable.grantReadWriteData(this.aggregationWorker);
    props.catalogTable.grant(this.aggregationWorker, 'dynamodb:TransactWriteItems');
    this.delayedFlushQueue.grantSendMessages(this.aggregationWorker);
    props.catalogTable.grantReadWriteData(this.flushWorker);
    props.usersTable.grantReadWriteData(this.flushWorker);
    this.intentTopic.grantPublish(this.flushWorker);
    props.usersTable.grantReadWriteData(this.pushWorker);
    props.usersTable.grant(this.pushWorker, 'dynamodb:TransactWriteItems');
    props.usersTable.grantReadWriteData(this.emailWorker);
    props.usersTable.grant(this.emailWorker, 'dynamodb:TransactWriteItems');
    props.usersTable.grantReadWriteData(this.receiptWorker);
    props.emailIdentity.grantSendEmail(this.emailWorker);
  }
}
