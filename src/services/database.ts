/**
 * SQLite Database Service for Paper Light Novel Reader
 * Handles app-private storage of novels, full chapter texts, and reading progress using expo-sqlite.
 * Uses AsyncStorage fallback when previewed on web (`Platform.OS === 'web'`).
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type * as SQLite from 'expo-sqlite';
import { Novel, Chapter, ReadingProgress } from '../types';

type NovelRow = {
  id: string;
  title: string;
  author: string | null;
  synopsis: string | null;
  cover_url: string | null;
  local_cover_path: string | null;
  genres: string | null;
  status: string | null;
  total_chapters: number | null;
  is_downloaded: number | null;
  provider: string | null;
  path: string | null;
  source_domain: string | null;
  updated_at: number | null;
  downloaded_count?: number;
};

type ChapterRow = {
  id: string;
  novel_id: string;
  serial: number;
  title: string;
  content: string | null;
  is_downloaded: number;
  provider: string | null;
  path: string | null;
  words_count: number | null;
  release_date: string | null;
};

type ProgressRow = {
  novel_id: string;
  chapter_id: string;
  chapter_title: string;
  chapter_serial: number;
  scroll_offset: number;
  scroll_percentage: number;
  updated_at: number;
};

const WEB_KEYS = {
  NOVELS: '@paper_web_novels',
  CHAPTERS: '@paper_web_chapters',
  PROGRESS: '@paper_web_progress',
};

async function readWebMap<T>(key: string): Promise<Record<string, T>> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeWebMap<T>(key: string, map: Record<string, T>): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(map));
}

export async function getAllChaptersForWeb(): Promise<Chapter[]> {
  const map = await readWebMap<Chapter>(WEB_KEYS.CHAPTERS);
  return Object.values(map).map((ch) => ({
    ...ch,
    provider: ch.provider || 'lncrawl',
  }));
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (Platform.OS === 'web') {
    return null as unknown as SQLite.SQLiteDatabase;
  }
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        const sqliteModule = require('expo-sqlite') as typeof SQLite;
        const db = await sqliteModule.openDatabaseAsync('paper_library.db');
        await initSchema(db);
        return db;
      } catch (err) {
        dbPromise = null;
        throw err;
      }
    })();
  }
  return dbPromise;
}

async function ensureColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS novels (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      synopsis TEXT,
      cover_url TEXT,
      local_cover_path TEXT,
      genres TEXT,
      status TEXT,
      total_chapters INTEGER DEFAULT 0,
      is_downloaded INTEGER DEFAULT 0,
      provider TEXT DEFAULT 'lncrawl',
      path TEXT,
      source_domain TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      serial INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      is_downloaded INTEGER DEFAULT 0,
      provider TEXT DEFAULT 'lncrawl',
      path TEXT,
      words_count INTEGER,
      release_date TEXT,
      FOREIGN KEY (novel_id) REFERENCES novels (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      novel_id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL,
      chapter_title TEXT NOT NULL,
      chapter_serial INTEGER NOT NULL,
      scroll_offset REAL DEFAULT 0,
      scroll_percentage REAL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chapters_novel_id ON chapters (novel_id);
    CREATE INDEX IF NOT EXISTS idx_chapters_serial ON chapters (novel_id, serial);
  `);

  // Safe migrations for pre-existing databases (preserves all existing rows as provider 'lncrawl')
  await ensureColumn(db, 'novels', 'provider', `TEXT DEFAULT 'lncrawl'`);
  await ensureColumn(db, 'novels', 'path', 'TEXT');
  await ensureColumn(db, 'novels', 'source_domain', 'TEXT');
  await ensureColumn(db, 'chapters', 'provider', `TEXT DEFAULT 'lncrawl'`);
  await ensureColumn(db, 'chapters', 'path', 'TEXT');

  await db.execAsync(`
    UPDATE novels SET provider = 'lncrawl' WHERE provider IS NULL;
    UPDATE chapters SET provider = 'lncrawl' WHERE provider IS NULL;
  `);
}

function mapNovelRow(row: NovelRow, forceDownloaded?: boolean): Novel {
  return {
    id: row.id,
    title: row.title,
    author: row.author || 'Unknown',
    synopsis: row.synopsis || '',
    coverUrl: row.cover_url || '',
    localCoverPath: row.local_cover_path,
    genres: JSON.parse(row.genres || '[]'),
    status: (row.status as any) || 'Ongoing',
    totalChapters: row.total_chapters || 0,
    downloadedChaptersCount: row.downloaded_count || 0,
    isDownloaded: forceDownloaded ? true : row.is_downloaded === 1,
    provider: row.provider || 'lncrawl',
    path: row.path || undefined,
    sourceDomain: row.source_domain || undefined,
    updatedAt: row.updated_at || 0,
  };
}

// ==========================================
// NOVEL OPERATIONS
// ==========================================

export async function upsertNovel(novel: Novel): Promise<void> {
  const now = Date.now();
  const provider = novel.provider || 'lncrawl';
  const novelPath = novel.path || novel.url || null;

  if (Platform.OS === 'web') {
    const map = await readWebMap<Novel>(WEB_KEYS.NOVELS);
    const existing = map[novel.id];
    map[novel.id] = {
      ...existing,
      ...novel,
      provider: novel.provider || existing?.provider || 'lncrawl',
      path: novel.path || novel.url || existing?.path,
      sourceDomain: novel.sourceDomain || existing?.sourceDomain,
      localCoverPath: novel.localCoverPath ?? existing?.localCoverPath ?? null,
      isDownloaded: Boolean(novel.isDownloaded || existing?.isDownloaded),
      updatedAt: now,
    };
    await writeWebMap(WEB_KEYS.NOVELS, map);
    return;
  }

  const db = await getDatabase();
  const genresJson = JSON.stringify(novel.genres || []);

  await db.runAsync(
    `INSERT INTO novels (id, title, author, synopsis, cover_url, local_cover_path, genres, status, total_chapters, is_downloaded, provider, path, source_domain, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       author = excluded.author,
       synopsis = excluded.synopsis,
       cover_url = CASE WHEN excluded.cover_url IS NOT NULL AND excluded.cover_url != '' THEN excluded.cover_url ELSE novels.cover_url END,
       local_cover_path = COALESCE(excluded.local_cover_path, novels.local_cover_path),
       genres = excluded.genres,
       status = excluded.status,
       total_chapters = excluded.total_chapters,
       is_downloaded = MAX(novels.is_downloaded, excluded.is_downloaded),
       provider = COALESCE(excluded.provider, novels.provider, 'lncrawl'),
       path = COALESCE(excluded.path, novels.path),
       source_domain = COALESCE(excluded.source_domain, novels.source_domain),
       updated_at = excluded.updated_at`,
    [
      novel.id,
      novel.title,
      novel.author || 'Unknown',
      novel.synopsis || '',
      novel.coverUrl || '',
      novel.localCoverPath || null,
      genresJson,
      novel.status || 'Ongoing',
      novel.totalChapters || 0,
      novel.isDownloaded ? 1 : 0,
      provider,
      novelPath,
      novel.sourceDomain || null,
      now,
    ]
  );
}

export async function getNovelById(id: string): Promise<Novel | null> {
  if (Platform.OS === 'web') {
    const [novelsMap, chaptersMap] = await Promise.all([
      readWebMap<Novel>(WEB_KEYS.NOVELS),
      readWebMap<Chapter>(WEB_KEYS.CHAPTERS),
    ]);
    const novel = novelsMap[id];
    if (!novel) return null;
    const downloadedCount = Object.values(chaptersMap).filter(
      (c) => c.novelId === id && c.isDownloaded
    ).length;
    return {
      ...novel,
      provider: novel.provider || 'lncrawl',
      downloadedChaptersCount: downloadedCount,
      isDownloaded: Boolean(novel.isDownloaded || downloadedCount > 0),
    };
  }

  const db = await getDatabase();
  const row = await db.getFirstAsync<NovelRow>(
    `SELECT n.*,
      (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND c.is_downloaded = 1) as downloaded_count
     FROM novels n WHERE n.id = ?`,
    [id]
  );

  if (!row) return null;

  return mapNovelRow(row);
}

export async function getAllNovels(): Promise<Novel[]> {
  if (Platform.OS === 'web') {
    const [novelsMap, chaptersMap] = await Promise.all([
      readWebMap<Novel>(WEB_KEYS.NOVELS),
      readWebMap<Chapter>(WEB_KEYS.CHAPTERS),
    ]);
    const allChapters = Object.values(chaptersMap);
    return Object.values(novelsMap)
      .map((n) => ({
        ...n,
        provider: n.provider || 'lncrawl',
        downloadedChaptersCount: allChapters.filter(
          (c) => c.novelId === n.id && c.isDownloaded
        ).length,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  const db = await getDatabase();
  const rows = await db.getAllAsync<NovelRow>(
    `SELECT n.*,
      (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND c.is_downloaded = 1) as downloaded_count
     FROM novels n ORDER BY n.updated_at DESC`
  );

  return rows.map((row: NovelRow) => mapNovelRow(row));
}

export async function getDownloadedNovels(): Promise<Novel[]> {
  if (Platform.OS === 'web') {
    const all = await getAllNovels();
    return all.filter((n) => (n.downloadedChaptersCount || 0) > 0);
  }

  const db = await getDatabase();
  const rows = await db.getAllAsync<NovelRow>(
    `SELECT n.*,
      (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND c.is_downloaded = 1) as downloaded_count
     FROM novels n
     WHERE (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND c.is_downloaded = 1) > 0
     ORDER BY n.updated_at DESC`
  );

  return rows.map((row: NovelRow) => mapNovelRow(row, true));
}

export async function deleteNovel(id: string): Promise<void> {
  if (Platform.OS === 'web') {
    const [novelsMap, chaptersMap, progressMap] = await Promise.all([
      readWebMap<Novel>(WEB_KEYS.NOVELS),
      readWebMap<Chapter>(WEB_KEYS.CHAPTERS),
      readWebMap<ReadingProgress>(WEB_KEYS.PROGRESS),
    ]);
    delete novelsMap[id];
    delete progressMap[id];
    for (const [cid, ch] of Object.entries(chaptersMap)) {
      if (ch.novelId === id) delete chaptersMap[cid];
    }
    await Promise.all([
      writeWebMap(WEB_KEYS.NOVELS, novelsMap),
      writeWebMap(WEB_KEYS.CHAPTERS, chaptersMap),
      writeWebMap(WEB_KEYS.PROGRESS, progressMap),
    ]);
    return;
  }

  const db = await getDatabase();
  await db.runAsync(`DELETE FROM chapters WHERE novel_id = ?`, [id]);
  await db.runAsync(`DELETE FROM reading_progress WHERE novel_id = ?`, [id]);
  await db.runAsync(`DELETE FROM novels WHERE id = ?`, [id]);
}

// ==========================================
// CHAPTER OPERATIONS (OFFLINE DATABASE)
// ==========================================

export async function saveChapter(chapter: Chapter): Promise<void> {
  const hasContent = Boolean(chapter.content && chapter.content.trim().length > 0);
  const provider = chapter.provider || 'lncrawl';
  const chapterPath = chapter.path || chapter.url || null;

  if (Platform.OS === 'web') {
    const map = await readWebMap<Chapter>(WEB_KEYS.CHAPTERS);
    const existing = map[chapter.id];
    map[chapter.id] = {
      ...existing,
      ...chapter,
      provider: chapter.provider || existing?.provider || 'lncrawl',
      path: chapter.path || chapter.url || existing?.path,
      content: chapter.content ?? existing?.content ?? null,
      isDownloaded: hasContent || Boolean(existing?.isDownloaded) || Boolean(chapter.isDownloaded),
    };
    await writeWebMap(WEB_KEYS.CHAPTERS, map);
    if (hasContent) {
      const novelsMap = await readWebMap<Novel>(WEB_KEYS.NOVELS);
      if (novelsMap[chapter.novelId]) {
        novelsMap[chapter.novelId].isDownloaded = true;
        await writeWebMap(WEB_KEYS.NOVELS, novelsMap);
      }
    }
    return;
  }

  const db = await getDatabase();

  await db.runAsync(
    `INSERT INTO chapters (id, novel_id, serial, title, content, is_downloaded, provider, path, words_count, release_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       serial = excluded.serial,
       title = excluded.title,
       content = COALESCE(excluded.content, chapters.content),
       is_downloaded = CASE WHEN excluded.content IS NOT NULL THEN 1 ELSE chapters.is_downloaded END,
       provider = COALESCE(excluded.provider, chapters.provider, 'lncrawl'),
       path = COALESCE(excluded.path, chapters.path),
       words_count = excluded.words_count,
       release_date = excluded.release_date`,
    [
      chapter.id,
      chapter.novelId,
      chapter.serial,
      chapter.title,
      chapter.content || null,
      hasContent ? 1 : chapter.isDownloaded ? 1 : 0,
      provider,
      chapterPath,
      chapter.wordsCount || 0,
      chapter.releaseDate || '',
    ]
  );

  if (hasContent) {
    await db.runAsync(`UPDATE novels SET is_downloaded = 1 WHERE id = ?`, [chapter.novelId]);
  }
}

export async function saveChaptersBatch(chapters: Chapter[]): Promise<void> {
  if (Platform.OS === 'web') {
    const map = await readWebMap<Chapter>(WEB_KEYS.CHAPTERS);
    for (const ch of chapters) {
      const existing = map[ch.id];
      const hasContent = Boolean(ch.content && ch.content.trim().length > 0);
      map[ch.id] = {
        ...existing,
        ...ch,
        provider: ch.provider || existing?.provider || 'lncrawl',
        path: ch.path || ch.url || existing?.path,
        content: ch.content ?? existing?.content ?? null,
        isDownloaded: hasContent || Boolean(existing?.isDownloaded) || Boolean(ch.isDownloaded),
      };
    }
    await writeWebMap(WEB_KEYS.CHAPTERS, map);
    return;
  }

  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const ch of chapters) {
      const hasContent = Boolean(ch.content && ch.content.trim().length > 0);
      const provider = ch.provider || 'lncrawl';
      const chapterPath = ch.path || ch.url || null;
      await txn.runAsync(
        `INSERT INTO chapters (id, novel_id, serial, title, content, is_downloaded, provider, path, words_count, release_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           serial = excluded.serial,
           title = excluded.title,
           content = COALESCE(excluded.content, chapters.content),
           is_downloaded = CASE WHEN excluded.content IS NOT NULL THEN 1 ELSE chapters.is_downloaded END,
           provider = COALESCE(excluded.provider, chapters.provider, 'lncrawl'),
           path = COALESCE(excluded.path, chapters.path),
           words_count = excluded.words_count,
           release_date = excluded.release_date`,
        [
          ch.id,
          ch.novelId,
          ch.serial,
          ch.title,
          ch.content || null,
          hasContent ? 1 : ch.isDownloaded ? 1 : 0,
          provider,
          chapterPath,
          ch.wordsCount || 0,
          ch.releaseDate || '',
        ]
      );
      if (hasContent) {
        await txn.runAsync(`UPDATE novels SET is_downloaded = 1 WHERE id = ?`, [ch.novelId]);
      }
    }
  });
}

export async function getChapterById(id: string): Promise<Chapter | null> {
  if (Platform.OS === 'web') {
    const map = await readWebMap<Chapter>(WEB_KEYS.CHAPTERS);
    const ch = map[id];
    return ch ? { ...ch, provider: ch.provider || 'lncrawl' } : null;
  }

  const db = await getDatabase();
  const row = await db.getFirstAsync<ChapterRow>(`SELECT * FROM chapters WHERE id = ?`, [id]);
  if (!row) return null;

  return {
    id: row.id,
    novelId: row.novel_id,
    serial: row.serial,
    title: row.title,
    content: row.content,
    isDownloaded: row.is_downloaded === 1,
    provider: row.provider || 'lncrawl',
    path: row.path || undefined,
    wordsCount: row.words_count || 0,
    releaseDate: row.release_date || '',
  };
}

export async function getChaptersForNovel(novelId: string): Promise<Chapter[]> {
  if (Platform.OS === 'web') {
    const map = await readWebMap<Chapter>(WEB_KEYS.CHAPTERS);
    return Object.values(map)
      .filter((c) => c.novelId === novelId)
      .map((c) => ({ ...c, provider: c.provider || 'lncrawl' }))
      .sort((a, b) => a.serial - b.serial);
  }

  const db = await getDatabase();
  const rows = await db.getAllAsync<ChapterRow>(
    `SELECT id, novel_id, serial, title, is_downloaded, provider, path, words_count, release_date
     FROM chapters WHERE novel_id = ? ORDER BY serial ASC`,
    [novelId]
  );

  return rows.map((r: ChapterRow) => ({
    id: r.id,
    novelId: r.novel_id,
    serial: r.serial,
    title: r.title,
    isDownloaded: r.is_downloaded === 1,
    provider: r.provider || 'lncrawl',
    path: r.path || undefined,
    wordsCount: r.words_count || 0,
    releaseDate: r.release_date || '',
  }));
}

export async function getDownloadedChaptersForNovel(novelId: string): Promise<Chapter[]> {
  if (Platform.OS === 'web') {
    const map = await readWebMap<Chapter>(WEB_KEYS.CHAPTERS);
    return Object.values(map)
      .filter((c) => c.novelId === novelId && c.isDownloaded)
      .map((c) => ({ ...c, provider: c.provider || 'lncrawl' }))
      .sort((a, b) => a.serial - b.serial);
  }

  const db = await getDatabase();
  const rows = await db.getAllAsync<ChapterRow>(
    `SELECT * FROM chapters WHERE novel_id = ? AND is_downloaded = 1 ORDER BY serial ASC`,
    [novelId]
  );

  return rows.map((r: ChapterRow) => ({
    id: r.id,
    novelId: r.novel_id,
    serial: r.serial,
    title: r.title,
    content: r.content,
    isDownloaded: true,
    provider: r.provider || 'lncrawl',
    path: r.path || undefined,
    wordsCount: r.words_count || 0,
    releaseDate: r.release_date || '',
  }));
}

export async function deleteDownloadedChapters(novelId: string): Promise<void> {
  if (Platform.OS === 'web') {
    const [chaptersMap, novelsMap] = await Promise.all([
      readWebMap<Chapter>(WEB_KEYS.CHAPTERS),
      readWebMap<Novel>(WEB_KEYS.NOVELS),
    ]);
    for (const ch of Object.values(chaptersMap)) {
      if (ch.novelId === novelId) {
        ch.content = null;
        ch.isDownloaded = false;
      }
    }
    if (novelsMap[novelId]) {
      novelsMap[novelId].isDownloaded = false;
    }
    await Promise.all([
      writeWebMap(WEB_KEYS.CHAPTERS, chaptersMap),
      writeWebMap(WEB_KEYS.NOVELS, novelsMap),
    ]);
    return;
  }

  const db = await getDatabase();
  await db.runAsync(
    `UPDATE chapters SET content = NULL, is_downloaded = 0 WHERE novel_id = ?`,
    [novelId]
  );
  await db.runAsync(`UPDATE novels SET is_downloaded = 0 WHERE id = ?`, [novelId]);
}

// ==========================================
// READING PROGRESS & SCROLL MEMORY
// ==========================================

export async function saveReadingProgress(progress: ReadingProgress): Promise<void> {
  if (Platform.OS === 'web') {
    const map = await readWebMap<ReadingProgress>(WEB_KEYS.PROGRESS);
    map[progress.novelId] = progress;
    await writeWebMap(WEB_KEYS.PROGRESS, map);
    return;
  }

  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO reading_progress (novel_id, chapter_id, chapter_title, chapter_serial, scroll_offset, scroll_percentage, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(novel_id) DO UPDATE SET
       chapter_id = excluded.chapter_id,
       chapter_title = excluded.chapter_title,
       chapter_serial = excluded.chapter_serial,
       scroll_offset = excluded.scroll_offset,
       scroll_percentage = excluded.scroll_percentage,
       updated_at = excluded.updated_at`,
    [
      progress.novelId,
      progress.chapterId,
      progress.chapterTitle,
      progress.chapterSerial,
      progress.scrollOffset,
      progress.scrollPercentage,
      progress.updatedAt,
    ]
  );
}

export async function getReadingProgress(novelId: string): Promise<ReadingProgress | null> {
  if (Platform.OS === 'web') {
    const map = await readWebMap<ReadingProgress>(WEB_KEYS.PROGRESS);
    return map[novelId] || null;
  }

  const db = await getDatabase();
  const row = await db.getFirstAsync<ProgressRow>(
    `SELECT * FROM reading_progress WHERE novel_id = ?`,
    [novelId]
  );

  if (!row) return null;

  return {
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title,
    chapterSerial: row.chapter_serial,
    scrollOffset: row.scroll_offset || 0,
    scrollPercentage: row.scroll_percentage || 0,
    updatedAt: row.updated_at,
  };
}

export async function getAllReadingProgress(): Promise<ReadingProgress[]> {
  if (Platform.OS === 'web') {
    const map = await readWebMap<ReadingProgress>(WEB_KEYS.PROGRESS);
    return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const db = await getDatabase();
  const rows = await db.getAllAsync<ProgressRow>(
    `SELECT * FROM reading_progress ORDER BY updated_at DESC`
  );

  return rows.map((r: ProgressRow) => ({
    novelId: r.novel_id,
    chapterId: r.chapter_id,
    chapterTitle: r.chapter_title,
    chapterSerial: r.chapter_serial,
    scrollOffset: r.scroll_offset || 0,
    scrollPercentage: r.scroll_percentage || 0,
    updatedAt: r.updated_at,
  }));
}
