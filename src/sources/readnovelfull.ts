import { HTMLElement } from 'node-html-parser';
import { ChapterItem, ListingKind, NovelDetail, SearchItem, Source } from './types';
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
  genrePath: (genre: string) => string;
  listingPaths: Record<ListingKind, string>;
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

// ==========================================
// CHAPTER TEXT CLEANING (shared across the NovelFull family)
// Applied at parse time. Only the first few lines are treated as a header, so
// the story body is never altered beyond whitespace normalization.
// ==========================================

const CHAPTER_TITLE_SELECTORS = [
  '#chapter-title',
  '.chapter-title',
  '.chr-title',
  '.entry-title',
  '.text-center h2',
  'h1',
  'h2',
];

/** Normalize a string for comparison: lowercase, strip punctuation/whitespace. */
function normalizeForMatch(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Reduce a heading like "Chapter 1: prison break" to its descriptive part. */
function stripChapterNumberPrefix(title: string): string {
  const cleaned = (title || '')
    .replace(/^\s*chapter\s+\d+\s*[:.\-–]?\s*/i, '')
    .replace(/^\s*ch\.?\s*\d+\s*[:.\-–]?\s*/i, '')
    .trim();
  return cleaned || (title || '').trim();
}

/**
 * Extract the real chapter title from the chapter heading element. Prefers an
 * explicit title/heading node, then any element whose text starts with
 * "Chapter N". Returns '' when nothing usable is found.
 */
function extractChapterTitle(doc: HTMLElement, contentEl: HTMLElement): string {
  // 1. Explicit title selectors. A "Chapter N..." heading is accepted from the
  //    content element or the whole document; a bare heading (no chapter number)
  //    is only accepted when it lives inside the content element, so a site
  //    name in a document-level <h1> is never mistaken for the chapter title.
  for (const selector of CHAPTER_TITLE_SELECTORS) {
    const inContent = contentEl.querySelector(selector);
    const el = inContent || doc.querySelector(selector);
    const text = decodeHtmlEntities(el?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^(chapter|ch\.?)\s*\d+/i.test(text)) {
      return text;
    }
    if (inContent && /h[12]/i.test(inContent.tagName || '')) {
      return text;
    }
  }

  // 2. Any heading whose text begins with "Chapter N".
  const headings = doc.querySelectorAll('h1, h2, h3, .chapter-title, #chapter-title');
  for (const h of headings) {
    const text = decodeHtmlEntities(h.text || '').replace(/\s+/g, ' ').trim();
    if (/^(chapter|ch\.?)\s*\d+/i.test(text)) {
      return text;
    }
  }

  return '';
}

/** Heuristic junk/watermark line filters (applied to the header region only). */
function isHeaderJunkLine(line: string, chapterTitle: string, siteName: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;

  // Repeats the chapter title or a bare "Chapter N" heading.
  const normLine = normalizeForMatch(trimmed);
  const normTitle = normalizeForMatch(chapterTitle);
  if (normTitle && normLine === normTitle) return true;
  if (/^(chapter|ch\.?)\s*\d+\s*[:.\-–]?.*$/i.test(trimmed) && trimmed.length <= 120) {
    // A heading line like "Chapter 12: ..." (not story prose).
    if (/^(chapter|ch\.?)\s*\d+\s*[:.\-–]?\s*$/i.test(trimmed) || normLine === normTitle) {
      return true;
    }
  }

  // Author / translator / source bylines.
  if (/^author\s*:/i.test(trimmed)) return true;
  if (/^translator\s*:/i.test(trimmed)) return true;
  if (/^editor\s*:/i.test(trimmed)) return true;

  // Machine-translation tags.
  if (/\b(machine translation|mtl|translated by|translation by)\b/i.test(trimmed) && trimmed.length <= 80) {
    return true;
  }

  // Lone numeric lines (page counters).
  if (/^\d{1,4}$/.test(trimmed)) return true;

  // "Read more at <site>" / site-name watermark lines.
  if (/^read more (at|on)\b/i.test(trimmed)) return true;
  if (siteName && normalizeForMatch(trimmed) === normalizeForMatch(siteName)) return true;

  return false;
}

/** Remove spaces before closing quotes and punctuation; collapse whitespace. */
function normalizeLineSpacing(line: string): string {
  return line
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([”’.,!?;:%)\]])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim();
}

/**
 * Clean extracted chapter body text:
 * - drop header junk (title repeats, bylines, MT tags, page counters, watermarks)
 *   from the first lines only,
 * - normalize whitespace and spacing before punctuation.
 */
function cleanChapterBody(
  rawText: string,
  chapterTitle: string,
  siteName: string
): string {
  const HEADER_LINES = 5;
  const normalized = rawText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const output: string[] = [];
  let headerBudget = HEADER_LINES;
  let startedBody = false;

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+/g, ' ').trim();

    if (!startedBody) {
      if (!line) {
        // Preserve a single blank separator, but don't count it as header.
        if (output.length > 0 && output[output.length - 1] !== '') output.push('');
        continue;
      }
      if (headerBudget > 0) {
        headerBudget--;
        if (isHeaderJunkLine(line, chapterTitle, siteName)) {
          continue;
        }
      }
      startedBody = true;
      output.push(normalizeLineSpacing(line));
      continue;
    }

    if (!line) {
      if (output.length > 0 && output[output.length - 1] !== '') output.push('');
      continue;
    }
    output.push(normalizeLineSpacing(line));
  }

  // Trim leading/trailing blank lines and collapse runs of blank lines.
  const collapsed: string[] = [];
  for (const l of output) {
    if (l === '' && (collapsed.length === 0 || collapsed[collapsed.length - 1] === '')) {
      continue;
    }
    collapsed.push(l);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') {
    collapsed.pop();
  }

  return collapsed.join('\n');
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

    return this.parseListItems(doc);
  }

  async getByGenre(genre: string, page: number = 1): Promise<SearchItem[]> {
    const trimmed = genre.trim();
    if (!trimmed) return [];

    let path = this.config.genrePath(trimmed);
    if (!path) return [];
    if (page > 1) {
      path = appendPageParam(path, page);
    }

    const url = toAbsoluteUrl(path, this.site);

    let html: string;
    try {
      html = await fetchHtml(url, { site: this.site });
    } catch (err: any) {
      // A missing genre page (404) is treated as "no results", not an error.
      if (err?.status === 404) return [];
      throw err;
    }

    const doc = parseDocument(html);

    if (this.config.searchIgnoreSelectors) {
      for (const ignoreSel of this.config.searchIgnoreSelectors) {
        for (const ignored of doc.querySelectorAll(ignoreSel)) {
          ignored.remove();
        }
      }
    }

    return this.parseListItems(doc, {
      stripMtlPrefix: true,
      skipChapterLinks: true,
    });
  }

  async getListing(kind: ListingKind, page: number = 1): Promise<SearchItem[]> {
    let path = this.config.listingPaths[kind];
    if (!path) return [];
    if (page > 1) {
      path = appendPageParam(path, page);
    }

    const url = toAbsoluteUrl(path, this.site);

    let html: string;
    try {
      html = await fetchHtml(url, { site: this.site });
    } catch {
      // Any HTTP/network error for a listing returns an empty list, never throws.
      return [];
    }

    const doc = parseDocument(html);

    if (this.config.searchIgnoreSelectors) {
      for (const ignoreSel of this.config.searchIgnoreSelectors) {
        for (const ignored of doc.querySelectorAll(ignoreSel)) {
          ignored.remove();
        }
      }
    }

    return this.parseListItems(doc, {
      stripMtlPrefix: true,
      skipChapterLinks: true,
    });
  }

  /**
   * Shared row parsing for search and genre listing pages.
   * Uses the same item selectors/title selectors as search so both paths
   * stay in sync. Options only add extra filtering for genre listings.
   */
  private parseListItems(
    doc: HTMLElement,
    options?: { stripMtlPrefix?: boolean; skipChapterLinks?: boolean }
  ): SearchItem[] {
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

      if (options?.skipChapterLinks && /\/chapter-/i.test(path)) continue;

      let title = decodeHtmlEntities(
        titleAnchor.getAttribute('title') || titleAnchor.text || ''
      ).trim();
      if (!title) continue;

      if (options?.stripMtlPrefix) {
        title = title.replace(/^MTL-\s*/i, '').trim();
        if (!title) continue;
      }

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
    const { content } = await this.getChapterDetail(path);
    return content;
  }

  async getChapterDetail(path: string): Promise<{ title: string; content: string }> {
    const url = toAbsoluteUrl(path, this.site);
    const html = await fetchHtml(url, { site: this.site });
    const doc = parseDocument(html);

    const contentEl = queryFirst(doc, this.config.chapterContentSelectors);
    if (!contentEl) {
      throw new Error(`Could not locate chapter content on ${this.name}.`);
    }

    // Extract the real chapter title from the heading before mutating the DOM.
    const chapterTitle = extractChapterTitle(doc, contentEl);

    // Remove common navigation/watermark/ad blocks before extracting text.
    const extraNoise = contentEl.querySelectorAll(
      '.chapter-nav, .unlock-buttons, .box-ads, .hidden-xs, [align="center"] ins, script, ins, .ads, .adsbox, .ad'
    );
    for (const el of extraNoise) {
      el.remove();
    }

    const rawText = extractCleanParagraphText(contentEl);
    if (!rawText) {
      throw new Error(`Extracted chapter text from ${this.name} was empty.`);
    }

    const content = cleanChapterBody(rawText, chapterTitle, this.name);
    if (!content) {
      throw new Error(`Extracted chapter text from ${this.name} was empty.`);
    }

    const title = stripChapterNumberPrefix(chapterTitle) || chapterTitle;
    return { title, content };
  }
}

export const readNovelFullSource = new NovelFullFamilySource({
  id: 'readnovelfull',
  name: 'ReadNovelFull',
  site: 'https://readnovelfull.com',
  searchUrl: (q) => `/novel-list/search?keyword=${q}`,
  genrePath: (genre) => `/genres/${genre.toLowerCase().replace(/\s+/g, '-')}`,
  listingPaths: {
    hot: '/novel-list/hot-novel',
    popular: '/novel-list/most-popular-novel',
    latest: '/novel-list/latest-release-novel',
  },
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
  genrePath: (genre) =>
    `/genre/${genre
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('-')}`,
  listingPaths: {
    hot: '/hot-novel',
    popular: '/most-popular',
    latest: '/latest-release-novel',
  },
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
  genrePath: (genre) => `/genre/${genre.toLowerCase().replace(/\s+/g, '-')}`,
  listingPaths: {
    hot: '/sort/top-hot-novel',
    popular: '/sort/top-view-novel',
    latest: '/sort/latest',
  },
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
