import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { SOURCE_POLL_CADENCE } from '../src/source-poll-cadence.js';

export interface InternNotifsStackProps extends cdk.StackProps { githubRepository: string; githubOwnerId?: string; githubRepositoryId?: string; emailAddress: string; existingOidcProviderArn?: string; }
export class InternNotifsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InternNotifsStackProps) {
    super(scope, id, props);
    const internships = new dynamodb.Table(this, 'Internships', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: cdk.RemovalPolicy.RETAIN });
    internships.addGlobalSecondaryIndex({ indexName: 'urlIndex', partitionKey: { name: 'urlPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'fingerprintIndex', partitionKey: { name: 'fingerprintPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'pendingSmsIndex', partitionKey: { name: 'smsPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'pendingDigestIndex', partitionKey: { name: 'digestPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'openJobsIndex', partitionKey: { name: 'openPk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'openSk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'closedJobsIndex', partitionKey: { name: 'closedPk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'closedSk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    const applications = new dynamodb.Table(this, 'Applications', { partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: cdk.RemovalPolicy.RETAIN });
    applications.addGlobalSecondaryIndex({ indexName: 'jobIdIndex', partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    applications.addGlobalSecondaryIndex({ indexName: 'statusUpdatedAtIndex', partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    // Kept intact for existing deployments; all public-app records use this user-keyed table.
    const users = new dynamodb.Table(this, 'UserData', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, encryption: dynamodb.TableEncryption.AWS_MANAGED, timeToLiveAttribute: 'expiresAtEpoch', pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: cdk.RemovalPolicy.RETAIN });
    users.addGlobalSecondaryIndex({ indexName: 'activeDevicesIndex', partitionKey: { name: 'activePk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    users.addGlobalSecondaryIndex({ indexName: 'tokenIndex', partitionKey: { name: 'tokenPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    users.addGlobalSecondaryIndex({ indexName: 'pendingReceiptsIndex', partitionKey: { name: 'receiptPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    // This index is populated only while a short-lived assistance session is
    // active, allowing handoff and runner bearers to resolve a session without
    // exposing a user identifier in browser-facing credentials.
    users.addGlobalSecondaryIndex({ indexName: 'activeSessionsIndex', partitionKey: { name: 'activeSessionPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    const documents = new s3.Bucket(this, 'ApplicantDocuments', { encryption: s3.BucketEncryption.KMS_MANAGED, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, versioned: true, removalPolicy: cdk.RemovalPolicy.RETAIN, autoDeleteObjects: false, cors: [{ allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: ['*'], allowedHeaders: ['Content-Type'] }] });
    const userPool = new cognito.UserPool(this, 'Users', { selfSignUpEnabled: true, signInAliases: { email: true }, autoVerify: { email: true }, standardAttributes: { email: { required: true, mutable: true } }, passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false }, accountRecovery: cognito.AccountRecovery.EMAIL_ONLY, removalPolicy: cdk.RemovalPolicy.RETAIN });
    const userPoolClient = userPool.addClient('MobileClient', { authFlows: { userSrp: true, userPassword: true }, preventUserExistenceErrors: true });
    // The private monitoring site authenticates the operator directly with
    // USER_PASSWORD_AUTH. Keep this client in the durable application stack so
    // moving monitoring resources between provider stacks cannot delete it.
    const operationsUserPoolClient = userPool.addClient('OperationsClient', { authFlows: { userPassword: true }, preventUserExistenceErrors: true });
    const identity = new ses.EmailIdentity(this, 'NotifierIdentity', { identity: ses.Identity.email(props.emailAddress) });
    const provider = props.existingOidcProviderArn ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'ImportedGithubOidc', props.existingOidcProviderArn) : new iam.OpenIdConnectProvider(this, 'GithubOidc', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    const [owner, repository] = props.githubRepository.split('/');
    const subject = props.githubOwnerId && props.githubRepositoryId
      ? `repo:${owner}@${props.githubOwnerId}/${repository}@${props.githubRepositoryId}:ref:refs/heads/main`
      : `repo:${props.githubRepository}:ref:refs/heads/main`;
    const role = new iam.Role(this, 'GitHubActionsRole', { assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': subject } }) });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
      resources: [internships.tableArn, `${internships.tableArn}/index/*`]
    }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail'], resources: [identity.emailIdentityArn] }));
    const runtimeConfigParameterName = '/intern-notifs/runtime-config';
    const notifier = new lambdaNodejs.NodejsFunction(this, 'Notifier', {
      entry: 'src/lambda.ts', handler: 'handler', runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(4), memorySize: 512,
      environment: { INTERNSHIPS_TABLE: internships.tableName, USERS_TABLE: users.tableName, RUNTIME_CONFIG_PARAMETER_NAME: runtimeConfigParameterName },
      bundling: { externalModules: [] }
    });
    notifier.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:Scan'], resources: [internships.tableArn, `${internships.tableArn}/index/*`] }));
    notifier.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'], resources: [users.tableArn, `${users.tableArn}/index/*`] }));
    notifier.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail'], resources: [identity.emailIdentityArn] }));
    notifier.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${runtimeConfigParameterName}`] }));
    notifier.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [`arn:${this.partition}:kms:${this.region}:${this.account}:key/*`], conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } } }));
    const apiHandler = new lambdaNodejs.NodejsFunction(this, 'PublicApi', { entry: 'src/api.ts', handler: 'handler', runtime: lambda.Runtime.NODEJS_22_X, timeout: cdk.Duration.seconds(29), memorySize: 512, environment: { INTERNSHIPS_TABLE: internships.tableName, USERS_TABLE: users.tableName, DOCUMENTS_BUCKET: documents.bucketName, USER_POOL_ID: userPool.userPoolId }, bundling: { externalModules: [] } });
    apiHandler.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query'], resources: [internships.tableArn, `${internships.tableArn}/index/*`, users.tableArn, `${users.tableArn}/index/*`] }));
    documents.grantReadWrite(apiHandler); userPool.grant(apiHandler, 'cognito-idp:AdminDeleteUser');
    const api = new apigatewayv2.HttpApi(this, 'PublicHttpApi', { corsPreflight: { allowHeaders: ['Authorization', 'Content-Type'], allowMethods: [apigatewayv2.CorsHttpMethod.ANY], allowOrigins: ['*'], maxAge: cdk.Duration.days(1) } });
    const apiIntegration = new integrations.HttpLambdaIntegration('PublicApiIntegration', apiHandler);
    const jwtAuthorizer = new authorizers.HttpUserPoolAuthorizer('CognitoJwt', userPool, { userPoolClients: [userPoolClient] });
    api.addRoutes({ path: '/jobs', methods: [apigatewayv2.HttpMethod.GET], integration: apiIntegration });
    api.addRoutes({ path: '/jobs/{jobId}', methods: [apigatewayv2.HttpMethod.GET], integration: apiIntegration });
    api.addRoutes({ path: '/catalog', methods: [apigatewayv2.HttpMethod.GET], integration: apiIntegration });
    api.addRoutes({ path: '/catalog/groups/{groupId}', methods: [apigatewayv2.HttpMethod.GET], integration: apiIntegration });
    api.addRoutes({ path: '/coverage', methods: [apigatewayv2.HttpMethod.GET], integration: apiIntegration });
    api.addRoutes({ path: '/me', methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.POST, apigatewayv2.HttpMethod.DELETE], integration: apiIntegration, authorizer: jwtAuthorizer });
    api.addRoutes({ path: '/me/{proxy+}', methods: [apigatewayv2.HttpMethod.ANY], integration: apiIntegration, authorizer: jwtAuthorizer });
    // HTTP API has native stage throttling; WAF associations only support API Gateway REST APIs.
    const defaultStage = api.defaultStage?.node.defaultChild as apigatewayv2.CfnStage | undefined;
    if (defaultStage) defaultStage.defaultRouteSettings = { throttlingBurstLimit: 50, throttlingRateLimit: 25 };
    const deadLetterQueue = new sqs.Queue(this, 'SchedulerDeadLetterQueue', { retentionPeriod: cdk.Duration.days(14), encryption: sqs.QueueEncryption.SQS_MANAGED });
    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    notifier.grantInvoke(schedulerRole); deadLetterQueue.grantSendMessages(schedulerRole);
    const target = (command: 'poll' | 'digest' | 'audit-catalog-indexes', maximumRetryAttempts = 2): scheduler.CfnSchedule.TargetProperty => ({ arn: notifier.functionArn, roleArn: schedulerRole.roleArn, input: JSON.stringify({ command }), deadLetterConfig: { arn: deadLetterQueue.queueArn }, retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts } });
    // The next ten-minute poll is the safe retry boundary for this task;
    // Scheduler retries previously tripled the cost of repeated timeouts.
    new scheduler.CfnSchedule(this, 'PollSchedule', { flexibleTimeWindow: { mode: 'OFF' }, scheduleExpression: SOURCE_POLL_CADENCE.schedules.github, scheduleExpressionTimezone: 'UTC', state: 'ENABLED', target: target('poll', 0) });
    new scheduler.CfnSchedule(this, 'CatalogIndexAuditSchedule', { flexibleTimeWindow: { mode: 'OFF' }, scheduleExpression: 'cron(42 8 * * ? *)', scheduleExpressionTimezone: 'UTC', state: 'ENABLED', target: target('audit-catalog-indexes') });
    // The poll Lambda publishes these as embedded metrics, so a source that
    // stops succeeding surfaces without anyone reading logs. Greenhouse boards
    // are alarmed in their own stack alongside their queue.
    for (const provider of ['github', 'lever'] as const) {
      const suffix = provider === 'github' ? 'Github' : 'Lever';
      new cloudwatch.Alarm(this, `StaleSource${suffix}Alarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'InternNotifs/Ingestion',
          metricName: 'StaleSourceCount',
          dimensionsMap: { provider },
          statistic: 'Maximum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: provider === 'lever' ? 1 : 6,
        datapointsToAlarm: provider === 'lever' ? 1 : 6,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        alarmDescription: provider === 'lever'
          ? 'A lever source has gone 90 minutes without a trusted snapshot.'
          : 'A github source has gone 30 minutes without a trusted snapshot.',
      });
      new cloudwatch.Alarm(this, `SourceFetchFailure${suffix}Alarm`, {
        metric: new cloudwatch.Metric({
          namespace: 'InternNotifs/Ingestion',
          metricName: 'SourceFetchFailure',
          dimensionsMap: { provider },
          statistic: 'Sum',
          period: cdk.Duration.minutes(15),
        }),
        threshold: 3,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `A ${provider} source failed its bounded retries repeatedly within fifteen minutes.`,
      });
    }
    new cloudwatch.Alarm(this, 'PollErrorsAlarm', {
      metric: notifier.metricErrors({ period: cdk.Duration.minutes(15) }),
      threshold: 2,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The scheduled poll/digest Lambda returned repeated invocation errors.',
    });
    new cloudwatch.Alarm(this, 'PollDurationAlarm', {
      metric: notifier.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 180_000,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The scheduled poll/digest Lambda exceeded three minutes and is approaching its four-minute timeout.',
    });
    new cloudwatch.Alarm(this, 'PublicApiThrottlesAlarm', {
      metric: apiHandler.metricThrottles({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The public mobile API was throttled by the regional Lambda concurrency limit.',
    });
    new cloudwatch.Alarm(this, 'CatalogIndexMismatchAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'InternNotifs/Catalog', metricName: 'CatalogIndexMismatchCount',
        dimensionsMap: { Service: 'catalog' }, statistic: 'Maximum', period: cdk.Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Stored job state and the open/closed catalog index attributes diverge, or the daily audit did not report.',
    });

    new scheduler.CfnSchedule(this, 'MorningDigestSchedule', { flexibleTimeWindow: { mode: 'OFF' }, scheduleExpression: 'cron(0 9 * * ? *)', scheduleExpressionTimezone: 'America/New_York', state: 'ENABLED', target: target('digest') });
    new scheduler.CfnSchedule(this, 'EveningDigestSchedule', { flexibleTimeWindow: { mode: 'OFF' }, scheduleExpression: 'cron(0 17 * * ? *)', scheduleExpressionTimezone: 'America/New_York', state: 'ENABLED', target: target('digest') });
    new cdk.CfnOutput(this, 'InternshipsTableName', { value: internships.tableName });
    new cdk.CfnOutput(this, 'ApplicationsTableName', { value: applications.tableName });
    new cdk.CfnOutput(this, 'UserDataTableName', { value: users.tableName });
    new cdk.CfnOutput(this, 'DocumentsBucketName', { value: documents.bucketName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'OperationsUserPoolClientId', { value: operationsUserPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'PublicApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'RuntimeConfigParameterName', { value: runtimeConfigParameterName });
    new cdk.CfnOutput(this, 'NotifierFunctionName', { value: notifier.functionName });
  }
}
