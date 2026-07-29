#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GreenhouseMonitoringStack } from './greenhouse-monitoring-stack.js';
import { InternNotifsStack } from './intern-notifs-stack.js';

const app = new cdk.App();
const deploymentTarget = app.node.tryGetContext('target') || 'main';
const region = app.node.tryGetContext('region') || 'us-east-1';
if (deploymentTarget === 'greenhouse') {
  const internshipsTableName = app.node.tryGetContext('internshipsTableName');
  const usersTableName = app.node.tryGetContext('usersTableName');
  if (!internshipsTableName || !usersTableName) throw new Error('Set -c internshipsTableName=... and -c usersTableName=... for the Greenhouse monitoring stack.');
  new GreenhouseMonitoringStack(app, 'InternNotifsGreenhouse', {
    env: { region },
    internshipsTableName,
    usersTableName,
  });
} else {
  const githubRepository = app.node.tryGetContext('githubRepository') || process.env.GITHUB_REPOSITORY;
  const emailAddress = app.node.tryGetContext('emailAddress') || process.env.SES_EMAIL;
  if (!githubRepository || !emailAddress) throw new Error('Set -c githubRepository=OWNER/REPO and -c emailAddress=you@example.com (or GITHUB_REPOSITORY and SES_EMAIL).');
  new InternNotifsStack(app, 'InternNotifs', { env: { region }, githubRepository, githubOwnerId: app.node.tryGetContext('githubOwnerId'), githubRepositoryId: app.node.tryGetContext('githubRepositoryId'), emailAddress, existingOidcProviderArn: app.node.tryGetContext('existingOidcProviderArn') });
}
