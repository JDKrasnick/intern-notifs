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

export interface AshbyMonitoringStackProps extends cdk.StackProps {
  internshipsTableName: string;
  usersTableName: string;
}

/** Independently deployable Ashby polling plane over the retained catalog tables. */
export class AshbyMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AshbyMonitoringStackProps) {
    super(scope, id, props);
    const internships = dynamodb.Table.fromTableAttributes(this, 'Internships', {
      tableName: props.internshipsTableName,
      globalIndexes: ['urlIndex', 'fingerprintIndex', 'pendingSmsIndex', 'pendingDigestIndex', 'openJobsIndex', 'closedJobsIndex'],
    });
    const users = dynamodb.Table.fromTableAttributes(this, 'UserData', {
      tableName: props.usersTableName,
      globalIndexes: ['activeDevicesIndex', 'tokenIndex', 'pendingReceiptsIndex', 'activeSessionsIndex'],
    });
    const deadLetterQueue = new sqs.Queue(this, 'AshbyDeadLetterQueue', {
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const queue = new sqs.Queue(this, 'AshbyWorkQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.minutes(6),
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 4 },
    });
    new ssm.StringParameter(this, 'AshbyOperationsQueueParameter', {
      parameterName: '/intern-notifs/operations/ashby/queue-url',
      stringValue: queue.queueUrl,
    });
    new ssm.StringParameter(this, 'AshbyOperationsDeadLetterQueueParameter', {
      parameterName: '/intern-notifs/operations/ashby/dead-letter-queue-url',
      stringValue: deadLetterQueue.queueUrl,
    });
    const dispatcher = new lambdaNodejs.NodejsFunction(this, 'AshbyDispatcher', {
      entry: 'src/ashby-dispatch.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { ASHBY_QUEUE_URL: queue.queueUrl, INTERNSHIPS_TABLE: internships.tableName },
      bundling: { externalModules: [] },
    });
    queue.grantSendMessages(dispatcher);
    internships.grantReadWriteData(dispatcher);
    const worker = new lambdaNodejs.NodejsFunction(this, 'AshbyWorker', {
      entry: 'src/ashby-worker.ts',
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

    const schedulerDeadLetterQueue = new sqs.Queue(this, 'AshbySchedulerDeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const schedulerRole = new iam.Role(this, 'AshbySchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    dispatcher.grantInvoke(schedulerRole);
    schedulerDeadLetterQueue.grantSendMessages(schedulerRole);
    new scheduler.CfnSchedule(this, 'AshbyPollSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(4,14,24,34,44,54 * * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      state: 'ENABLED',
      target: {
        arn: dispatcher.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ command: 'ashby-dispatch' }),
        deadLetterConfig: { arn: schedulerDeadLetterQueue.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
      },
    });

    new cloudwatch.Alarm(this, 'AshbyQueueAgeAlarm', {
      metric: queue.metricApproximateAgeOfOldestMessage(),
      threshold: 600,
      evaluationPeriods: 2,
      alarmDescription: 'Ashby polling work has remained queued for more than ten minutes.',
    });
    new cloudwatch.Alarm(this, 'AshbyDeadLetterAlarm', {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'At least one Ashby board exhausted its bounded retries.',
    });
    new cloudwatch.Alarm(this, 'AshbyWorkerErrorsAlarm', {
      metric: worker.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'The Ashby queue worker returned an invocation error.',
    });
    new cloudwatch.Alarm(this, 'AshbyFreshnessAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'InternNotifs/Ingestion',
        metricName: 'SourceFreshnessMinutes',
        dimensionsMap: { provider: 'ashby', region: 'global' },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(10),
      }),
      threshold: 30,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'At least one active Ashby source has no trusted snapshot within thirty minutes.',
    });
    new cloudwatch.Dashboard(this, 'AshbyMonitoringDashboard', {
      dashboardName: 'InternNotifs-Ashby',
      widgets: [
        [new cloudwatch.GraphWidget({
          title: 'Trusted snapshot freshness',
          left: [new cloudwatch.Metric({
            namespace: 'InternNotifs/Ingestion',
            metricName: 'SourceFreshnessMinutes',
            dimensionsMap: { provider: 'ashby', region: 'global' },
            statistic: 'Maximum',
            period: cdk.Duration.minutes(10),
          })],
          leftYAxis: { min: 0, label: 'minutes' },
        })],
        [new cloudwatch.GraphWidget({
          title: 'Ashby queue and dead letters',
          left: [queue.metricApproximateNumberOfMessagesVisible(), queue.metricApproximateAgeOfOldestMessage()],
          right: [deadLetterQueue.metricApproximateNumberOfMessagesVisible()],
        })],
      ],
    });

    new cdk.CfnOutput(this, 'AshbyQueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'AshbyWorkerFunctionName', { value: worker.functionName });
    new cdk.CfnOutput(this, 'AshbyDispatcherFunctionName', { value: dispatcher.functionName });
  }
}
