import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';

export interface InternNotifsStackProps extends cdk.StackProps { githubRepository: string; githubOwnerId?: string; githubRepositoryId?: string; emailAddress: string; existingOidcProviderArn?: string; }
export class InternNotifsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InternNotifsStackProps) {
    super(scope, id, props);
    const internships = new dynamodb.Table(this, 'Internships', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: cdk.RemovalPolicy.RETAIN });
    internships.addGlobalSecondaryIndex({ indexName: 'urlIndex', partitionKey: { name: 'urlPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'fingerprintIndex', partitionKey: { name: 'fingerprintPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'pendingSmsIndex', partitionKey: { name: 'smsPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    internships.addGlobalSecondaryIndex({ indexName: 'pendingDigestIndex', partitionKey: { name: 'digestPk', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    const applications = new dynamodb.Table(this, 'Applications', { partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: cdk.RemovalPolicy.RETAIN });
    applications.addGlobalSecondaryIndex({ indexName: 'jobIdIndex', partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    applications.addGlobalSecondaryIndex({ indexName: 'statusUpdatedAtIndex', partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
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
    // Direct phone-number publishing has no topic ARN to scope; the OIDC subject constrains this permission to main.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['sns:Publish'], resources: ['*'] }));
    new cdk.CfnOutput(this, 'InternshipsTableName', { value: internships.tableName });
    new cdk.CfnOutput(this, 'ApplicationsTableName', { value: applications.tableName });
    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
  }
}
