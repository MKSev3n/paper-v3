/**
 * Paper Light Novel Reader - Core Data Types
 */

import { ReaderThemeMode } from '../theme/colors';

export interface Novel {
  id: string;
  title: string;
  author: string;
  synopsis: string;
  coverUrl: string;
  localCoverPath?: string | null;
  genres: string[];
  status: 'Ongoing' | 'Completed' | 'Hiatus';
  totalChapters: number;
  downloadedChaptersCount?: number;
  isDownloaded?: boolean;
  sourceDomain?: string;
  url?: string;
  coverFile?: string;
  coverAvailable?: boolean;
  updatedAt?: number;
}

export interface Chapter {
  id: string;
  novelId: string;
  serial: number;
  title: string;
  content?: string | null;
  isDownloaded?: boolean;
  isDone?: boolean;
  isAvailable?: boolean;
  url?: string;
  wordsCount?: number;
  releaseDate?: string;
  volumeId?: string | null;
}

export interface Volume {
  id: string;
  novelId: string;
  serial: number;
  title: string;
  chapterCount: number;
}

export interface ReadingProgress {
  novelId: string;
  chapterId: string;
  chapterTitle: string;
  chapterSerial: number;
  scrollOffset: number; // exact y-offset in pixels
  scrollPercentage: number; // 0 - 100
  updatedAt: number;
}

export interface ReaderSettings {
  theme: ReaderThemeMode;
  fontSize: number; // 14 to 28
  lineSpacing: number; // 1.4, 1.8, 2.2
  fontFamily: 'default' | 'serif' | 'monospace';
}

export type DownloadStatus = 'idle' | 'pending' | 'downloading' | 'completed' | 'failed' | 'paused';

export interface DownloadTask {
  novelId: string;
  totalChapters: number;
  completedChapters: number;
  currentChapterTitle: string;
  status: DownloadStatus;
  error?: string;
}

export interface StorageUsageStats {
  databaseSizeBytes: number;
  coversSizeBytes: number;
  totalSizeBytes: number;
  downloadedNovelsCount: number;
  downloadedChaptersCount: number;
}

export interface PaginatedResponse<T> {
  total: number;
  offset: number;
  limit: number;
  items: T[];
}

export interface LNCrawlUser {
  id: string;
  email: string;
  name?: string | null;
  role: 'user' | 'admin' | 'local';
  tier: number;
  is_active: boolean;
  is_verified: boolean;
}

export interface LNCrawlJob {
  id: string;
  user_id: string;
  type: number;
  status: number;
  is_done: boolean;
  is_running: number;
  is_pending: number;
  progress: number;
  done: number;
  failed: number;
  total: number;
  error?: string | null;
  job_title: string;
  extra?: Record<string, any>;
}

export interface LNCrawlSearchResult {
  url: string;
  title: string;
  author?: string | null;
  cover_url?: string | null;
  domain?: string | null;
  novel_id?: string | null;
  [key: string]: any;
}

export interface LNCrawlArtifact {
  id: string;
  novel_id: string;
  job_id?: string | null;
  user_id?: string | null;
  language?: string | null;
  volume?: number | null;
  format: string;
  file_name: string;
  file_size: number;
  output_file: string;
  is_available: boolean;
}
