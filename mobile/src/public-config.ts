/**
 * Public production service identifiers. They are intentionally safe to ship
 * in the client; environment values can override them for approved builds.
 */
export const publicConfig = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "https://intern-notifs.jdkrasnick.workers.dev",
};
