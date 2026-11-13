/**
 * LNReader-Style Offline Download Manager for Paper
 * Handles batch novel downloads, selected chapter downloads, pause/cancel,
 * and EPUB export via expo-sharing.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Novel, Chapter, DownloadTask } from '../types';
import { LNCrawlService } from './lncrawl';
import {
  upsertNovel,
  saveChapter,
  getChapterById,
  getDownloadedChaptersForNovel,
  getNovelById,
} from './database';
import { downloadCoverImage } from './fileStorage';

type ProgressListener = (task: DownloadTask) => void;

class DownloadManagerService {
  private activeTasks: Map<string, DownloadTask> = new Map();
  private cancelFlags: Map<string, boolean> = new Map();
  private pauseFlags: Map<string, boolean> = new Map();
  private listeners: Set<ProgressListener> = new Set();

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(task: DownloadTask) {
    this.activeTasks.set(task.novelId, task);
    this.listeners.forEach((fn) => fn(task));
  }

  getTask(novelId: string): DownloadTask | undefined {
    return this.activeTasks.get(novelId);
  }

  /**
   * Download a batch of chapters for a novel (or the entire novel)
   */
  async startDownload(
    novel: Novel,
    chaptersToDownload: Chapter[]
  ): Promise<void> {
    const novelId = novel.id;

    if (this.activeTasks.get(novelId)?.status === 'downloading') {
      return; // Already downloading
    }

    this.cancelFlags.set(novelId, false);
    this.pauseFlags.set(novelId, false);

    // 1. Ensure novel record exists in SQLite
    let localCover = novel.localCoverPath;
    if (!localCover && novel.coverUrl) {
      localCover = await downloadCoverImage(novel.id, novel.coverUrl);
    }

    await upsertNovel({
      ...novel,
      localCoverPath: localCover,
      isDownloaded: true,
    });

    const task: DownloadTask = {
      novelId,
      totalChapters: chaptersToDownload.length,
      completedChapters: 0,
      currentChapterTitle: 'Starting download...',
      status: 'downloading',
    };
    this.notify(task);

    let completed = 0;
    let lastError: string | undefined;

    for (let i = 0; i < chaptersToDownload.length; i++) {
      // Check cancellation
      if (this.cancelFlags.get(novelId)) {
        this.notify({
          ...task,
          status: 'idle',
          currentChapterTitle: 'Download cancelled',
        });
        return;
      }

      // Check pause
      while (this.pauseFlags.get(novelId)) {
        this.notify({
          ...task,
          status: 'paused',
          currentChapterTitle: 'Download paused',
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.cancelFlags.get(novelId)) {
          this.notify({
            ...task,
            status: 'idle',
            currentChapterTitle: 'Download cancelled',
          });
          return;
        }
      }

      const chapter = chaptersToDownload[i];

      task.currentChapterTitle = chapter.title || `Chapter ${chapter.serial}`;
      task.completedChapters = completed;
      task.status = 'downloading';
      this.notify(task);

      try {
        // Avoid duplicate network download if chapter is already saved locally
        const existing = await getChapterById(chapter.id);
        if (existing?.isDownloaded && existing.content && existing.content.trim().length > 0) {
          completed++;
          task.completedChapters = completed;
          this.notify(task);
          continue;
        }

        // Fetch chapter body from LNCrawl if not already present
        let content = chapter.content;
        let fetchedTitle = chapter.title;
        let fetchedWordCount = chapter.wordsCount;

        if (!content) {
          const fetched = await LNCrawlService.fetchChapterContent(chapter.id);
          content = fetched.content;
          if (fetched.title && fetched.title !== 'Chapter Content') {
            fetchedTitle = fetched.title;
          }
          if (typeof fetched.wordCount === 'number') {
            fetchedWordCount = fetched.wordCount;
          }
        }

        // Save into app-private SQLite database
        await saveChapter({
          ...chapter,
          title: fetchedTitle,
          content,
          wordsCount: fetchedWordCount,
          isDownloaded: true,
        });

        completed++;
        task.completedChapters = completed;
        this.notify(task);

        // Friendly interval between chapter requests
        await new Promise((r) => setTimeout(r, 80));
      } catch (err: any) {
        console.warn(`Failed downloading chapter ${chapter.id}:`, err);
        lastError = err?.message || 'Download error';
        // Stop immediately on 401 Unauthorized
        if (err?.status === 401) {
          this.notify({
            novelId,
            totalChapters: chaptersToDownload.length,
            completedChapters: completed,
            currentChapterTitle: lastError || 'Authentication required',
            status: 'failed',
            error: lastError,
          });
          return;
        }
      }
    }

    if (completed === 0 && chaptersToDownload.length > 0 && lastError) {
      this.notify({
        novelId,
        totalChapters: chaptersToDownload.length,
        completedChapters: 0,
        currentChapterTitle: lastError,
        status: 'failed',
        error: lastError,
      });
      return;
    }

    this.notify({
      novelId,
      totalChapters: chaptersToDownload.length,
      completedChapters: completed,
      currentChapterTitle: 'All chapters downloaded!',
      status: 'completed',
    });

    // Clear after 3 seconds
    setTimeout(() => {
      this.activeTasks.delete(novelId);
      this.notify({
        novelId,
        totalChapters: chaptersToDownload.length,
        completedChapters: completed,
        currentChapterTitle: '',
        status: 'idle',
      });
    }, 3000);
  }

  /**
   * Download a single chapter (e.g. from reader header button)
   */
  async downloadSingleChapter(novel: Novel, chapter: Chapter): Promise<Chapter> {
    const existing = await getChapterById(chapter.id);
    if (existing?.isDownloaded && existing.content && existing.content.trim().length > 0) {
      return existing;
    }

    let content = chapter.content;
    let fetchedTitle = chapter.title;
    let fetchedWordCount = chapter.wordsCount;

    if (!content) {
      const fetched = await LNCrawlService.fetchChapterContent(chapter.id);
      content = fetched.content;
      if (fetched.title && fetched.title !== 'Chapter Content') {
        fetchedTitle = fetched.title;
      }
      if (typeof fetched.wordCount === 'number') {
        fetchedWordCount = fetched.wordCount;
      }
    }

    // Save novel metadata if not already present
    await upsertNovel(novel);

    // Save chapter to SQLite
    const updatedChapter: Chapter = {
      ...chapter,
      title: fetchedTitle,
      content,
      wordsCount: fetchedWordCount,
      isDownloaded: true,
    };
    await saveChapter(updatedChapter);

    return updatedChapter;
  }

  pauseDownload(novelId: string) {
    this.pauseFlags.set(novelId, true);
  }

  resumeDownload(novelId: string) {
    this.pauseFlags.set(novelId, false);
  }

  cancelDownload(novelId: string) {
    this.cancelFlags.set(novelId, true);
    this.pauseFlags.set(novelId, false);
  }

  /**
   * Export all downloaded chapters of a novel as a readable offline document/EPUB
   * and open the system share sheet.
   */
  async exportNovelAsEpub(novelId: string): Promise<string> {
    const novel = await getNovelById(novelId);
    if (!novel) throw new Error('Novel not found in local library');

    const chapters = await getDownloadedChaptersForNovel(novelId);
    if (chapters.length === 0) {
      throw new Error('No downloaded chapters available to export. Download chapters first.');
    }

    const safeTitle = (novel.title || 'novel').replace(/[^a-zA-Z0-9_-]/g, '_');
    const exportsDir = `${FileSystem.documentDirectory || ''}exports/`;
    const filePath = `${exportsDir}${safeTitle}_Paper_Archive.html`;

    if (Platform.OS !== 'web' && FileSystem.documentDirectory) {
      const dirInfo = await FileSystem.getInfoAsync(exportsDir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(exportsDir, { intermediates: true });
      }
    }

    // Generate a standalone, styled, portable HTML book
    let htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${novel.title}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 0 auto; padding: 2rem 1rem; line-height: 1.8; color: #1a1a1a; background: #FAF8F5; }
    h1 { font-size: 2rem; border-bottom: 2px solid #ddd; padding-bottom: 0.5rem; }
    h2 { font-size: 1.5rem; margin-top: 3rem; color: #0284C7; border-bottom: 1px solid #eee; }
    .author { font-style: italic; color: #666; margin-bottom: 1.5rem; }
    .synopsis { background: #f0ede6; padding: 1rem; border-radius: 8px; margin-bottom: 2rem; }
    p { margin-bottom: 1.2rem; }
  </style>
</head>
<body>
  <h1>${novel.title}</h1>
  <div class="author">By ${novel.author}</div>
  <div class="synopsis"><strong>Synopsis:</strong><br>${novel.synopsis}</div>
  <hr>
`;

    for (const ch of chapters) {
      htmlContent += `
  <section class="chapter">
    <h2>Chapter ${ch.serial}: ${ch.title}</h2>
    ${(ch.content || 'No text')
      .split('\n\n')
      .map((p) => `<p>${p.trim()}</p>`)
      .join('\n')}
  </section>
`;
    }

    htmlContent += `
</body>
</html>`;

    if (Platform.OS === 'web' || !FileSystem.documentDirectory) {
      return `${safeTitle}_Paper_Archive.html`;
    }

    await FileSystem.writeAsStringAsync(filePath, htmlContent, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    // Check if sharing is available
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(filePath, {
        mimeType: 'text/html',
        dialogTitle: `Export ${novel.title}`,
        UTI: 'public.html',
      });
    }

    return filePath;
  }
}

export const DownloadManager = new DownloadManagerService();
