/**
 * File Storage Service using expo-file-system
 * Saves covers strictly in the app-private document directory (never public Downloads),
 * and calculates disk storage usage.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { StorageUsageStats } from '../types';
import { getDatabase, getAllNovels, getAllChaptersForWeb } from './database';

const COVERS_DIR = `${FileSystem.documentDirectory || ''}covers/`;
const EXPORTS_DIR = `${FileSystem.documentDirectory || ''}exports/`;

export async function initFileStorage(): Promise<void> {
  if (Platform.OS === 'web' || !FileSystem.documentDirectory) return;

  const coversInfo = await FileSystem.getInfoAsync(COVERS_DIR);
  if (!coversInfo.exists) {
    await FileSystem.makeDirectoryAsync(COVERS_DIR, { intermediates: true });
  }

  const exportsInfo = await FileSystem.getInfoAsync(EXPORTS_DIR);
  if (!exportsInfo.exists) {
    await FileSystem.makeDirectoryAsync(EXPORTS_DIR, { intermediates: true });
  }
}

/**
 * Downloads a cover image to the app-private documents directory
 */
export async function downloadCoverImage(novelId: string, remoteUrl: string): Promise<string | null> {
  if (!remoteUrl || !remoteUrl.startsWith('http')) {
    return remoteUrl || null;
  }

  if (Platform.OS === 'web' || !FileSystem.documentDirectory) {
    return remoteUrl;
  }

  await initFileStorage();
  const safeId = novelId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetPath = `${COVERS_DIR}${safeId}.jpg`;

  try {
    const downloadRes = await FileSystem.downloadAsync(remoteUrl, targetPath);
    if (downloadRes.status < 200 || downloadRes.status >= 300) {
      await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
      return remoteUrl;
    }
    return downloadRes.uri;
  } catch (err) {
    console.warn(`Failed to cache cover for novel ${novelId}:`, err);
    return remoteUrl;
  }
}

/**
 * Deletes a local cover image file
 */
export async function deleteLocalCover(localPath?: string | null): Promise<void> {
  if (Platform.OS === 'web') return;
  if (!localPath || !localPath.startsWith('file://')) return;

  try {
    const info = await FileSystem.getInfoAsync(localPath);
    if (info.exists) {
      await FileSystem.deleteAsync(localPath, { idempotent: true });
    }
  } catch (err) {
    console.warn('Error deleting local cover:', err);
  }
}

/**
 * Calculates app-private storage usage
 */
export async function calculateStorageUsage(): Promise<StorageUsageStats> {
  if (Platform.OS === 'web' || !FileSystem.documentDirectory) {
    const novels = await getAllNovels();
    const chapters = await getAllChaptersForWeb();
    const downloadedChapters = chapters.filter((c) => c.isDownloaded);
    const textBytes = downloadedChapters.reduce(
      (sum, c) => sum + (c.content ? c.content.length * 2 : 0),
      0
    );
    const novelIds = new Set(downloadedChapters.map((c) => c.novelId));
    return {
      databaseSizeBytes: textBytes,
      coversSizeBytes: 0,
      totalSizeBytes: textBytes,
      downloadedNovelsCount: novelIds.size || novels.filter((n) => n.isDownloaded).length,
      downloadedChaptersCount: downloadedChapters.length,
    };
  }

  await initFileStorage();
  let coversSizeBytes = 0;

  try {
    const files = await FileSystem.readDirectoryAsync(COVERS_DIR);
    for (const file of files) {
      const fileInfo = await FileSystem.getInfoAsync(`${COVERS_DIR}${file}`);
      if (fileInfo.exists && typeof fileInfo.size === 'number') {
        coversSizeBytes += fileInfo.size;
      }
    }
  } catch (e) {
    console.warn('Error calculating covers size:', e);
  }

  let databaseSizeBytes = 0;
  try {
    const dbPath = `${FileSystem.documentDirectory}SQLite/paper_library.db`;
    const dbInfo = await FileSystem.getInfoAsync(dbPath);
    if (dbInfo.exists && typeof dbInfo.size === 'number') {
      databaseSizeBytes = dbInfo.size;
    }
  } catch {
    // DB might be in default path
  }

  let downloadedNovelsCount = 0;
  let downloadedChaptersCount = 0;

  try {
    const db = await getDatabase();
    const countRes = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(DISTINCT novel_id) as count FROM chapters WHERE is_downloaded = 1`
    );
    downloadedNovelsCount = countRes?.count || 0;

    const chCountRes = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM chapters WHERE is_downloaded = 1`
    );
    downloadedChaptersCount = chCountRes?.count || 0;
  } catch (e) {
    console.warn('Error getting counts for storage stats:', e);
  }

  return {
    databaseSizeBytes,
    coversSizeBytes,
    totalSizeBytes: databaseSizeBytes + coversSizeBytes,
    downloadedNovelsCount,
    downloadedChaptersCount,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
