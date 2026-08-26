import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createApiHandler, type ApiDependencies, type DocumentStorage } from './api.js';
import { DynamoInternshipStore, DynamoReleaseStore, DynamoUserStore } from './store.js';

interface AwsApiDependencies extends ApiDependencies {
  documentsBucket?: string;
  userPoolId?: string;
  s3?: S3Client;
  cognito?: CognitoIdentityProviderClient;
}

export function createAwsApiHandler(dependencies: AwsApiDependencies) {
  const s3 = dependencies.s3 ?? new S3Client({});
  const documentStorage: DocumentStorage | undefined = dependencies.documentsBucket ? {
    createUploadUrl: (document) => getSignedUrl(s3, new PutObjectCommand({ Bucket: dependencies.documentsBucket, Key: document.objectKey, ContentType: document.contentType, ServerSideEncryption: 'aws:kms' }), { expiresIn: 300 }),
    createDownloadUrl: (document) => getSignedUrl(s3, new GetObjectCommand({ Bucket: dependencies.documentsBucket, Key: document.objectKey }), { expiresIn: 300 }),
    async deleteObject(objectKey) { await s3.send(new DeleteObjectCommand({ Bucket: dependencies.documentsBucket, Key: objectKey })); },
  } : undefined;
  const cognito = dependencies.cognito ?? new CognitoIdentityProviderClient({});
  return createApiHandler({
    ...dependencies,
    documentStorage,
    deleteIdentity: dependencies.userPoolId
      ? async (userId) => { await cognito.send(new AdminDeleteUserCommand({ UserPoolId: dependencies.userPoolId, Username: userId })); }
      : undefined,
  });
}

export const handler = createAwsApiHandler({
  jobs: new DynamoInternshipStore(process.env.INTERNSHIPS_TABLE ?? ''),
  users: new DynamoUserStore(process.env.USERS_TABLE ?? ''),
  releases: new DynamoReleaseStore(process.env.USERS_TABLE ?? ''),
  documentsBucket: process.env.DOCUMENTS_BUCKET,
  userPoolId: process.env.USER_POOL_ID,
});
