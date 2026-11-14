import { HTMLElement } from 'node-html-parser';
import { ChapterItem, NovelDetail, SearchItem, Source } from './types';
import {
  decodeHtmlEntities,
  extractCleanParagraphText,
  extractImageSrc,
  extractMetaContent,
  fetchHtml,
  parseDocument,
  toAbsoluteUrl,
  toRelativePath,
} from './http';

export interface NovelFullFamilyConfig {
  id: string;
  name: string;
  site: string;
  searchUrl: (encodedQuery: string) => string;
  searchItemSelectors: string[];
  searchTitleSelectors: string[];
  novelTitleSelectors: string[];
  novelCoverSelectors: string[];
  novelSummarySelectors: string[];
  chapterListSelectors: string[];
  chapterContentSelectors: string[];
  /**
   * Ordered preference:
   * - 'ajax-archive-first': try /ajax/chapter-archive?novelId=<id> first, fallback to ?page=N pagination
   * - 'paginated-or-ajax': if novelId exists try /ajax/chapter-option?novelId=<id> or paginate #list-chapter ?page=N
   */
  chapterStrategy: 'ajax-archive-first' | 'paginated-or-ajax';
  ajaxChapterEndpoint: (novelId: string) => string;
  searchIgnoreSelectors?: string[];
  searchNovelPathRegex?: RegExp;
  fallbackNovelIdFromPathSlug?: boolean;
  novelPageChapterFallbackSelectors?: string[];
}

function queryFirst(root: HTMLElement, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

function queryAllFirstMatch(root: HTMLElement, selectors: string[]): HTMLElement[] {
  for (const selector of selectors) {
    const matches = root.querySelectorAll(selector);
    if (matches.length > 0) return matches;
  }
  return [];
}

function appendPageParam(baseUrl: string, page: number): string {
  const clean = baseUrl.replace(/([?&])page=\d+/gi, '').replace(/[?&]$/, '');
  const sep = clean.includes('?') ? '&' : '?';
  return `${clean}${sep}page=${page}`;
}

export class NovelFullFamilySource implements Source {
  readonly id: string;
  readonly name: string;
  readonly site: string;
  private readonly config: NovelFullFamilyConfig;

  constructor(config: NovelFullFamilyConfig) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.site = config.site;
  }

  async search(query: string): Promise<SearchItem[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const url = `${this.site}${this.config.searchUrl(encodeURIComponent(trimmed))}`;
    const html = await fetchHtml(url, { site: this.site });
    const doc = parseDocument(html);

    if (this.config.searchIgnoreSelectors) {
      for (const ignoreSel of this.config.searchIgnoreSelectors) {
        for (const ignored of doc.querySelectorAll(ignoreSel)) {
          ignored.remove();
        }
      }
    }

    const rows = queryAllFirstMatch(doc, this.config.searchItemSelectors);
    const results: SearchItem[] = [];

    for (const row of rows) {
      let titleAnchor = queryFirst(row, this.config.searchTitleSelectors);
      let path = titleAnchor
        ? toRelativePath(titleAnchor.getAttribute('href'), this.site).replace(/\/+$/, '')
        : '';

      if (this.config.searchNovelPathRegex) {
        if (!path || !this.config.searchNovelPathRegex.test(path)) {
          const fallbackAnchor = row.querySelectorAll('a[href]').find((a) => {
            const candidate = toRelativePath(a.getAttribute('href'), this.site).replace(/\/+$/, '');
            return Boolean(candidate && this.config.searchNovelPathRegex!.test(candidate));
          });
          if (!fallbackAnchor) continue;
          if (!titleAnchor) {
            titleAnchor = fallbackAnchor;
          }
          path = toRelativePath(fallbackAnchor.getAttribute('href'), this.site).replace(/\/+$/, '');
        }
      }

      if (!titleAnchor || !path) continue;

      const title = decodeHtmlEntities(
        titleAnchor.getAttribute('title') || titleAnchor.text || ''
      ).trim();
      if (!title) continue;

      const cover = extractImageSrc(row.querySelector('img'), this.site);
      const authorEl =
        row.querySelector('.author') ||
        row.querySelector('span.author') ||
        row.querySelector('a[href*="/authors/"]');
      const author = decodeHtmlEntities(authorEl?.text || '')
        .replace(/^by\s+/i, '')
        .trim();

      results.push({
        title,
        path,
        ...(cover ? { cover } : {}),
        ...(author ? { author } : {}),
        sourceId: this.id,
      });
    }

    return results;
  }

  private parseChapterAnchors(
    doc: HTMLElement,
    seenPaths: Set<string>,
    chapters: ChapterItem[]
  ): number {
    let added = 0;
    const anchors = queryAllFirstMatch(doc, this.config.chapterListSelectors);

    for (const a of anchors) {
      const rawHref = a.getAttribute('href') || '';
      const chPath = toRelativePath(rawHref, this.site);
      if (!chPath || chPath === '#' || seenPaths.has(chPath)) continue;

      const titleAttr = a.getAttribute('title');
      const rawTitle = decodeHtmlEntities(titleAttr || a.text || '').trim();

      seenPaths.add(chPath);
      chapters.push({
        title: rawTitle || `Chapter ${chapters.length + 1}`,
        path: chPath,
        index: chapters.length,
      });
      added++;
    }

    // Fallback for /ajax/chapter-option returning <select><option value="...">
    if (added === 0) {
      const options = doc.querySelectorAll('select option[value], option[value]');
      for (const opt of options) {
        const rawVal = opt.getAttribute('value') || '';
        const chPath = toRelativePath(rawVal, this.site);
        if (!chPath || chPath === '#' || seenPaths.has(chPath)) continue;

        const rawTitle = decodeHtmlEntities(opt.text || '').trim();
        seenPaths.add(chPath);
        chapters.push({
          title: rawTitle || `Chapter ${chapters.length + 1}`,
          path: chPath,
          index: chapters.length,
        });
        added++;
      }
    }

    return added;
  }

  private async fetchAjaxChapters(novelId: string): Promise<ChapterItem[]> {
    const endpoint = `${this.site}${this.config.ajaxChapterEndpoint(encodeURIComponent(novelId))}`;
    const html = await fetchHtml(endpoint, {
      site: this.site,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const doc = parseDocument(html);
    const chapters: ChapterItem[] = [];
    const seenPaths = new Set<string>();
    this.parseChapterAnchors(doc, seenPaths, chapters);
    return chapters;
  }

  private async fetchPaginatedChapters(
    novelUrl: string,
    firstDoc: HTMLElement
  ): Promise<ChapterItem[]> {
    const chapters: ChapterItem[] = [];
    const seenPaths = new Set<string>();

    this.parseChapterAnchors(firstDoc, seenPaths, chapters);

    // Determine whether pagination exists before requesting page=2
    const hasPagination = Boolean(
      firstDoc.querySelector('.pagination li a, ul.pagination a, a[href*="?page="]')
    );
    if (!hasPagination) {
      return chapters;
    }

    const maxPages = 150;
    for (let page = 2; page <= maxPages; page++) {
      const pageUrl = appendPageParam(novelUrl, page);
      try {
        const html = await fetchHtml(pageUrl, { site: this.site, retries: 1 });
        const pageDoc = parseDocument(html);
        const added = this.parseChapterAnchors(pageDoc, seenPaths, chapters);
        if (added === 0) {
          break;
        }
      } catch {
        break;
      }
    }

    return chapters;
  }

  async getNovel(path: string): Promise<NovelDetail> {
    const url = toAbsoluteUrl(path, this.site);
    const html = await fetchHtml(url, { site: this.site });
    const doc = parseDocument(html);

    const titleEl = queryFirst(doc, this.config.novelTitleSelectors);
    const title =
      decodeHtmlEntities(titleEl?.text || '').trim() ||
      extractMetaContent(doc, 'og:title') ||
      'Untitled Novel';

    const coverEl = queryFirst(doc, this.config.novelCoverSelectors);
    const cover =
      extractImageSrc(coverEl, this.site) ||
      toAbsoluteUrl(extractMetaContent(doc, 'og:image'), this.site) ||
      undefined;

    const descEl = queryFirst(doc, this.config.novelSummarySelectors);
    const summary = descEl ? extractCleanParagraphText(descEl) : undefined;

    // Extract author & status from info metadata block when present
    let author: string | undefined;
    const authorEl =
      doc.querySelector('.info a[href*="author"]') ||
      doc.querySelector('.info-meta a[href*="author"]') ||
      doc.querySelector('.info .author a') ||
      doc.querySelector('a[href*="/authors/"]');
    if (authorEl) {
      author = decodeHtmlEntities(authorEl.text || '').trim() || undefined;
    } else {
      const infoRows = doc.querySelectorAll('.info > div, .info-meta li');
      for (const infoRow of infoRows) {
        const txt = decodeHtmlEntities(infoRow.text || '').trim();
        if (/^Author\s*:/i.test(txt)) {
          author = txt.replace(/^Author\s*:/i, '').trim() || undefined;
          break;
        }
      }
    }

    let status: string | undefined;
    const statusCandidate =
      doc.querySelector('.info a[href*="status"]') ||
      doc.querySelector('.info-meta a[href*="completed"]') ||
      doc.querySelector('.info-meta a[href*="ongoing"]');
    if (statusCandidate) {
      status = decodeHtmlEntities(statusCandidate.text || '').trim() || undefined;
    } else {
      const infoRows = doc.querySelectorAll('.info > div, .info-meta li');
      for (const infoRow of infoRows) {
        const txt = decodeHtmlEntities(infoRow.text || '').trim();
        if (/^Status\s*:/i.test(txt)) {
          status = txt.replace(/^Status\s*:/i, '').trim() || undefined;
          break;
        }
      }
    }

    const ratingEl = doc.querySelector('#rating[data-novel-id]') || doc.querySelector('[data-novel-id]');
    let novelId = ratingEl?.getAttribute('data-novel-id')?.trim();

    if (!novelId && this.config.fallbackNovelIdFromPathSlug) {
      const cleanPath = path.split('?')[0].split('#')[0].replace(/\/+$/, '');
      const segments = cleanPath.split('/').filter(Boolean);
      if (segments.length > 0) {
        novelId = segments[segments.length - 1];
      }
    }

    let chapters: ChapterItem[] = [];

    if (novelId) {
      try {
        chapters = await this.fetchAjaxChapters(novelId);
      } catch {
        chapters = [];
      }
    }

    if (chapters.length === 0) {
      chapters = await this.fetchPaginatedChapters(url, doc);
    }

    if (
      chapters.length === 0 &&
      this.config.novelPageChapterFallbackSelectors &&
      this.config.novelPageChapterFallbackSelectors.length > 0
    ) {
      const seenPaths = new Set<string>();
      const fallbackAnchors = queryAllFirstMatch(doc, this.config.novelPageChapterFallbackSelectors);
      for (const a of fallbackAnchors) {
        const chPath = toRelativePath(a.getAttribute('href') || '', this.site);
        if (!chPath || chPath === '#' || seenPaths.has(chPath)) continue;
        const rawTitle = decodeHtmlEntities(a.getAttribute('title') || a.text || '').trim();
        seenPaths.add(chPath);
        chapters.push({
          title: rawTitle || `Chapter ${chapters.length + 1}`,
          path: chPath,
          index: chapters.length,
        });
      }
    }

    return {
      title,
      ...(cover ? { cover } : {}),
      ...(author ? { author } : {}),
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      chapters,
    };
  }

  async getChapter(path: string): Promise<string> {
    const url = toAbsoluteUrl(path, this.site);
    const html = await fetchHtml(url, { site: this.site });
    const doc = parseDocument(html);

    const contentEl = queryFirst(doc, this.config.chapterContentSelectors);
    if (!contentEl) {
      throw new Error(`Could not locate chapter content on ${this.name}.`);
    }

    // Remove common navigation/watermark blocks before extracting text
    const extraNoise = contentEl.querySelectorAll(
      '.chapter-nav, .unlock-buttons, .box-ads, .hidden-xs, [align="center"] ins'
    );
    for (const el of extraNoise) {
      el.remove();
    }

    const text = extractCleanParagraphText(contentEl);
    if (!text) {
      throw new Error(`Extracted chapter text from ${this.name} was empty.`);
    }

    return text;
  }
}

export const readNovelFullSource = new NovelFullFamilySource({
  id: 'readnovelfull',
  name: 'ReadNovelFull',
  site: 'https://readnovelfull.com',
  searchUrl: (q) => `/novel-list/search?keyword=${q}`,
  searchItemSelectors: ['.list-novel > .row', '.list-truyen .row', '.archive .list-novel .row'],
  searchTitleSelectors: ['h3 a', 'h3.novel-title a', '.novel-title a'],
  novelTitleSelectors: ['h3.title', 'h1', '.books .title'],
  novelCoverSelectors: ['.book img', '.books img'],
  novelSummarySelectors: ['.desc-text', '#tab-description', '.summary .content'],
  chapterListSelectors: ['ul.list-chapter li a', '#list-chapter ul.list-chapter li a'],
  chapterContentSelectors: ['#chr-content', '#chapter-content', '.chr-c', '#chapter-c'],
  chapterStrategy: 'ajax-archive-first',
  ajaxChapterEndpoint: (novelId) => `/ajax/chapter-archive?novelId=${novelId}`,
});

export const novelFullSource = new NovelFullFamilySource({
  id: 'novelfull',
  name: 'NovelFull',
  site: 'https://novelfull.com',
  searchUrl: (q) => `/search?keyword=${q}`,
  searchItemSelectors: ['.list-truyen .row', '.list-novel .row'],
  searchTitleSelectors: ['h3.truyen-title a', 'h3 a', '.truyen-title a'],
  novelTitleSelectors: ['h3.title', 'h1', '.books .title'],
  novelCoverSelectors: ['.book img', '.books img'],
  novelSummarySelectors: ['.desc-text', '.summary .content'],
  chapterListSelectors: ['#list-chapter ul.list-chapter li a', 'ul.list-chapter li a'],
  chapterContentSelectors: ['#chapter-content', '#chr-content', '.chapter-c'],
  chapterStrategy: 'paginated-or-ajax',
  ajaxChapterEndpoint: (novelId) => `/ajax/chapter-option?novelId=${novelId}`,
});

export const novelBinSource = new NovelFullFamilySource({
  id: 'novelbin',
  name: 'NovelBin',
  site: 'https://novelbin.com',
  searchUrl: (q) => `/search?keyword=${q}`,
  searchIgnoreSelectors: ['.list-search-res'],
  searchItemSelectors: ['.list.list-novel > .row', '.list.list-novel .row'],
  searchTitleSelectors: ['h3 a'],
  searchNovelPathRegex: /^\/b\/[^/?#]+$/,
  novelTitleSelectors: ['h3.title', 'h1'],
  novelCoverSelectors: ['.book img'],
  novelSummarySelectors: ['.desc-text'],
  chapterListSelectors: ['ul.list-chapter li a'],
  chapterContentSelectors: ['#chr-content', '#chapter-content', '.chr-c'],
  chapterStrategy: 'ajax-archive-first',
  ajaxChapterEndpoint: (novelId) => `/ajax/chapter-archive?novelId=${novelId}`,
  fallbackNovelIdFromPathSlug: true,
  novelPageChapterFallbackSelectors: ['a[href*="/chapter-"]'],
});
