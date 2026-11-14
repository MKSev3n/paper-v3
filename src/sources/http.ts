import { parse, HTMLElement, Node } from 'node-html-parser';

export interface FetchHtmlOptions {
  site: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

export class SourceBlockedError extends Error {
  status: number;
  constructor(message: string = 'Blocked by site', status: number = 403) {
    super(message);
    this.name = 'SourceBlockedError';
    this.status = status;
  }
}

export class SourceHttpError extends Error {
  status: number;
  constructor(message: string, status: number = 0) {
    super(message);
    this.name = 'SourceHttpError';
    this.status = status;
  }
}

function isCloudflareOrBlockPage(status: number, body: string): boolean {
  if (status === 403 || status === 503) {
    return true;
  }
  const lower = body.toLowerCase();
  if (
    lower.includes('just a moment') ||
    lower.includes('cf-challenge') ||
    lower.includes('cf_chl_opt') ||
    lower.includes('checking your browser before accessing')
  ) {
    return true;
  }
  return false;
}

export async function fetchHtml(url: string, options: FetchHtmlOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRetries = options.retries ?? 2;
  const siteBase = options.site.replace(/\/+$/, '');

  const headers: Record<string, string> = {
    'User-Agent': MOBILE_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${siteBase}/`,
    ...(options.headers || {}),
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });

      clearTimeout(timer);
      const body = await response.text();

      if (isCloudflareOrBlockPage(response.status, body)) {
        throw new SourceBlockedError(
          `Blocked by site (${response.status || 'Cloudflare challenge'})`,
          response.status || 403
        );
      }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const err = new SourceHttpError(
          `HTTP ${response.status} while fetching ${url}`,
          response.status
        );
        if (retryable && attempt < maxRetries) {
          lastError = err;
          await delay(400 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }

      return body;
    } catch (err: any) {
      clearTimeout(timer);

      if (err instanceof SourceBlockedError) {
        throw err;
      }

      if (err?.name === 'AbortError') {
        lastError = new SourceHttpError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, 408);
      } else if (err instanceof SourceHttpError) {
        lastError = err;
      } else {
        lastError = new SourceHttpError(err?.message || 'Network request failed', 0);
      }

      if (attempt < maxRetries) {
        await delay(400 * Math.pow(2, attempt));
        continue;
      }
    }
  }

  throw lastError || new SourceHttpError(`Failed to fetch ${url}`, 0);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toAbsoluteUrl(rawUrl: string | undefined | null, site: string): string {
  if (!rawUrl) return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const cleanSite = site.replace(/\/+$/, '');
  if (trimmed.startsWith('//')) {
    const protocol = cleanSite.startsWith('http://') ? 'http:' : 'https:';
    return `${protocol}${trimmed}`;
  }
  if (trimmed.startsWith('/')) {
    return `${cleanSite}${trimmed}`;
  }
  return `${cleanSite}/${trimmed}`;
}

export function toRelativePath(rawUrl: string | undefined | null, site: string): string {
  if (!rawUrl) return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      const siteUrl = new URL(site);
      const normA = parsed.hostname.replace(/^www\./i, '').toLowerCase();
      const normB = siteUrl.hostname.replace(/^www\./i, '').toLowerCase();
      if (normA === normB) {
        return `${parsed.pathname}${parsed.search}` || '/';
      }
      return trimmed;
    }
  } catch {
    // Fallback below
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function extractImageSrc(img: HTMLElement | null | undefined, site: string): string | undefined {
  if (!img) return undefined;
  const raw =
    img.getAttribute('data-src') ||
    img.getAttribute('data-lazy-src') ||
    img.getAttribute('src') ||
    '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:')) {
    return undefined;
  }
  const abs = toAbsoluteUrl(trimmed, site);
  return abs || undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
};

export function decodeHtmlEntities(text: string): string {
  if (!text) return '';
  return text.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    const lower = entity.toLowerCase();
    return NAMED_ENTITIES[lower] ?? full;
  });
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'TR',
  'PRE',
  'HEADER',
  'FOOTER',
]);

const AD_AND_NOISE_SELECTOR = [
  'script',
  'style',
  'iframe',
  'ins',
  'noscript',
  'button',
  'form',
  'div[id^="pf-"]',
  '.ad',
  '.ads',
  '.adsbox',
  '.ad-box',
  '.ads-holder',
  '.ads-middle',
  '.ads-banner',
  '.adsbygoogle',
  '.ad-container',
  '.ad-wrapper',
  '.chapter-ads',
  '.box-ads',
  '[id^="google_ads"]',
  '[data-ad-slot]',
].join(', ');

const AD_ID_PATTERN = /(^pf-)|((^|[-_])ads?([-_]|$))|adsense|adslot|adunit|banner[-_]?ad|sponsor/i;
const AD_CLASS_PATTERN =
  /(^|\s)(ad|ads|adsbox|ad-box|ads-holder|ads-middle|ads-banner|adsbygoogle|ad-container|ad-wrapper|chapter-ads|box-ads|ad-[a-z0-9-]+|ads-[a-z0-9-]+|sponsored)(\s|$)/i;

export function stripUnwantedNodes(container: HTMLElement): void {
  const noise = container.querySelectorAll(AD_AND_NOISE_SELECTOR);
  for (const node of noise) {
    node.remove();
  }
  const divs = container.querySelectorAll('div');
  for (const div of divs) {
    const idAttr = (div.getAttribute('id') || '').trim();
    const classAttr = (div.getAttribute('class') || '').trim();
    if (
      (idAttr && AD_ID_PATTERN.test(idAttr)) ||
      (classAttr && AD_CLASS_PATTERN.test(classAttr))
    ) {
      div.remove();
    }
  }
  const hiddenInline = container.querySelectorAll('[style]');
  for (const el of hiddenInline) {
    const styleVal = (el.getAttribute('style') || '').toLowerCase();
    if (/display\s*:\s*none/.test(styleVal) || /visibility\s*:\s*hidden/.test(styleVal)) {
      el.remove();
    }
  }
}

function collectNodeText(node: Node, out: string[]): void {
  // TextNode = 3, HTMLElement = 1
  if (node.nodeType === 3) {
    const raw = (node as any).rawText ?? node.text ?? '';
    if (raw) {
      out.push(raw.replace(/\s+/g, ' '));
    }
    return;
  }

  if (node.nodeType !== 1) return;

  const el = node as HTMLElement;
  const tag = (el.tagName || '').toUpperCase();

  if (
    tag === 'SCRIPT' ||
    tag === 'STYLE' ||
    tag === 'IFRAME' ||
    tag === 'INS' ||
    tag === 'NOSCRIPT'
  ) {
    return;
  }

  if (tag === 'BR') {
    out.push('\n');
    return;
  }

  if (tag === 'HR') {
    out.push('\n\n* * *\n\n');
    return;
  }

  const isBlock = BLOCK_TAGS.has(tag);
  if (isBlock) out.push('\n\n');

  for (const child of el.childNodes) {
    collectNodeText(child, out);
  }

  if (isBlock) out.push('\n\n');
}

export function extractCleanParagraphText(root: HTMLElement): string {
  stripUnwantedNodes(root);

  const chunks: string[] = [];
  collectNodeText(root, chunks);

  const decoded = decodeHtmlEntities(chunks.join(''));
  const lines = decoded
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
    )
    .filter(Boolean);

  return lines.join('\n\n');
}

export function parseDocument(html: string): HTMLElement {
  return parse(html, {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
      pre: true,
    },
  });
}

export function extractMetaContent(doc: HTMLElement, propertyOrName: string): string {
  const el =
    doc.querySelector(`meta[property="${propertyOrName}"]`) ||
    doc.querySelector(`meta[name="${propertyOrName}"]`);
  return decodeHtmlEntities(el?.getAttribute('content') || '').trim();
}
