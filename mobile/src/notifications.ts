import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });

function alertsAllowed(value: unknown) {
  const permission = value as { granted?: boolean; status?: string; ios?: { allowsAlert?: boolean | null } };
  return permission.granted === true || permission.status === 'granted' || permission.ios?.allowsAlert === true;
}

const reminderStorageKey = (applicationId: string) => `internnotifs.follow-up.${applicationId}`;

async function existingAlertPermission() {
  return alertsAllowed(await Notifications.getPermissionsAsync());
}

export async function notifyApplicationProgress(
  applicationId: string,
  title: string,
  body: string,
) {
  if (!(await existingAlertPermission())) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data: { applicationId, destination: 'saved' } },
    trigger: null,
  });
}

export async function scheduleApplicationFollowUp(
  applicationId: string,
  roleName: string,
  followUpDays: number,
) {
  if (!(await existingAlertPermission())) return;
  const key = reminderStorageKey(applicationId);
  const previous = await AsyncStorage.getItem(key);
  if (previous) await Notifications.cancelScheduledNotificationAsync(previous);
  const trigger = new Date();
  trigger.setDate(trigger.getDate() + followUpDays);
  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Application follow-up',
      body: `Check in on ${roleName} and update your progress.`,
      data: { applicationId, destination: 'saved' },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: trigger },
  });
  await AsyncStorage.setItem(key, identifier);
}

export async function clearApplicationFollowUp(applicationId: string) {
  const key = reminderStorageKey(applicationId);
  const identifier = await AsyncStorage.getItem(key);
  if (identifier) await Notifications.cancelScheduledNotificationAsync(identifier);
  await AsyncStorage.removeItem(key);
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
