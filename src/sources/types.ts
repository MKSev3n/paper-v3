export interface SearchItem {
  title: string;
  path: string;
  cover?: string;
  author?: string;
  sourceId: string;
}

export type ListingKind = 'hot' | 'popular' | 'latest';

export interface ChapterItem {
  title: string;
  path: string;
  index: number;
}

export interface NovelDetail {
  title: string;
  cover?: string;
  author?: string;
  summary?: string;
  status?: string;
  chapters: ChapterItem[];
}

export interface Source {
  id: string;
  name: string;
  site: string;
  search(query: string): Promise<SearchItem[]>;
  getByGenre(genre: string, page?: number): Promise<SearchItem[]>;
  getListing(kind: ListingKind, page?: number): Promise<SearchItem[]>;
  getNovel(path: string): Promise<NovelDetail>;
  getChapter(path: string): Promise<string>;
  /**
   * Optional richer chapter fetch that also returns the chapter title parsed
   * from the chapter heading. Sources that can extract a clean title implement
   * this; callers fall back to `getChapter` when it is absent.
   */
  getChapterDetail?(path: string): Promise<{ title: string; content: string }>;
}

export interface SourceDiagnosticStep {
  step: 'search' | 'getNovel' | 'chapters' | 'getChapter';
  label: string;
  passed: boolean;
  detail: string;
  httpStatus?: number;
}

export interface SourceDiagnosticResult {
  sourceId: string;
  sourceName: string;
  site: string;
  passed: boolean;
  durationMs: number;
  steps: SourceDiagnosticStep[];
}
