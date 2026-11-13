/**
 * Storage Service
 * - Authentication tokens are stored in expo-secure-store (Android Keystore / EncryptedSharedPreferences
 *   and iOS Keychain), with safe one-time migration from legacy AsyncStorage.
 * - Non-sensitive reader preferences and last-read ID remain in AsyncStorage.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { ReaderSettings } from '../types';

const KEYS = {
  READER_SETTINGS: '@paper_reader_settings',
  LEGACY_AUTH_TOKEN: '@paper_lncrawl_token',
  LAST_READ_NOVEL_ID: '@paper_last_read_novel_id',
};

// SecureStore keys allow only alphanumeric characters, '.', '-', and '_'
const SECURE_KEYS = {
  AUTH_TOKEN: 'paper_lncrawl_token',
};

const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'dark',
  fontSize: 18,
  lineSpacing: 1.8,
  fontFamily: 'serif',
};

let migrationPromise: Promise<void> | null = null;

async function canUseSecureStore(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function migrateLegacyAuthTokenOnce(): Promise<void> {
  if (!(await canUseSecureStore())) return;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      try {
        const legacyToken = await AsyncStorage.getItem(KEYS.LEGACY_AUTH_TOKEN);
        if (!legacyToken) return;

        const existingSecure = await SecureStore.getItemAsync(SECURE_KEYS.AUTH_TOKEN);
        if (!existingSecure) {
          await SecureStore.setItemAsync(SECURE_KEYS.AUTH_TOKEN, legacyToken);
        }
        await AsyncStorage.removeItem(KEYS.LEGACY_AUTH_TOKEN);
      } catch {
        // Allow retry if migration failed; never log tokens or credentials
        migrationPromise = null;
      }
    })();
  }
  await migrationPromise;
}

export async function getReaderSettings(): Promise<ReaderSettings> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.READER_SETTINGS);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    console.warn('Failed to load reader settings.');
  }
  return DEFAULT_SETTINGS;
}

export async function saveReaderSettings(settings: ReaderSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.READER_SETTINGS, JSON.stringify(settings));
  } catch {
    console.warn('Failed to save reader settings.');
  }
}

export async function getStoredAuthToken(): Promise<string | null> {
  try {
    if (await canUseSecureStore()) {
      await migrateLegacyAuthTokenOnce();
      return await SecureStore.getItemAsync(SECURE_KEYS.AUTH_TOKEN);
    }
    return await AsyncStorage.getItem(KEYS.LEGACY_AUTH_TOKEN);
  } catch {
    return null;
  }
}

export async function setStoredAuthToken(token: string | null): Promise<void> {
  try {
    if (await canUseSecureStore()) {
      if (migrationPromise) {
        await migrationPromise;
      }
      if (token) {
        await SecureStore.setItemAsync(SECURE_KEYS.AUTH_TOKEN, token);
        await AsyncStorage.removeItem(KEYS.LEGACY_AUTH_TOKEN);
      } else {
        await SecureStore.deleteItemAsync(SECURE_KEYS.AUTH_TOKEN);
        await AsyncStorage.removeItem(KEYS.LEGACY_AUTH_TOKEN);
      }
      return;
    }

    if (token) {
      await AsyncStorage.setItem(KEYS.LEGACY_AUTH_TOKEN, token);
    } else {
      await AsyncStorage.removeItem(KEYS.LEGACY_AUTH_TOKEN);
    }
  } catch {
    console.warn('Failed to update authentication session.');
  }
}

export async function deleteStoredAuthToken(): Promise<void> {
  await setStoredAuthToken(null);
}

export async function getLastReadNovelId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEYS.LAST_READ_NOVEL_ID);
  } catch {
    return null;
  }
}

export async function setLastReadNovelId(novelId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.LAST_READ_NOVEL_ID, novelId);
  } catch {
    console.warn('Failed to save last read novel ID.');
  }
}
