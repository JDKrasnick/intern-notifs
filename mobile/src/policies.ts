export const currentTermsVersion = '2026-08-25';
export const currentPrivacyVersion = '2026-08-26';

export const policyUrls = {
  privacy: process.env.EXPO_PUBLIC_PRIVACY_URL,
  terms: process.env.EXPO_PUBLIC_TERMS_URL,
  retention: process.env.EXPO_PUBLIC_RETENTION_URL,
  sources: process.env.EXPO_PUBLIC_SOURCE_POLICY_URL,
  support: process.env.EXPO_PUBLIC_SUPPORT_URL,
} as const;
