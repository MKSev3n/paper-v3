/**
 * LNCrawl Service Layer for Paper Light Novel Reader
 * Aligned with the live LNCrawl FastAPI OpenAPI 3.1.0 specification.
 * Uses API_URL, API_EMAIL, API_PASSWORD from src/config.ts
 */

import { API_URL, API_EMAIL, API_PASSWORD, APP_CONFIG } from '../config';
import {
  Novel,
  Chapter,
  PaginatedResponse,
  LNCrawlUser,
  LNCrawlJob,
  LNCrawlArtifact,
  LNCrawlSourceItem,
  RawLNCrawlSearchResult,
  ExternalSearchResult,
} from '../types';
import {
  getStoredAuthToken,
  setStoredAuthToken,
  deleteStoredAuthToken,
} from './storage';

const BASE_URL = API_URL.replace(/\/+$/, '');

export class LNCrawlError extends Error {
  status: number;
  constructor(message: string, status: number = 0) {
    super(message);
    this.name = 'LNCrawlError';
    this.status = status;
  }
}

let hasWokenServer = false;
let isWakingServer = false;
let inFlightAuthPromise: Promise<string> | null = null;
const wakingListeners = new Set<(waking: boolean) => void>();

function setWakingState(waking: boolean) {
  if (isWakingServer === waking) return;
  isWakingServer = waking;
  wakingListeners.forEach((fn) => fn(waking));
}

async function performLogin(email: string, password: string): Promise<{ token: string; user: LNCrawlUser }> {
  const totalBudgetMs = !hasWokenServer ? APP_CONFIG.firstRequestTimeoutMs : APP_CONFIG.defaultTimeoutMs;
  const deadline = Date.now() + totalBudgetMs;

  if (!hasWokenServer) {
    setWakingState(true);
  }

  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new LNCrawlError(
          'Server timed out while waking up. Render free-tier instances can take up to 60s — please retry.',
          408
        );
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), remainingMs);

      try {
        const res = await fetch(`${BASE_URL}/api/auth/login`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: email.trim(), password }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Render free tier can briefly emit 502/503/504 while booting the FastAPI worker
        if (!hasWokenServer && (res.status === 502 || res.status === 503 || res.status === 504)) {
          if (Date.now() + 3500 < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 3500));
            continue;
          }
        }

        hasWokenServer = true;

        if (!res.ok) {
          let errMessage = `Sign in failed (${res.status})`;
          try {
            const errorJson = await res.json();
            if (typeof errorJson?.detail === 'string' && errorJson.detail) {
              errMessage = errorJson.detail;
            } else if (typeof errorJson?.error === 'string' && errorJson.error) {
              errMessage = errorJson.error;
            }
          } catch {
            // Fallback to status message
          }
          if (res.status === 401) {
            errMessage = 'Invalid email/username or password (401 Unauthorized).';
          }
          throw new LNCrawlError(errMessage, res.status);
        }

        const data = (await res.json()) as { token: string; user: LNCrawlUser };
        if (!data?.token) {
          throw new LNCrawlError('Authentication succeeded but server returned no token.', 500);
        }
        await setStoredAuthToken(data.token);
        return data;
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === 'AbortError') {
          throw new LNCrawlError(
            'Server timed out while waking up. Render free-tier instances can take up to 60s — please retry.',
            408
          );
        }
        if (err instanceof LNCrawlError) {
          throw err;
        }
        throw new LNCrawlError(
          err?.message || 'Network error while signing in to LNCrawl server.',
          0
        );
      }
    }
  } finally {
    setWakingState(false);
  }
}

async function ensureAuthenticated(forceLogin: boolean = false): Promise<string> {
  if (!forceLogin) {
    const existing = await getStoredAuthToken();
    if (existing) return existing;
  }

  if (!inFlightAuthPromise) {
    inFlightAuthPromise = performLogin(API_EMAIL, API_PASSWORD)
      .then((res) => res.token)
      .finally(() => {
        inFlightAuthPromise = null;
      });
  }

  return inFlightAuthPromise;
}

async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs?: number,
  isRetryAfter401: boolean = false
): Promise<T> {
  const isLoginEndpoint = endpoint.startsWith('/api/auth/login');
  const token = isLoginEndpoint ? null : await ensureAuthenticated(false);

  const effectiveTimeout =
    timeoutMs ?? (!hasWokenServer ? APP_CONFIG.firstRequestTimeoutMs : APP_CONFIG.defaultTimeoutMs);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  if (!hasWokenServer) {
    setWakingState(true);
  }

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    hasWokenServer = true;
    setWakingState(false);

    // Handle sliding token refresh header exposed by LNCrawl server
    const refreshedToken = res.headers.get('X-Refresh-Token') || res.headers.get('x-refresh-token');
    if (refreshedToken && refreshedToken !== token) {
      await setStoredAuthToken(refreshedToken);
    }

    // On any 401, log in again once and retry that request
    if (res.status === 401 && !isLoginEndpoint && !isRetryAfter401) {
      await deleteStoredAuthToken();
      await ensureAuthenticated(true);
      return apiFetch<T>(endpoint, options, timeoutMs, true);
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
        errMessage = isLoginEndpoint
          ? 'Invalid username/email or password (401 Unauthorized).'
          : 'Authentication failed (401 Unauthorized). Please check credentials and retry.';
      }
      throw new LNCrawlError(errMessage, res.status);
    }

    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  } catch (err: any) {
    clearTimeout(timeoutId);
    setWakingState(false);
    if (err?.name === 'AbortError') {
      throw new LNCrawlError(
        'Request timed out. The server may be waking up from cold start.',
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

export function stripHtmlTags(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractDomainFromUrl(rawUrl: string): string {
  if (!rawUrl) return 'unknown';
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    const match = rawUrl.match(/^https?:\/\/(?:www\.)?([^/?#]+)/i);
    return match ? match[1].toLowerCase() : 'unknown';
  }
}

export function cleanMtlTitle(rawTitle: string): { displayTitle: string; isMtl: boolean } {
  const trimmed = (rawTitle || '').trim();
  const isMtl = /^mtl\s*[-_:]/i.test(trimmed);
  const displayTitle = isMtl ? trimmed.replace(/^mtl\s*[-_:]+/i, '').trim() : trimmed;
  return {
    displayTitle: displayTitle || trimmed || 'Untitled Novel',
    isMtl,
  };
}

export function normalizeSearchTitle(rawTitle: string): string {
  const { displayTitle } = cleanMtlTitle(rawTitle);
  return displayTitle
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function processSearchResults(
  rawResults: RawLNCrawlSearchResult[] | undefined | null
): ExternalSearchResult[] {
  if (!Array.isArray(rawResults) || rawResults.length === 0) return [];

  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const processed: ExternalSearchResult[] = [];

  for (const item of rawResults) {
    if (!item?.url || !item?.title) continue;
    const { displayTitle, isMtl } = cleanMtlTitle(item.title);
    const normalizedTitle = normalizeSearchTitle(item.title);
    const normalizedUrl = item.url.trim().toLowerCase();
    const dedupeKey = normalizedTitle || normalizedUrl;

    if (seenTitles.has(dedupeKey) || seenUrls.has(normalizedUrl)) continue;
    seenTitles.add(dedupeKey);
    seenUrls.add(normalizedUrl);

    processed.push({
      title: item.title,
      displayTitle,
      isMtl,
      url: item.url,
      domain: extractDomainFromUrl(item.url),
      info: typeof item.info === 'string' ? item.info.trim() : '',
      normalizedTitle,
    });
  }

  return processed;
}

function normalizeUrlForMatch(url: string): string {
  return (url || '').trim().replace(/\/+$/, '').toLowerCase();
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

  const extra = raw?.extra || {};
  const extraCover =
    extra?.cover_url ||
    extra?.cover ||
    extra?.cover_image ||
    extra?.thumbnail_url ||
    extra?.thumbnail ||
    extra?.image_url ||
    extra?.image;

  if (typeof extraCover === 'string' && extraCover.trim()) {
    const trimmed = extraCover.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (token) {
      const cleanExtra = trimmed.replace(/^\/+/, '');
      return `${BASE_URL}/static/${cleanExtra}?token=${encodeURIComponent(token)}`;
    }
  }

  return raw?.cover_url || raw?.thumbnail_url || raw?.image_url || '';
}

function mapNovel(raw: any, token: string | null): Novel {
  const extraStatus = raw?.extra?.status;
  const statusStr = String(raw?.status || extraStatus || '').toLowerCase();
  let status: Novel['status'] = 'Ongoing';
  if (statusStr.includes('complete')) status = 'Completed';
  else if (statusStr.includes('hiatus')) status = 'Hiatus';

  const rawSynopsis = raw?.synopsis || raw?.description || '';
  const cleanSynopsis = stripHtmlTags(rawSynopsis) || 'No synopsis provided.';

  return {
    id: String(raw.id),
    title: raw.title || raw.name || 'Untitled Novel',
    author: parseAuthors(raw),
    synopsis: cleanSynopsis,
    coverUrl: resolveCoverUrl(raw, token),
    genres: Array.isArray(raw.tags)
      ? raw.tags
      : Array.isArray(raw.genres)
      ? raw.genres
      : ['Light Novel'],
    status,
    totalChapters: raw.chapter_count ?? raw.total_chapters ?? 0,
    sourceDomain: raw.domain || raw.source || extractDomainFromUrl(raw.url || '') || 'LNCrawl',
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
  subscribeWaking(listener: (waking: boolean) => void): () => void {
    wakingListeners.add(listener);
    listener(isWakingServer);
    return () => wakingListeners.delete(listener);
  },

  isServerAwake(): boolean {
    return hasWokenServer;
  },

  /**
   * Ensure a valid Bearer token exists using config credentials (or stored session)
   */
  async ensureSession(): Promise<string> {
    return ensureAuthenticated(false);
  },

  /**
   * Sign in to LNCrawl server (POST /api/auth/login)
   */
  async login(
    email: string,
    password: string
  ): Promise<{ token: string; user: LNCrawlUser }> {
    return performLogin(email, password);
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
   * List supported searchable sources (GET /api/sources?skip_rejected=true)
   */
  async getSearchableSources(): Promise<LNCrawlSourceItem[]> {
    const sources = await apiFetch<LNCrawlSourceItem[]>('/api/sources?skip_rejected=true');
    if (!Array.isArray(sources)) return [];
    return sources.filter((s) => s.can_search && !s.is_disabled);
  },

  /**
   * Search novels in the LNCrawl server database (GET /api/novels)
   * Returns Paginated[Novel] -> { total, offset, limit, items }
   */
  async searchNovels(
    query: string,
    offset: number = 0,
    limit: number = 24,
    sort?: string
  ): Promise<Novel[]> {
    const params = new URLSearchParams();
    if (query.trim()) {
      params.append('search', query.trim());
    }
    params.append('offset', String(offset));
    params.append('limit', String(Math.min(100, limit)));
    if (sort) {
      params.append('sort', sort);
    }

    const data = await apiFetch<PaginatedResponse<any> | any[]>(
      `/api/novels?${params.toString()}`
    );

    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const token = await getStoredAuthToken();

    return items.map((item) => mapNovel(item, token));
  },

  /**
   * Fetch novel metadata via POST /api/job/create/fetch-novels and resolve the created Novel record.
   */
  async fetchAndImportNovelByUrl(
    resultUrl: string,
    cleanedTitle: string,
    onStatus?: (message: string) => void
  ): Promise<Novel> {
    onStatus?.('Adding to library...');
    const job = await this.createFetchNovelsJob([resultUrl], false);

    const deadline = Date.now() + APP_CONFIG.searchTimeoutMs;
    let currentJob = job;

    while (!currentJob.is_done && !currentJob.error && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, APP_CONFIG.searchPollIntervalMs));
      currentJob = await this.getJobStatus(currentJob.id);
    }

    if (currentJob.error) {
      throw new LNCrawlError(currentJob.error, 502);
    }
    if (!currentJob.is_done) {
      throw new LNCrawlError('Timed out waiting for novel details from crawler.', 408);
    }

    const targetNorm = normalizeUrlForMatch(resultUrl);

    const matchByUrl = (novels: Novel[]): Novel | undefined =>
      novels.find((n) => n.url && normalizeUrlForMatch(n.url) === targetNorm);

    // 1. Search by cleaned title
    let candidates = await this.searchNovels(cleanedTitle, 0, 20);
    let matched = matchByUrl(candidates);

    // 2. Retry once after 3 seconds if not indexed yet
    if (!matched) {
      await new Promise((r) => setTimeout(r, 3000));
      candidates = await this.searchNovels(cleanedTitle, 0, 20);
      matched = matchByUrl(candidates);
    }

    // 3. Fallback: check most recently updated novels
    if (!matched) {
      const recent = await this.searchNovels('', 0, 10, 'updated');
      matched = matchByUrl(recent);
    }

    if (!matched) {
      throw new LNCrawlError(
        'Novel crawl finished, but the novel could not be located on the server yet. Please retry.',
        404
      );
    }

    return matched;
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
   * Paginates through Paginated[Chapter] in batches of 100 (API max) until all chapters are retrieved.
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
   * Read chapter text content (GET /api/chapter/{chapter_id}/read)
   */
  async readChapter(
    chapterId: string,
    options: { autoFetch?: boolean; language?: string } = {}
  ): Promise<{
    title: string;
    content: string | null;
    wordCount?: number | null;
    nextId?: string | null;
    previousId?: string | null;
    job?: LNCrawlJob | null;
  }> {
    const { autoFetch = false, language } = options;
    const params = new URLSearchParams();
    if (autoFetch) params.append('auto_fetch', 'true');
    if (language) params.append('language', language);
    const qs = params.toString() ? `?${params.toString()}` : '';

    const raw = await apiFetch<any>(`/api/chapter/${encodeURIComponent(chapterId)}/read${qs}`);

    if (typeof raw === 'string') {
      return { title: 'Chapter', content: raw };
    }

    return {
      title: raw?.chapter?.title || raw?.title || 'Chapter Content',
      content: typeof raw?.content === 'string' && raw.content.trim().length > 0 ? raw.content : null,
      wordCount: raw?.word_count ?? null,
      nextId: raw?.next_id ?? null,
      previousId: raw?.previous_id ?? null,
      job: raw?.job ?? null,
    };
  },

  /**
   * Fetch chapter text content for reading or downloading (GET /api/chapter/{chapter_id}/read)
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
    let first = await this.readChapter(chapterId, { autoFetch, language });

    if (!first.content && first.job?.id) {
      const completedJob = await this.waitForJob(first.job.id, 45000);
      if (completedJob.error) {
        throw new LNCrawlError(`Failed to crawl chapter: ${completedJob.error}`, 502);
      }
      first = await this.readChapter(chapterId, { autoFetch: false, language });
    }

    if (!first.content) {
      throw new LNCrawlError(
        'Chapter content is not available on the server yet. Try fetching the chapter again.',
        404
      );
    }

    return {
      title: first.title,
      content: first.content,
      wordCount: first.wordCount ?? null,
      nextId: first.nextId ?? null,
      previousId: first.previousId ?? null,
    };
  },

  // ==========================================
  // CRAWLER JOBS & ARTIFACT DOWNLOADS
  // ==========================================

  async createSearchSourcesJob(query: string, domain?: string): Promise<LNCrawlJob> {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      throw new LNCrawlError('Search query must be at least 2 characters.', 422);
    }
    const capped = trimmed.slice(0, 50);
    return apiFetch<LNCrawlJob>('/api/job/create/search-sources', {
      method: 'POST',
      body: JSON.stringify({ query: capped, ...(domain ? { domain } : {}) }),
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
      await new Promise((r) => setTimeout(r, APP_CONFIG.searchPollIntervalMs));
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
   * Ensure auth session & test backend API reachability (/api/auth/me)
   * Uses 60s cold-start timeout on the very first request.
   */
  async testConnection(): Promise<{
    online: boolean;
    authenticated: boolean;
    latencyMs: number;
    user?: LNCrawlUser;
    error?: string;
  }> {
    const start = Date.now();
    try {
      await ensureAuthenticated(false);
      const user = await this.getMe();
      const latencyMs = Date.now() - start;
      return { online: true, authenticated: true, latencyMs, user };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      const status = err?.status ?? 0;
      const online = status > 0 && status !== 408;
      return {
        online,
        authenticated: false,
        latencyMs,
        error: err?.message || 'Unable to connect to LNCrawl server.',
      };
    }
  },
};
