import { Source, SourceDiagnosticResult, SourceDiagnosticStep } from './types';
import { readNovelFullSource, novelFullSource, novelBinSource } from './readnovelfull';

export * from './types';
export { fetchHtml, toAbsoluteUrl, toRelativePath, SourceBlockedError, SourceHttpError } from './http';
export {
  NovelFullFamilySource,
  readNovelFullSource,
  novelFullSource,
  novelBinSource,
} from './readnovelfull';

export const SOURCES: Source[] = [readNovelFullSource, novelFullSource, novelBinSource];

const SOURCE_MAP = new Map<string, Source>(SOURCES.map((s) => [s.id, s]));

export function getSource(id?: string | null): Source | undefined {
  if (!id) return undefined;
  return SOURCE_MAP.get(id);
}

function stablePathHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

export function buildLocalNovelId(sourceId: string, path: string): string {
  const normalized = path.trim().replace(/\/+$/, '');
  return `${sourceId}__${stablePathHash(normalized)}`;
}

export function buildLocalChapterId(sourceId: string, path: string): string {
  const normalized = path.trim().replace(/\/+$/, '');
  return `${sourceId}_ch_${stablePathHash(normalized)}`;
}

export function extractSourceDomain(source: Source): string {
  return source.site.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
}

export function matchSourceByUrl(rawUrl: string): { source: Source; path: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let candidateUrl = trimmed;
  if (!/^https?:\/\//i.test(candidateUrl)) {
    candidateUrl = `https://${candidateUrl}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return null;
  }

  const targetHost = parsed.hostname.replace(/^www\./i, '').toLowerCase();

  for (const source of SOURCES) {
    try {
      const sourceHost = new URL(source.site).hostname.replace(/^www\./i, '').toLowerCase();
      if (targetHost === sourceHost || targetHost.endsWith(`.${sourceHost}`)) {
        const path = `${parsed.pathname}${parsed.search}` || '/';
        return { source, path };
      }
    } catch {
      // Ignore malformed site config
    }
  }

  return null;
}

export async function runSourceDiagnostic(source: Source): Promise<SourceDiagnosticResult> {
  const startedAt = Date.now();
  const steps: SourceDiagnosticStep[] = [];

  try {
    // Step 1: Search "love"
    const results = await source.search('love');
    if (results.length === 0) {
      steps.push({
        step: 'search',
        label: 'Search "love"',
        passed: false,
        detail: 'Returned 0 search results.',
      });
      return {
        sourceId: source.id,
        sourceName: source.name,
        site: source.site,
        passed: false,
        durationMs: Date.now() - startedAt,
        steps,
      };
    }

    const first = results[0];
    steps.push({
      step: 'search',
      label: 'Search "love"',
      passed: true,
      detail: `Found ${results.length} results (first: "${first.title}")`,
    });

    // Step 2: Open first result via getNovel
    let detail;
    try {
      detail = await source.getNovel(first.path);
      steps.push({
        step: 'getNovel',
        label: 'Load novel details',
        passed: true,
        detail: `Loaded "${detail.title}"`,
      });
    } catch (err: any) {
      const httpStatus = typeof err?.status === 'number' && err.status > 0 ? err.status : undefined;
      steps.push({
        step: 'getNovel',
        label: 'Load novel details',
        passed: false,
        detail: err?.message || 'Failed to load novel page.',
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      });
      return {
        sourceId: source.id,
        sourceName: source.name,
        site: source.site,
        passed: false,
        durationMs: Date.now() - startedAt,
        steps,
      };
    }

    // Step 3: Verify chapter list
    if (!detail.chapters || detail.chapters.length === 0) {
      steps.push({
        step: 'chapters',
        label: 'Load chapter list',
        passed: false,
        detail: 'Novel had 0 parsed chapters.',
      });
      return {
        sourceId: source.id,
        sourceName: source.name,
        site: source.site,
        passed: false,
        durationMs: Date.now() - startedAt,
        steps,
      };
    }

    const firstChapter = detail.chapters[0];
    steps.push({
      step: 'chapters',
      label: 'Load chapter list',
      passed: true,
      detail: `${detail.chapters.length} chapters (first: "${firstChapter.title}")`,
    });

    // Step 4: Load first chapter text
    try {
      const text = await source.getChapter(firstChapter.path);
      if (!text || text.trim().length < 20) {
        steps.push({
          step: 'getChapter',
          label: 'Load first chapter',
          passed: false,
          detail: 'Chapter text was empty or unexpectedly short.',
        });
        return {
          sourceId: source.id,
          sourceName: source.name,
          site: source.site,
          passed: false,
          durationMs: Date.now() - startedAt,
          steps,
        };
      }

      steps.push({
        step: 'getChapter',
        label: 'Load first chapter',
        passed: true,
        detail: `Loaded ${text.length.toLocaleString()} chars cleanly`,
      });
    } catch (err: any) {
      const httpStatus = typeof err?.status === 'number' && err.status > 0 ? err.status : undefined;
      steps.push({
        step: 'getChapter',
        label: 'Load first chapter',
        passed: false,
        detail: err?.message || 'Failed to load chapter text.',
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      });
      return {
        sourceId: source.id,
        sourceName: source.name,
        site: source.site,
        passed: false,
        durationMs: Date.now() - startedAt,
        steps,
      };
    }

    return {
      sourceId: source.id,
      sourceName: source.name,
      site: source.site,
      passed: true,
      durationMs: Date.now() - startedAt,
      steps,
    };
  } catch (err: any) {
    const httpStatus = typeof err?.status === 'number' && err.status > 0 ? err.status : undefined;
    steps.push({
      step: 'search',
      label: 'Search "love"',
      passed: false,
      detail: err?.message || 'Search failed.',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    });
    return {
      sourceId: source.id,
      sourceName: source.name,
      site: source.site,
      passed: false,
      durationMs: Date.now() - startedAt,
      steps,
    };
  }
}
