import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });

function alertsAllowed(value: unknown) {
  const permission = value as { granted?: boolean; status?: string; ios?: { allowsAlert?: boolean | null } };
  return permission.granted === true || permission.status === 'granted' || permission.ios?.allowsAlert === true;
}

export async function registerForJobAlerts(idToken: string) {
  if (!Device.isDevice) return undefined;
  const existing = await Notifications.getPermissionsAsync();
  const permission = alertsAllowed(existing) ? existing : await Notifications.requestPermissionsAsync();
  if (!alertsAllowed(permission)) return undefined;
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('job-alerts', { name: 'Job alerts', importance: Notifications.AndroidImportance.HIGH });
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) throw new Error('Push notifications are not configured for this build yet.');
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api('/me/devices', idToken, { method: 'POST', body: JSON.stringify({ token, platform: Platform.OS }) });
  return token;
}
