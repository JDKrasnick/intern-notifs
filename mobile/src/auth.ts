import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';

const userPoolId = process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
const clientId = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID;
function pool() { if (!userPoolId || !clientId) throw new Error('Cognito is not configured'); return new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId }); }

export function signIn(email: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool() }).authenticateUser(new AuthenticationDetails({ Username: email.trim().toLowerCase(), Password: password }), { onSuccess: (session) => resolve(session.getIdToken().getJwtToken()), onFailure: reject, newPasswordRequired: () => reject(new Error('Set a new password in the Cognito console before signing in.')) }));
}
export function signUp(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => pool().signUp(email.trim().toLowerCase(), password, [], [], (error) => error ? reject(error) : resolve()));
}
export function confirmEmail(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool() }).confirmRegistration(code.trim(), true, (error) => error ? reject(error) : resolve()));
}
