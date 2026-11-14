/**
 * LNReader-Style Offline Download Manager for Paper
 * Supports both serverless local sources (concurrency 2, 400ms spacing, 2 retries)
 * and LNCrawl server fetch-chapters jobs (batches of 15), persisting all chapters in SQLite.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Novel, Chapter, DownloadTask } from '../types';
import { APP_CONFIG } from '../config';
import { LNCrawlService } from './lncrawl';
import { getSource, Source } from '../sources';
import {
  upsertNovel,
  saveChapter,
  getChapterById,
  getDownloadedChaptersForNovel,
  getNovelById,
} from './database';
import { downloadCoverImage } from './fileStorage';

type ProgressListener = (task: DownloadTask) => void;

const CHAPTER_BATCH_SIZE = 15; // Within 10-25 chapters per LNCrawl fetch-chapters job
const BATCH_JOB_TIMEOUT_MS = 120000;
const LOCAL_CONCURRENCY = 2;
const LOCAL_REQUEST_DELAY_MS = 400;
const LOCAL_MAX_RETRIES = 2;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

class DownloadManagerService {
  private activeTasks: Map<string, DownloadTask> = new Map();
  private cancelFlags: Map<string, boolean> = new Map();
  private pauseFlags: Map<string, boolean> = new Map();
  private activeRemoteJobs: Map<string, string> = new Map();
  private chapterFailuresByNovel: Map<string, Record<string, string>> = new Map();
  private listeners: Set<ProgressListener> = new Set();

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(task: DownloadTask) {
    const snapshot: DownloadTask = {
      ...task,
      failedChapterIds: task.failedChapterIds ? [...task.failedChapterIds] : [],
      chapterErrors: task.chapterErrors ? { ...task.chapterErrors } : {},
    };
    this.activeTasks.set(task.novelId, snapshot);
    this.listeners.forEach((fn) => fn(snapshot));
  }

  getTask(novelId: string): DownloadTask | undefined {
    return this.activeTasks.get(novelId);
  }

  getChapterErrors(novelId: string): Record<string, string> {
    return { ...(this.chapterFailuresByNovel.get(novelId) || {}) };
  }

  clearChapterError(novelId: string, chapterId: string) {
    const map = this.chapterFailuresByNovel.get(novelId);
    if (map && map[chapterId]) {
      delete map[chapterId];
    }
  }

  private async waitIfPaused(novelId: string, task: DownloadTask): Promise<'ok' | 'cancelled'> {
    if (this.cancelFlags.get(novelId)) {
      return 'cancelled';
    }
    while (this.pauseFlags.get(novelId)) {
      this.notify({
        ...task,
        status: 'paused',
        currentChapterTitle: 'Download paused',
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (this.cancelFlags.get(novelId)) {
        return 'cancelled';
      }
    }
    return 'ok';
  }

  private async fetchLocalChapterWithRetries(
    source: Source,
    chapterPath: string,
    novelId?: string
  ): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= LOCAL_MAX_RETRIES; attempt++) {
      if (novelId && this.cancelFlags.get(novelId)) {
        throw new Error('Download cancelled');
      }
      try {
        const text = await source.getChapter(chapterPath);
        if (!text || text.trim().length === 0) {
          throw new Error('Chapter content was empty.');
        }
        return text;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err || 'Chapter fetch failed'));
        if (attempt < LOCAL_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, LOCAL_REQUEST_DELAY_MS * (attempt + 1)));
        }
      }
    }
    throw lastError || new Error('Failed to fetch chapter from source.');
  }

  private async downloadWithLocalSource(
    novel: Novel,
    source: Source,
    pendingChapters: Chapter[],
    task: DownloadTask,
    initialCompleted: number,
    existingErrors: Record<string, string>
  ): Promise<{ completed: number; failedIds: string[]; cancelled: boolean }> {
    const novelId = novel.id;
    let completed = initialCompleted;
    const failedIds: string[] = [];
    let nextIndex = 0;
    let cancelled = false;

    // Rate-limit gate ensuring at least 400ms between request starts across both concurrent workers
    let lastDispatchAt = 0;
    let gateChain: Promise<void> = Promise.resolve();

    const waitForRateLimitSlot = async () => {
      const current = gateChain.then(async () => {
        const elapsed = Date.now() - lastDispatchAt;
        if (elapsed < LOCAL_REQUEST_DELAY_MS) {
          await new Promise((r) => setTimeout(r, LOCAL_REQUEST_DELAY_MS - elapsed));
        }
        lastDispatchAt = Date.now();
      });
      gateChain = current.catch(() => {});
      await current;
    };

    const worker = async () => {
      while (true) {
        if ((await this.waitIfPaused(novelId, task)) === 'cancelled') {
          cancelled = true;
          return;
        }

        const idx = nextIndex++;
        if (idx >= pendingChapters.length) {
          return;
        }

        const chapter = pendingChapters[idx];
        const chapterPath = chapter.path || chapter.url;

        task.status = 'downloading';
        task.currentChapterTitle = chapter.title || `Chapter ${chapter.serial}`;
        this.notify(task);

        await waitForRateLimitSlot();

        if ((await this.waitIfPaused(novelId, task)) === 'cancelled') {
          cancelled = true;
          return;
        }

        try {
          if (!chapterPath) {
            throw new Error('Chapter path is missing.');
          }
          const content = await this.fetchLocalChapterWithRetries(source, chapterPath, novelId);
          await saveChapter({
            ...chapter,
            provider: source.id,
            path: chapterPath,
            content,
            wordsCount: countWords(content),
            isDownloaded: true,
          });
          delete existingErrors[chapter.id];
          completed++;
        } catch (chErr: any) {
          if (this.cancelFlags.get(novelId)) {
            cancelled = true;
            return;
          }
          const msg = chErr?.message || 'Failed to save chapter';
          console.warn(`Failed downloading local chapter ${chapter.id}:`, chErr);
          failedIds.push(chapter.id);
          existingErrors[chapter.id] = msg;
        }

        this.chapterFailuresByNovel.set(novelId, { ...existingErrors });
        task.completedChapters = completed;
        task.failedChapters = failedIds.length;
        task.failedChapterIds = [...failedIds];
        task.chapterErrors = { ...existingErrors };
        this.notify(task);
      }
    };

    const workerCount = Math.min(LOCAL_CONCURRENCY, pendingChapters.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { completed, failedIds, cancelled };
  }

  /**
   * Download a batch of chapters for a novel (or the entire novel)
   */
  async startDownload(novel: Novel, chaptersToDownload: Chapter[]): Promise<void> {
    const novelId = novel.id;

    if (this.activeTasks.get(novelId)?.status === 'downloading') {
      return; // Already downloading
    }

    this.cancelFlags.set(novelId, false);
    this.pauseFlags.set(novelId, false);

    // 1. Ensure novel record exists in SQLite (without prematurely marking isDownloaded: true)
    let localCover = novel.localCoverPath;
    if (!localCover && novel.coverUrl) {
      localCover = await downloadCoverImage(novel.id, novel.coverUrl);
    }

    await upsertNovel({
      ...novel,
      provider: novel.provider || 'lncrawl',
      localCoverPath: localCover,
      isDownloaded: Boolean(novel.isDownloaded),
    });

    const existingErrors = { ...(this.chapterFailuresByNovel.get(novelId) || {}) };
    const task: DownloadTask = {
      novelId,
      totalChapters: chaptersToDownload.length,
      completedChapters: 0,
      failedChapters: 0,
      failedChapterIds: [],
      chapterErrors: existingErrors,
      currentChapterTitle: 'Checking local chapters...',
      status: 'downloading',
    };
    this.notify(task);

    let completed = 0;
    const pendingChapters: Chapter[] = [];

    for (const ch of chaptersToDownload) {
      if (this.cancelFlags.get(novelId)) {
        this.notify({ ...task, status: 'idle', currentChapterTitle: 'Download cancelled' });
        return;
      }
      const existing = await getChapterById(ch.id);
      if (existing?.isDownloaded && existing.content && existing.content.trim().length > 0) {
        completed++;
        delete existingErrors[ch.id];
      } else {
        pendingChapters.push(ch);
      }
    }

    task.completedChapters = completed;
    this.chapterFailuresByNovel.set(novelId, existingErrors);
    this.notify(task);

    if (pendingChapters.length === 0) {
      this.notify({
        ...task,
        completedChapters: completed,
        currentChapterTitle: 'All chapters already downloaded!',
        status: 'completed',
      });
      setTimeout(() => {
        this.activeTasks.delete(novelId);
        this.notify({
          ...task,
          completedChapters: completed,
          currentChapterTitle: '',
          status: 'idle',
        });
      }, 2500);
      return;
    }

    let failedIds: string[] = [];
    const localSource = getSource(novel.provider);

    if (localSource) {
      const outcome = await this.downloadWithLocalSource(
        novel,
        localSource,
        pendingChapters,
        task,
        completed,
        existingErrors
      );
      completed = outcome.completed;
      failedIds = outcome.failedIds;

      if (outcome.cancelled) {
        this.notify({ ...task, status: 'idle', currentChapterTitle: 'Download cancelled' });
        return;
      }
    } else {
      // LNCrawl server fetch-chapters flow
      const batches: Chapter[][] = [];
      for (let i = 0; i < pendingChapters.length; i += CHAPTER_BATCH_SIZE) {
        batches.push(pendingChapters.slice(i, i + CHAPTER_BATCH_SIZE));
      }

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];

        if ((await this.waitIfPaused(novelId, task)) === 'cancelled') {
          this.notify({ ...task, status: 'idle', currentChapterTitle: 'Download cancelled' });
          return;
        }

        const batchLabel =
          batches.length > 1 ? `Batch ${batchIdx + 1}/${batches.length}` : 'Chapters';
        task.status = 'downloading';
        task.currentChapterTitle = `Queueing ${batchLabel} (${batch.length} chapters)...`;
        this.notify(task);

        let batchErrorMsg: string | null = null;

        try {
          const job = await LNCrawlService.createFetchChaptersJob(batch.map((c) => c.id));
          this.activeRemoteJobs.set(novelId, job.id);

          let currentJob = job;
          const deadline = Date.now() + BATCH_JOB_TIMEOUT_MS;

          while (!currentJob.is_done && !currentJob.error && Date.now() < deadline) {
            if ((await this.waitIfPaused(novelId, task)) === 'cancelled') {
              this.activeRemoteJobs.delete(novelId);
              LNCrawlService.cancelJob(job.id).catch(() => {});
              this.notify({ ...task, status: 'idle', currentChapterTitle: 'Download cancelled' });
              return;
            }

            await new Promise((resolve) =>
              setTimeout(resolve, APP_CONFIG.searchPollIntervalMs)
            );

            if ((await this.waitIfPaused(novelId, task)) === 'cancelled') {
              this.activeRemoteJobs.delete(novelId);
              LNCrawlService.cancelJob(job.id).catch(() => {});
              this.notify({ ...task, status: 'idle', currentChapterTitle: 'Download cancelled' });
              return;
            }

            currentJob = await LNCrawlService.getJobStatus(job.id);
            const jobTotal = currentJob.total || batch.length;
            const jobDone = Math.min(jobTotal, currentJob.done || 0);
            task.status = 'downloading';
            task.currentChapterTitle = `Crawling ${batchLabel}: ${jobDone}/${jobTotal} on server`;
            this.notify(task);
          }

          this.activeRemoteJobs.delete(novelId);

          if (currentJob.error) {
            batchErrorMsg = currentJob.error;
          } else if (!currentJob.is_done) {
            batchErrorMsg = 'Server fetch-chapters job timed out.';
          }
        } catch (jobErr: any) {
          this.activeRemoteJobs.delete(novelId);
          batchErrorMsg = jobErr?.message || 'Failed to start fetch-chapters job.';
        }

        for (const chapter of batch) {
          if ((await this.waitIfPaused(novelId, task)) === 'cancelled') {
            this.notify({ ...task, status: 'idle', currentChapterTitle: 'Download cancelled' });
            return;
          }

          task.status = 'downloading';
          task.currentChapterTitle = chapter.title || `Chapter ${chapter.serial}`;
          this.notify(task);

          try {
            let fetchedTitle = chapter.title;
            let fetchedWordCount = chapter.wordsCount;
            let content: string | null = null;

            const readRes = await LNCrawlService.readChapter(chapter.id, {
              autoFetch: false,
            });
            content = readRes.content;
            if (readRes.title && readRes.title !== 'Chapter Content') {
              fetchedTitle = readRes.title;
            }
            if (typeof readRes.wordCount === 'number') {
              fetchedWordCount = readRes.wordCount;
            }

            if (!content && batchErrorMsg) {
              const fallback = await LNCrawlService.fetchChapterContent(chapter.id, {
                autoFetch: true,
              });
              content = fallback.content;
              if (fallback.title && fallback.title !== 'Chapter Content') {
                fetchedTitle = fallback.title;
              }
              if (typeof fallback.wordCount === 'number') {
                fetchedWordCount = fallback.wordCount;
              }
            }

            if (!content || content.trim().length === 0) {
              throw new Error(batchErrorMsg || 'Chapter content unavailable from server.');
            }

            await saveChapter({
              ...chapter,
              provider: 'lncrawl',
              title: fetchedTitle,
              content,
              wordsCount: fetchedWordCount,
              isDownloaded: true,
            });

            delete existingErrors[chapter.id];
            completed++;
          } catch (chErr: any) {
            const msg = chErr?.message || 'Failed to save chapter';
            console.warn(`Failed downloading chapter ${chapter.id}:`, chErr);
            failedIds.push(chapter.id);
            existingErrors[chapter.id] = msg;
          }

          this.chapterFailuresByNovel.set(novelId, { ...existingErrors });
          task.completedChapters = completed;
          task.failedChapters = failedIds.length;
          task.failedChapterIds = [...failedIds];
          task.chapterErrors = { ...existingErrors };
          this.notify(task);
        }
      }
    }

    const totalFailed = failedIds.length;
    if (completed === 0 && totalFailed > 0) {
      const firstErr = existingErrors[failedIds[0]] || 'All chapters failed to download.';
      this.notify({
        ...task,
        completedChapters: 0,
        failedChapters: totalFailed,
        failedChapterIds: failedIds,
        chapterErrors: { ...existingErrors },
        currentChapterTitle: firstErr,
        status: 'failed',
        error: firstErr,
      });
      return;
    }

    const completionMsg =
      totalFailed > 0
        ? `Downloaded ${completed} chapters (${totalFailed} failed)`
        : 'All chapters downloaded!';

    this.notify({
      ...task,
      completedChapters: completed,
      failedChapters: totalFailed,
      failedChapterIds: failedIds,
      chapterErrors: { ...existingErrors },
      currentChapterTitle: completionMsg,
      status: 'completed',
      error: totalFailed > 0 ? `${totalFailed} chapter(s) failed to download.` : undefined,
    });

    setTimeout(() => {
      if (this.activeTasks.get(novelId)?.status === 'completed') {
        this.activeTasks.delete(novelId);
        this.notify({
          novelId,
          totalChapters: chaptersToDownload.length,
          completedChapters: completed,
          failedChapters: totalFailed,
          failedChapterIds: failedIds,
          chapterErrors: { ...existingErrors },
          currentChapterTitle: '',
          status: 'idle',
        });
      }
    }, totalFailed > 0 ? 5000 : 3000);
  }

  /**
   * Download a single chapter (e.g. from reader header button or chapter list row)
   */
  async downloadSingleChapter(novel: Novel, chapter: Chapter): Promise<Chapter> {
    const existing = await getChapterById(chapter.id);
    if (existing?.isDownloaded && existing.content && existing.content.trim().length > 0) {
      this.clearChapterError(novel.id, chapter.id);
      return existing;
    }

    const effectiveProvider = chapter.provider || novel.provider || 'lncrawl';
    const localSource = getSource(effectiveProvider);

    try {
      let content = chapter.content;
      let fetchedTitle = chapter.title;
      let fetchedWordCount = chapter.wordsCount;

      if (!content) {
        if (localSource) {
          const chPath = chapter.path || chapter.url;
          if (!chPath) {
            throw new Error('Chapter path is missing.');
          }
          content = await this.fetchLocalChapterWithRetries(localSource, chPath);
          fetchedWordCount = countWords(content);
        } else {
          const fetched = await LNCrawlService.fetchChapterContent(chapter.id);
          content = fetched.content;
          if (fetched.title && fetched.title !== 'Chapter Content') {
            fetchedTitle = fetched.title;
          }
          if (typeof fetched.wordCount === 'number') {
            fetchedWordCount = fetched.wordCount;
          }
        }
      }

      await upsertNovel({
        ...novel,
        provider: novel.provider || effectiveProvider,
      });

      const updatedChapter: Chapter = {
        ...chapter,
        provider: effectiveProvider,
        title: fetchedTitle,
        content,
        wordsCount: fetchedWordCount,
        isDownloaded: true,
      };
      await saveChapter(updatedChapter);
      this.clearChapterError(novel.id, chapter.id);

      return updatedChapter;
    } catch (err: any) {
      const currentMap = this.chapterFailuresByNovel.get(novel.id) || {};
      currentMap[chapter.id] = err?.message || 'Download failed';
      this.chapterFailuresByNovel.set(novel.id, currentMap);
      throw err;
    }
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
    const remoteJobId = this.activeRemoteJobs.get(novelId);
    if (remoteJobId) {
      this.activeRemoteJobs.delete(novelId);
      LNCrawlService.cancelJob(remoteJobId).catch(() => {});
    }
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
