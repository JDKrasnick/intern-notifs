import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { SOURCE_POLL_CADENCE } from '../src/source-poll-cadence.js';
import { GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME } from '../src/grouped-notification-cohort.js';

export interface GreenhouseMonitoringStackProps extends cdk.StackProps {
  internshipsTableName: string;
  usersTableName: string;
  emailAddress: string;
}

/**
 * Independently deployable monitoring plane. Importing the retained catalog
 * tables keeps this stack from replacing or deleting resources in InternNotifs.
 */
export class GreenhouseMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GreenhouseMonitoringStackProps) {
    super(scope, id, props);
    const internships = dynamodb.Table.fromTableAttributes(this, 'Internships', {
      tableName: props.internshipsTableName,
      globalIndexes: ['urlIndex', 'fingerprintIndex', 'pendingSmsIndex', 'pendingDigestIndex', 'openJobsIndex', 'closedJobsIndex'],
    });
    const users = dynamodb.Table.fromTableAttributes(this, 'UserData', {
      tableName: props.usersTableName,
      globalIndexes: ['activeDevicesIndex', 'tokenIndex', 'pendingReceiptsIndex', 'activeSessionsIndex'],
    });
    const groupedNotificationCohort = ssm.StringParameter.fromStringParameterName(
      this, 'GroupedNotificationCohort', GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME,
    );
    const deadLetterQueue = new sqs.Queue(this, 'GreenhouseDeadLetterQueue', {
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const queue = new sqs.Queue(this, 'GreenhouseWorkQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.minutes(6),
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 4 },
    });
    new ssm.StringParameter(this, 'GreenhouseOperationsQueueParameter', {
      parameterName: '/intern-notifs/operations/greenhouse/queue-url',
      stringValue: queue.queueUrl,
    });
    new ssm.StringParameter(this, 'GreenhouseOperationsDeadLetterQueueParameter', {
      parameterName: '/intern-notifs/operations/greenhouse/dead-letter-queue-url',
      stringValue: deadLetterQueue.queueUrl,
    });
    const dispatcher = new lambdaNodejs.NodejsFunction(this, 'GreenhouseDispatcher', {
      entry: 'src/greenhouse-dispatch.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { GREENHOUSE_QUEUE_URL: queue.queueUrl, INTERNSHIPS_TABLE: internships.tableName },
      bundling: { externalModules: [] },
    });
    queue.grantSendMessages(dispatcher);
    internships.grantReadData(dispatcher);
    const worker = new lambdaNodejs.NodejsFunction(this, 'GreenhouseWorker', {
      entry: 'src/greenhouse-worker.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: { INTERNSHIPS_TABLE: internships.tableName, USERS_TABLE: users.tableName, GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME },
      bundling: { externalModules: [] },
    });
    worker.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
      batchSize: 10,
      maxConcurrency: SOURCE_POLL_CADENCE.workerMaxConcurrency,
      reportBatchItemFailures: true,
    }));
    internships.grantReadWriteData(worker);
    internships.grant(worker, 'dynamodb:TransactWriteItems');
    users.grantReadWriteData(worker);
    groupedNotificationCohort.grantRead(worker);

    const operationsSecret = new secretsmanager.Secret(this, 'GreenhouseOperationsSecret', {
      description: 'Server-to-server credential for the shared source operations dashboard.',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const operationsHandler = new lambdaNodejs.NodejsFunction(this, 'GreenhouseOperationsApi', {
      entry: 'src/greenhouse-operations-api.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: {
        INTERNSHIPS_TABLE: internships.tableName,
        GREENHOUSE_QUEUE_URL: queue.queueUrl,
        GREENHOUSE_DEAD_LETTER_QUEUE_URL: deadLetterQueue.queueUrl,
        OPERATIONS_PROVIDER_PARAMETER_PREFIX: '/intern-notifs/operations',
        OPERATIONS_SHARED_SECRET: operationsSecret.secretValue.unsafeUnwrap(),
      },
      bundling: { externalModules: [] },
    });
    operationsHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem'],
      resources: [internships.tableArn, `${internships.tableArn}/index/*`],
    }));
    operationsHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes', 'sqs:SendMessage'],
      resources: [
        queue.queueArn,
        deadLetterQueue.queueArn,
        cdk.Stack.of(this).formatArn({ service: 'sqs', resource: 'InternNotifsLever-*' }),
        cdk.Stack.of(this).formatArn({ service: 'sqs', resource: 'InternNotifsAshby-*' }),
      ],
    }));
    operationsHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParametersByPath'],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: 'intern-notifs/operations',
        }),
        cdk.Stack.of(this).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: 'intern-notifs/operations/*',
        }),
      ],
    }));
    operationsHandler.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudwatch:DescribeAlarms'], resources: ['*'] }));
    const operationsApi = new apigatewayv2.HttpApi(this, 'GreenhouseOperationsHttpApi');
    const operationsStage = operationsApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage | undefined;
    if (operationsStage) operationsStage.defaultRouteSettings = { throttlingBurstLimit: 10, throttlingRateLimit: 5 };
    const operationsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('GreenhouseOperationsIntegration', operationsHandler);
    operationsApi.addRoutes({ path: '/operations/sources', methods: [apigatewayv2.HttpMethod.GET], integration: operationsIntegration });
    operationsApi.addRoutes({ path: '/operations/sources/{sourceId}', methods: [apigatewayv2.HttpMethod.GET], integration: operationsIntegration });
    operationsApi.addRoutes({ path: '/operations/attribution/{jobId}', methods: [apigatewayv2.HttpMethod.GET], integration: operationsIntegration });
    operationsApi.addRoutes({ path: '/operations/sources/{sourceId}/actions', methods: [apigatewayv2.HttpMethod.POST], integration: operationsIntegration });
    operationsApi.addRoutes({ path: '/operations/checklist/{itemId}', methods: [apigatewayv2.HttpMethod.POST], integration: operationsIntegration });
    operationsApi.addRoutes({ path: '/operations/lever/candidates', methods: [apigatewayv2.HttpMethod.GET], integration: operationsIntegration });
    operationsApi.addRoutes({ path: '/operations/lever/candidates/{site}/verify', methods: [apigatewayv2.HttpMethod.POST], integration: operationsIntegration });
    operationsApi.addRoutes({ path: '/operations/lever/candidates/{site}/accept', methods: [apigatewayv2.HttpMethod.POST], integration: operationsIntegration });

    const schedulerDeadLetterQueue = new sqs.Queue(this, 'GreenhouseSchedulerDeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const schedulerRole = new iam.Role(this, 'GreenhouseSchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    const reminder = new lambdaNodejs.NodejsFunction(this, 'MonitoringReminder', {
      entry: 'src/monitoring-reminder.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        OPERATIONS_API_URL: operationsApi.apiEndpoint,
        OPERATIONS_API_KEY: operationsSecret.secretValue.unsafeUnwrap(),
        MONITORING_EMAIL_ADDRESS: props.emailAddress,
        MONITORING_DASHBOARD_URL: 'https://monitoring.jdkrasnick.com',
      },
      bundling: { externalModules: [] },
    });
    reminder.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'ses',
        resource: 'identity',
        resourceName: props.emailAddress,
      })],
    }));
    dispatcher.grantInvoke(schedulerRole);
    reminder.grantInvoke(schedulerRole);
    schedulerDeadLetterQueue.grantSendMessages(schedulerRole);
    new scheduler.CfnSchedule(this, 'GreenhousePollSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: SOURCE_POLL_CADENCE.schedules.greenhouse,
      scheduleExpressionTimezone: 'UTC',
      state: 'ENABLED',
      target: {
        arn: dispatcher.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ command: 'greenhouse-dispatch' }),
        deadLetterConfig: { arn: schedulerDeadLetterQueue.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
      },
    });
    new scheduler.CfnSchedule(this, 'MonitoringReminderSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 9 ? * MON *)',
      scheduleExpressionTimezone: 'America/New_York',
      state: 'ENABLED',
      target: {
        arn: reminder.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ command: 'monitoring-reminder' }),
        deadLetterConfig: { arn: schedulerDeadLetterQueue.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
      },
    });

    new cloudwatch.Alarm(this, 'GreenhouseQueueAgeAlarm', {
      metric: queue.metricApproximateAgeOfOldestMessage(),
      threshold: 600,
      evaluationPeriods: 2,
      alarmDescription: 'Greenhouse polling work has remained queued for more than ten minutes.',
    });
    new cloudwatch.Alarm(this, 'GreenhouseDeadLetterAlarm', {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'At least one Greenhouse board exhausted its bounded retries.',
    });
    new cloudwatch.Alarm(this, 'GreenhouseWorkerErrorsAlarm', {
      metric: worker.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'The Greenhouse queue worker returned an invocation error.',
    });

    new cdk.CfnOutput(this, 'GreenhouseQueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'GreenhouseWorkerFunctionName', { value: worker.functionName });
    new cdk.CfnOutput(this, 'GreenhouseDispatcherFunctionName', { value: dispatcher.functionName });
    new cdk.CfnOutput(this, 'GreenhouseOperationsApiUrl', { value: operationsApi.apiEndpoint });
    new cdk.CfnOutput(this, 'GreenhouseOperationsSecretArn', { value: operationsSecret.secretArn });
    new cdk.CfnOutput(this, 'MonitoringReminderFunctionName', { value: reminder.functionName });
  }
}
