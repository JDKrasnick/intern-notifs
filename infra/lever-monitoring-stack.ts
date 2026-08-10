import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { SOURCE_POLL_CADENCE } from '../src/source-poll-cadence.js';

export interface LeverMonitoringStackProps extends cdk.StackProps {
  internshipsTableName: string;
  usersTableName: string;
}

/** Independently deployable Lever polling plane over the retained catalog tables. */
export class LeverMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LeverMonitoringStackProps) {
    super(scope, id, props);
    const internships = dynamodb.Table.fromTableAttributes(this, 'Internships', {
      tableName: props.internshipsTableName,
      globalIndexes: ['urlIndex', 'fingerprintIndex', 'pendingSmsIndex', 'pendingDigestIndex', 'openJobsIndex', 'closedJobsIndex'],
    });
    const users = dynamodb.Table.fromTableAttributes(this, 'UserData', {
      tableName: props.usersTableName,
      globalIndexes: ['activeDevicesIndex', 'tokenIndex', 'pendingReceiptsIndex', 'activeSessionsIndex'],
    });
    const deadLetterQueue = new sqs.Queue(this, 'LeverDeadLetterQueue', {
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const queue = new sqs.Queue(this, 'LeverWorkQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.minutes(6),
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 4 },
    });
    new ssm.StringParameter(this, 'LeverOperationsQueueParameter', {
      parameterName: '/intern-notifs/operations/lever/queue-url',
      stringValue: queue.queueUrl,
    });
    new ssm.StringParameter(this, 'LeverOperationsDeadLetterQueueParameter', {
      parameterName: '/intern-notifs/operations/lever/dead-letter-queue-url',
      stringValue: deadLetterQueue.queueUrl,
    });
    const dispatcher = new lambdaNodejs.NodejsFunction(this, 'LeverDispatcher', {
      entry: 'src/lever-dispatch.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { LEVER_QUEUE_URL: queue.queueUrl, INTERNSHIPS_TABLE: internships.tableName },
      bundling: { externalModules: [] },
    });
    queue.grantSendMessages(dispatcher);
    internships.grantReadWriteData(dispatcher);
    const worker = new lambdaNodejs.NodejsFunction(this, 'LeverWorker', {
      entry: 'src/lever-worker.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: { INTERNSHIPS_TABLE: internships.tableName, USERS_TABLE: users.tableName },
      bundling: { externalModules: [] },
    });
    worker.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
      batchSize: 10,
      maxConcurrency: 4,
      reportBatchItemFailures: true,
    }));
    internships.grantReadWriteData(worker);
    users.grantReadWriteData(worker);

    const schedulerDeadLetterQueue = new sqs.Queue(this, 'LeverSchedulerDeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const schedulerRole = new iam.Role(this, 'LeverSchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    dispatcher.grantInvoke(schedulerRole);
    schedulerDeadLetterQueue.grantSendMessages(schedulerRole);
    new scheduler.CfnSchedule(this, 'LeverPollSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: SOURCE_POLL_CADENCE.schedules.lever,
      scheduleExpressionTimezone: 'UTC',
      state: 'ENABLED',
      target: {
        arn: dispatcher.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ command: 'lever-dispatch' }),
        deadLetterConfig: { arn: schedulerDeadLetterQueue.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
      },
    });

    new cloudwatch.Alarm(this, 'LeverQueueAgeAlarm', {
      metric: queue.metricApproximateAgeOfOldestMessage(),
      threshold: 600,
      evaluationPeriods: 2,
      alarmDescription: 'Lever polling work has remained queued for more than ten minutes.',
    });
    new cloudwatch.Alarm(this, 'LeverDeadLetterAlarm', {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'At least one Lever board exhausted its bounded retries.',
    });
    new cloudwatch.Alarm(this, 'LeverWorkerErrorsAlarm', {
      metric: worker.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'The Lever queue worker returned an invocation error.',
    });
    new cloudwatch.Alarm(this, 'LeverFreshnessAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'InternNotifs/Ingestion',
        metricName: 'SourceFreshnessMinutes',
        dimensionsMap: { provider: 'lever', region: 'global' },
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 90,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'At least one active Lever source has no trusted snapshot within ninety minutes.',
    });
    new cloudwatch.Dashboard(this, 'LeverMonitoringDashboard', {
      dashboardName: 'InternNotifs-Lever',
      widgets: [
        [new cloudwatch.GraphWidget({
          title: 'Trusted snapshot freshness',
          left: [new cloudwatch.Metric({
            namespace: 'InternNotifs/Ingestion',
            metricName: 'SourceFreshnessMinutes',
            dimensionsMap: { provider: 'lever', region: 'global' },
            statistic: 'Maximum',
            period: cdk.Duration.minutes(10),
          })],
          leftYAxis: { min: 0, label: 'minutes' },
        })],
        [new cloudwatch.GraphWidget({
          title: 'Lever queue and dead letters',
          left: [queue.metricApproximateNumberOfMessagesVisible(), queue.metricApproximateAgeOfOldestMessage()],
          right: [deadLetterQueue.metricApproximateNumberOfMessagesVisible()],
        })],
      ],
    });

    new cdk.CfnOutput(this, 'LeverQueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'LeverWorkerFunctionName', { value: worker.functionName });
    new cdk.CfnOutput(this, 'LeverDispatcherFunctionName', { value: dispatcher.functionName });
  }
}
