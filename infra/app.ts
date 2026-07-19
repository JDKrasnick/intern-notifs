#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InternNotifsStack } from './intern-notifs-stack.js';

const app = new cdk.App();
const githubRepository = app.node.tryGetContext('githubRepository') || process.env.GITHUB_REPOSITORY;
const emailAddress = app.node.tryGetContext('emailAddress') || process.env.SES_EMAIL;
if (!githubRepository || !emailAddress) throw new Error('Set -c githubRepository=OWNER/REPO and -c emailAddress=you@example.com (or GITHUB_REPOSITORY and SES_EMAIL).');
new InternNotifsStack(app, 'InternNotifs', { env: { region: app.node.tryGetContext('region') || 'us-east-1' }, githubRepository, githubOwnerId: app.node.tryGetContext('githubOwnerId'), githubRepositoryId: app.node.tryGetContext('githubRepositoryId'), emailAddress, existingOidcProviderArn: app.node.tryGetContext('existingOidcProviderArn') });
