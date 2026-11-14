export interface SearchItem {
  title: string;
  path: string;
  cover?: string;
  author?: string;
  sourceId: string;
}

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
  getNovel(path: string): Promise<NovelDetail>;
  getChapter(path: string): Promise<string>;
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
