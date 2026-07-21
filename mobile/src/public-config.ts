/**
 * Public production service identifiers. They are intentionally safe to ship
 * in the client; environment values can override them for approved builds.
 */
export const publicConfig = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "https://5dx7gpfa7d.execute-api.us-east-1.amazonaws.com",
  cognitoUserPoolId: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID ?? "us-east-1_mHbG28HiZ",
  cognitoClientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID ?? "4vuo4dqidns1fn30q3mhfabopb",
};
