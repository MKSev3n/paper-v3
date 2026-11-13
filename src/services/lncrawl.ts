/**
 * LNCrawl Service Layer for Paper Light Novel Reader
 * Aligned with the live LNCrawl FastAPI OpenAPI 3.1.0 specification.
 * Uses LNCRAWL_API_BASE from src/config.ts
 */

import { LNCRAWL_API_BASE, APP_CONFIG } from '../config';
import {
  Novel,
  Chapter,
  PaginatedResponse,
  LNCrawlUser,
  LNCrawlJob,
  LNCrawlArtifact,
} from '../types';
import {
  getStoredAuthToken,
  setStoredAuthToken,
  deleteStoredAuthToken,
} from './storage';

const BASE_URL = LNCRAWL_API_BASE.replace(/\/+$/, '');

export class LNCrawlError extends Error {
  status: number;
  constructor(message: string, status: number = 0) {
    super(message);
    this.name = 'LNCrawlError';
    this.status = status;
  }
}

async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = APP_CONFIG.defaultTimeoutMs
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const token = await getStoredAuthToken();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle sliding token refresh header exposed by LNCrawl server
    const refreshedToken = res.headers.get('X-Refresh-Token') || res.headers.get('x-refresh-token');
    if (refreshedToken && refreshedToken !== token) {
      await setStoredAuthToken(refreshedToken);
    }

    if (!res.ok) {
      let errMessage = `LNCrawl request failed with status ${res.status}`;
      try {
        const errorJson = await res.json();
        if (typeof errorJson?.error === 'string' && errorJson.error) {
          errMessage = errorJson.error;
        } else if (typeof errorJson?.detail === 'string' && errorJson.detail) {
          errMessage = errorJson.detail;
        } else if (Array.isArray(errorJson?.detail) && errorJson.detail[0]?.msg) {
          errMessage = errorJson.detail.map((d: any) => d.msg).join('; ');
        }
      } catch {
        // Fallback to status message
      }

      if (res.status === 401) {
        errMessage = endpoint.startsWith('/api/auth/login')
          ? 'Invalid username/email or password (401 Unauthorized).'
          : 'Authentication required (401 Unauthorized). Please sign in to your LNCrawl account.';
      }
      throw new LNCrawlError(errMessage, res.status);
    }

    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      throw new LNCrawlError(
        'Request timed out. The server may be warming up from cold start.',
        408
      );
    }
    if (err instanceof LNCrawlError) {
      throw err;
    }
    throw new LNCrawlError(
      err?.message || 'Network error while contacting LNCrawl server.',
      0
    );
  }
}

function parseAuthors(raw: any): string {
  if (typeof raw?.authors === 'string' && raw.authors.trim()) {
    return raw.authors.trim();
  }
  if (Array.isArray(raw?.authors) && raw.authors.length > 0) {
    return raw.authors.join(', ');
  }
  if (typeof raw?.author === 'string' && raw.author.trim()) {
    return raw.author.trim();
  }
  return 'Unknown Author';
}

function resolveCoverUrl(raw: any, token: string | null): string {
  if (raw?.cover_available && raw?.cover_file && token) {
    const cleanFile = String(raw.cover_file).replace(/^\/+/, '');
    return `${BASE_URL}/static/${cleanFile}?token=${encodeURIComponent(token)}`;
  }
  return raw?.cover_url || raw?.thumbnail_url || raw?.image_url || '';
}

function mapNovel(raw: any, token: string | null): Novel {
  const extraStatus = raw?.extra?.status;
  const statusStr = String(raw?.status || extraStatus || '').toLowerCase();
  let status: Novel['status'] = 'Ongoing';
  if (statusStr.includes('complete')) status = 'Completed';
  else if (statusStr.includes('hiatus')) status = 'Hiatus';

  return {
    id: String(raw.id),
    title: raw.title || raw.name || 'Untitled Novel',
    author: parseAuthors(raw),
    synopsis: raw.synopsis || raw.description || 'No synopsis provided.',
    coverUrl: resolveCoverUrl(raw, token),
    genres: Array.isArray(raw.tags)
      ? raw.tags
      : Array.isArray(raw.genres)
      ? raw.genres
      : ['Light Novel'],
    status,
    totalChapters: raw.chapter_count ?? raw.total_chapters ?? 0,
    sourceDomain: raw.domain || raw.source || 'LNCrawl',
    url: raw.url,
    coverFile: raw.cover_file,
    coverAvailable: Boolean(raw.cover_available),
    isDownloaded: false,
  };
}

function mapChapter(ch: any, novelId: string, fallbackIndex: number): Chapter {
  return {
    id: String(ch.id),
    novelId: ch.novel_id || novelId,
    serial: ch.serial ?? fallbackIndex + 1,
    title: ch.title || `Chapter ${ch.serial ?? fallbackIndex + 1}`,
    isDownloaded: false,
    isDone: Boolean(ch.is_done),
    isAvailable: Boolean(ch.is_available),
    url: ch.url,
    wordsCount: ch.words_count ?? ch.word_count,
    releaseDate: ch.release_date || '',
    volumeId: ch.volume_id ?? null,
  };
}

export const LNCrawlService = {
  /**
   * Sign in to LNCrawl server (POST /api/auth/login)
   * Stores the Bearer token in SecureStore (or web fallback).
   */
  async login(
    email: string,
    password: string
  ): Promise<{ token: string; user: LNCrawlUser }> {
    const res = await apiFetch<{ token: string; user: LNCrawlUser }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      }
    );
    if (res?.token) {
      await setStoredAuthToken(res.token);
    }
    return res;
  },

  /**
   * Verify current session and get user profile (GET /api/auth/me)
   */
  async getMe(): Promise<LNCrawlUser> {
    return apiFetch<LNCrawlUser>('/api/auth/me');
  },

  /**
   * Save a manually pasted Bearer token and verify it
   */
  async setTokenAndVerify(token: string): Promise<LNCrawlUser> {
    await setStoredAuthToken(token.trim());
    try {
      return await this.getMe();
    } catch (err) {
      await deleteStoredAuthToken();
      throw err;
    }
  },

  async logout(): Promise<void> {
    await deleteStoredAuthToken();
  },

  /**
   * Search novels in the LNCrawl server database (GET /api/novels)
   * Returns Paginated[Novel] -> { total, offset, limit, items }
   */
  async searchNovels(
    query: string,
    offset: number = 0,
    limit: number = 24
  ): Promise<Novel[]> {
    const params = new URLSearchParams();
    if (query.trim()) {
      params.append('search', query.trim());
    }
    params.append('offset', String(offset));
    params.append('limit', String(limit));

    const data = await apiFetch<PaginatedResponse<any> | any[]>(
      `/api/novels?${params.toString()}`
    );

    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const token = await getStoredAuthToken();

    return items.map((item) => mapNovel(item, token));
  },

  /**
   * Get single novel details (GET /api/novel/{novel_id})
   */
  async getNovelDetails(novelId: string, language?: string): Promise<Novel> {
    const qs = language ? `?language=${encodeURIComponent(language)}` : '';
    const raw = await apiFetch<any>(`/api/novel/${encodeURIComponent(novelId)}${qs}`);
    const token = await getStoredAuthToken();
    return mapNovel(raw, token);
  },

  /**
   * List ALL chapters for a novel (GET /api/novel/{novel_id}/chapters)
   * Paginates through Paginated[Chapter] until all chapters are retrieved.
   */
  async getChapters(novelId: string, language?: string): Promise<Chapter[]> {
    const pageSize = 100;
    let offset = 0;
    let total = Infinity;
    const allChapters: Chapter[] = [];

    while (offset < total) {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(pageSize),
      });
      if (language) params.append('language', language);

      const data = await apiFetch<PaginatedResponse<any> | any[]>(
        `/api/novel/${encodeURIComponent(novelId)}/chapters?${params.toString()}`
      );

      if (Array.isArray(data)) {
        allChapters.push(...data.map((ch, idx) => mapChapter(ch, novelId, idx)));
        break;
      }

      const items = Array.isArray(data?.items) ? data.items : [];
      total = typeof data?.total === 'number' ? data.total : items.length;

      allChapters.push(
        ...items.map((ch, idx) => mapChapter(ch, novelId, offset + idx))
      );

      if (items.length === 0 || items.length < pageSize) {
        break;
      }
      offset += items.length;
    }

    return allChapters;
  },

  /**
   * Fetch chapter text content for reading or downloading (GET /api/chapter/{chapter_id}/read)
   * Parses ReadChapterResponse: { novel, chapter, job, content, next_id, previous_id, word_count }
   * If content is not cached on server yet, triggers auto_fetch and polls the returned job.
   */
  async fetchChapterContent(
    chapterId: string,
    options: { autoFetch?: boolean; language?: string } = {}
  ): Promise<{
    title: string;
    content: string;
    wordCount?: number | null;
    nextId?: string | null;
    previousId?: string | null;
  }> {
    const { autoFetch = true, language } = options;
    const params = new URLSearchParams();
    if (autoFetch) params.append('auto_fetch', 'true');
    if (language) params.append('language', language);
    const qs = params.toString() ? `?${params.toString()}` : '';

    let raw = await apiFetch<any>(`/api/chapter/${encodeURIComponent(chapterId)}/read${qs}`);

    if (typeof raw === 'string') {
      return { title: 'Chapter', content: raw };
    }

    // If chapter content is not crawled yet, wait on the auto-created job and re-read
    if (!raw?.content && raw?.job?.id) {
      const completedJob = await this.waitForJob(raw.job.id, 45000);
      if (completedJob.error) {
        throw new LNCrawlError(`Failed to crawl chapter: ${completedJob.error}`, 502);
      }
      raw = await apiFetch<any>(
        `/api/chapter/${encodeURIComponent(chapterId)}/read${language ? `?language=${encodeURIComponent(language)}` : ''}`
      );
    }

    if (!raw?.content) {
      throw new LNCrawlError(
        'Chapter content is not available on the server yet. Try fetching the chapter again.',
        404
      );
    }

    return {
      title: raw?.chapter?.title || raw?.title || 'Chapter Content',
      content: raw.content,
      wordCount: raw.word_count ?? null,
      nextId: raw.next_id ?? null,
      previousId: raw.previous_id ?? null,
    };
  },

  // ==========================================
  // CRAWLER JOBS & ARTIFACT DOWNLOADS
  // ==========================================

  async createSearchSourcesJob(query: string, domain?: string): Promise<LNCrawlJob> {
    return apiFetch<LNCrawlJob>('/api/job/create/search-sources', {
      method: 'POST',
      body: JSON.stringify({ query: query.trim(), ...(domain ? { domain } : {}) }),
    });
  },

  async createFetchNovelsJob(urls: string[], full: boolean = false): Promise<LNCrawlJob> {
    return apiFetch<LNCrawlJob>('/api/job/create/fetch-novels', {
      method: 'POST',
      body: JSON.stringify({ urls, full }),
    });
  },

  async createFetchChaptersJob(chapterIds: string[]): Promise<LNCrawlJob> {
    return apiFetch<LNCrawlJob>('/api/job/create/fetch-chapters', {
      method: 'POST',
      body: JSON.stringify({ chapters: chapterIds }),
    });
  },

  async createFetchMissingJob(novelId: string): Promise<LNCrawlJob> {
    return apiFetch<LNCrawlJob>('/api/job/create/fetch-missing', {
      method: 'POST',
      body: JSON.stringify({ novel_id: novelId }),
    });
  },

  async createMakeArtifactsJob(
    novelId: string,
    formats: string[] = ['epub'],
    language?: string,
    volume?: number
  ): Promise<LNCrawlJob> {
    return apiFetch<LNCrawlJob>('/api/job/create/make-artifacts', {
      method: 'POST',
      body: JSON.stringify({
        novel_id: novelId,
        formats,
        ...(language ? { language } : {}),
        ...(volume !== undefined ? { volume } : {}),
      }),
    });
  },

  async getJobStatus(jobId: string): Promise<LNCrawlJob> {
    return apiFetch<LNCrawlJob>(`/api/job/${encodeURIComponent(jobId)}`);
  },

  async listJobs(offset: number = 0, limit: number = 20): Promise<PaginatedResponse<LNCrawlJob>> {
    return apiFetch<PaginatedResponse<LNCrawlJob>>(
      `/api/jobs?offset=${offset}&limit=${limit}`
    );
  },

  async cancelJob(jobId: string): Promise<boolean> {
    return apiFetch<boolean>(`/api/job/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
  },

  async waitForJob(jobId: string, timeoutMs: number = 60000): Promise<LNCrawlJob> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = await this.getJobStatus(jobId);
      if (job.is_done || job.error) {
        return job;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new LNCrawlError('Background crawl job timed out while waiting for completion.', 408);
  },

  async getNovelArtifacts(novelId: string): Promise<LNCrawlArtifact[]> {
    return apiFetch<LNCrawlArtifact[]>(`/api/novel/${encodeURIComponent(novelId)}/artifacts`);
  },

  async getArtifact(artifactId: string): Promise<LNCrawlArtifact> {
    return apiFetch<LNCrawlArtifact>(`/api/artifact/${encodeURIComponent(artifactId)}`);
  },

  async getArtifactDownloadUrl(outputFile: string): Promise<string> {
    const token = await getStoredAuthToken();
    const clean = outputFile.replace(/^\/+/, '');
    return `${BASE_URL}/static/${clean}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  },

  // ==========================================
  // READ HISTORY SYNC
  // ==========================================

  async markChapterRead(chapterId: string): Promise<boolean> {
    return apiFetch<boolean>(`/api/read-history/add/${encodeURIComponent(chapterId)}`, {
      method: 'POST',
    });
  },

  async getContinueReading(novelId: string): Promise<any> {
    return apiFetch<any>(`/api/read-history/continue?novel_id=${encodeURIComponent(novelId)}`);
  },

  /**
   * Test backend API reachability (/openapi.json) and auth status (/api/auth/me)
   */
  async testConnection(): Promise<{
    online: boolean;
    authenticated: boolean;
    latencyMs: number;
    user?: LNCrawlUser;
  }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), APP_CONFIG.defaultTimeoutMs);
      const res = await fetch(`${BASE_URL}/openapi.json`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      if (!res.ok) {
        return { online: false, authenticated: false, latencyMs };
      }

      const token = await getStoredAuthToken();
      if (!token) {
        return { online: true, authenticated: false, latencyMs };
      }

      try {
        const user = await this.getMe();
        return { online: true, authenticated: true, latencyMs, user };
      } catch {
        return { online: true, authenticated: false, latencyMs };
      }
    } catch {
      return {
        online: false,
        authenticated: false,
        latencyMs: 0,
      };
    }
  },
};
