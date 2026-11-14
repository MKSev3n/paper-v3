/**
 * Paper Light Novel Reader - Core Data Types
 */

import { ReaderThemeMode } from '../theme/colors';

export type SearchProviderId = 'readnovelfull' | 'novelfull' | 'novelbin' | 'lncrawl';

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
  provider?: string;
  path?: string;
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
  provider?: string;
  path?: string;
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
  failedChapters?: number;
  failedChapterIds?: string[];
  chapterErrors?: Record<string, string>;
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

export interface RawLNCrawlSearchResult {
  title: string;
  url: string;
  info?: string;
}

export interface ExternalSearchResult {
  title: string;
  displayTitle: string;
  isMtl: boolean;
  url: string;
  domain: string;
  info: string;
  normalizedTitle: string;
}

export interface LNCrawlSourceItem {
  version: number;
  md5: string;
  file_path: string;
  language: string;
  has_manga: boolean;
  can_login: boolean;
  can_search: boolean;
  has_mtl: boolean;
  request_rate_limit: number;
  url: string;
  domain: string;
  crawler_id: string;
  total_novels: number;
  is_disabled: boolean;
  disable_reason?: string | null;
}

export interface LNCrawlJob {
  id: string;
  user_id: string;
  type: number;
  domain?: string | null;
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
  extra?: {
    search_results?: RawLNCrawlSearchResult[];
    query?: string;
    url?: string;
    [key: string]: any;
  };
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
