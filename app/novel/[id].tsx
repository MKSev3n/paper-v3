import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Image,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../src/theme/colors';
import { Novel, Chapter, ReadingProgress, DownloadTask } from '../../src/types';
import {
  getNovelById,
  upsertNovel,
  getChaptersForNovel,
  saveChaptersBatch,
  getReadingProgress,
} from '../../src/services/database';
import { LNCrawlService, stripHtmlTags } from '../../src/services/lncrawl';
import { DownloadManager } from '../../src/services/downloadManager';
import {
  buildLocalChapterId,
  extractSourceDomain,
  getSource,
  toAbsoluteUrl,
} from '../../src/sources';

function normalizeStatus(rawStatus?: string): 'Ongoing' | 'Completed' | 'Hiatus' {
  const lower = (rawStatus || '').toLowerCase();
  if (lower.includes('complete')) return 'Completed';
  if (lower.includes('hiatus') || lower.includes('stub')) return 'Hiatus';
  return 'Ongoing';
}

export default function NovelDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [novel, setNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [progress, setProgress] = useState<ReadingProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [filterDownloadedOnly, setFilterDownloadedOnly] = useState(false);
  const [sortAscending, setSortAscending] = useState(true);
  const [downloadTask, setDownloadTask] = useState<DownloadTask | undefined>(undefined);
  const [chapterErrors, setChapterErrors] = useState<Record<string, string>>({});
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      // 1. Try local database first
      let localNovel = await getNovelById(id);
      let localChapters = await getChaptersForNovel(id);
      const readProgress = await getReadingProgress(id);

      setProgress(readProgress);

      // 2. Sync novel details and chapter list when online
      try {
        const localSource = getSource(localNovel?.provider);

        if (localSource && (localNovel?.path || localNovel?.url)) {
          const novelPath = localNovel!.path || localNovel!.url!;
          const detail = await localSource.getNovel(novelPath);

          const updatedNovel: Novel = {
            ...localNovel!,
            title: detail.title || localNovel!.title,
            author: detail.author || localNovel!.author || 'Unknown',
            synopsis: detail.summary ?? localNovel!.synopsis ?? '',
            coverUrl: detail.cover || localNovel!.coverUrl || '',
            status: detail.status ? normalizeStatus(detail.status) : localNovel!.status,
            totalChapters: detail.chapters.length,
            provider: localSource.id,
            path: novelPath,
            sourceDomain: localNovel!.sourceDomain || extractSourceDomain(localSource),
            url: toAbsoluteUrl(novelPath, localSource.site),
          };

          const mappedChapters: Chapter[] = detail.chapters.map((ch, idx) => ({
            id: buildLocalChapterId(localSource.id, ch.path),
            novelId: updatedNovel.id,
            serial: idx + 1,
            title: ch.title || `Chapter ${idx + 1}`,
            provider: localSource.id,
            path: ch.path,
            url: toAbsoluteUrl(ch.path, localSource.site),
            isDownloaded: false,
          }));

          localNovel = updatedNovel;
          await upsertNovel(updatedNovel);
          if (mappedChapters.length > 0) {
            await saveChaptersBatch(mappedChapters);
            localChapters = await getChaptersForNovel(id);
          }
        } else if (!localNovel || !localNovel.provider || localNovel.provider === 'lncrawl') {
          const [remoteDetails, remoteChapters] = await Promise.all([
            LNCrawlService.getNovelDetails(id),
            LNCrawlService.getChapters(id),
          ]);
          localNovel = {
            ...remoteDetails,
            provider: 'lncrawl',
            path: remoteDetails.url || localNovel?.path,
          };
          await upsertNovel(localNovel);
          if (remoteChapters.length > 0) {
            await saveChaptersBatch(
              remoteChapters.map((ch) => ({ ...ch, provider: 'lncrawl' }))
            );
            localChapters = await getChaptersForNovel(id);
          }
        }

        setIsOfflineMode(false);
        setSyncError(null);
      } catch (netErr: any) {
        console.warn('Network fetch error in NovelDetail:', netErr);
        setIsOfflineMode(true);
        setSyncError(netErr?.message || 'Offline mode: showing locally cached chapters.');
      }

      setNovel(localNovel);
      setChapters(localChapters);
    } catch (err) {
      console.warn('Error loading novel details:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();

    // Listen to download progress & per-chapter failure updates
    const unsubscribe = DownloadManager.subscribe((task) => {
      if (task.novelId === id) {
        setDownloadTask({ ...task });
        if (task.chapterErrors) {
          setChapterErrors({ ...task.chapterErrors });
        }
        if (task.status === 'completed' || task.status === 'idle') {
          getChaptersForNovel(id).then(setChapters);
        }
      }
    });

    const active = DownloadManager.getTask(id);
    if (active) setDownloadTask(active);
    setChapterErrors(DownloadManager.getChapterErrors(id));

    return () => unsubscribe();
  }, [id, loadData]);

  const handleStartOrResume = () => {
    if (!novel || chapters.length === 0) return;

    if (progress) {
      router.push({
        pathname: '/reader/[id]',
        params: { id: progress.chapterId, novelId: novel.id },
      });
    } else {
      const firstChapter = chapters[0];
      router.push({
        pathname: '/reader/[id]',
        params: { id: firstChapter.id, novelId: novel.id },
      });
    }
  };

  const handleDownloadAll = () => {
    if (!novel || chapters.length === 0) return;
    const undownloaded = chapters.filter((c) => !c.isDownloaded);
    if (undownloaded.length === 0) {
      Alert.alert('All Chapters Downloaded', 'All chapters are already stored offline on your device.');
      return;
    }
    DownloadManager.startDownload(novel, undownloaded);
  };

  const handleDownloadNext = (count: number) => {
    if (!novel || chapters.length === 0) return;
    const undownloaded = chapters.filter((c) => !c.isDownloaded).slice(0, count);
    if (undownloaded.length === 0) {
      Alert.alert('No More Chapters', 'All upcoming chapters are already downloaded.');
      return;
    }
    DownloadManager.startDownload(novel, undownloaded);
  };

  const handleRetryFailed = () => {
    if (!novel) return;
    const failedIds = new Set(Object.keys(chapterErrors));
    const retryChapters = chapters.filter((c) => !c.isDownloaded && failedIds.has(c.id));
    if (retryChapters.length === 0) return;
    DownloadManager.startDownload(novel, retryChapters);
  };

  const handleDownloadSingleChapter = async (chapter: Chapter) => {
    if (!novel) return;
    try {
      await DownloadManager.downloadSingleChapter(novel, chapter);
      setChapterErrors(DownloadManager.getChapterErrors(novel.id));
      const updated = await getChaptersForNovel(novel.id);
      setChapters(updated);
    } catch (err: any) {
      setChapterErrors(DownloadManager.getChapterErrors(novel.id));
      Alert.alert('Download Error', err.message || 'Failed to download chapter.');
    }
  };

  const displayedChapters = chapters
    .filter((ch) => (filterDownloadedOnly ? ch.isDownloaded : true))
    .sort((a, b) => (sortAscending ? a.serial - b.serial : b.serial - a.serial));

  const downloadedCount = chapters.filter((c) => c.isDownloaded).length;

  const renderHeader = () => {
    if (!novel) return null;
    const coverUri = novel.localCoverPath || novel.coverUrl;

    return (
      <View style={styles.headerContainer}>
        {/* Top Navigation Row */}
        <View style={styles.navRow}>
          <Pressable
            style={styles.navButton}
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/(tabs)')
            }
            hitSlop={10}
          >
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </Pressable>

          <View style={styles.navRight}>
            <Pressable
              style={styles.navButton}
              onPress={() => {
                DownloadManager.exportNovelAsEpub(novel.id)
                  .catch((e) => Alert.alert('Export', e.message));
              }}
              hitSlop={10}
            >
              <Ionicons name="share-social-outline" size={20} color={Colors.text} />
            </Pressable>
          </View>
        </View>

        {/* Novel Card Hero */}
        <View style={styles.heroCard}>
          <Image
            source={coverUri ? { uri: coverUri } : require('../../assets/icon.png')}
            style={styles.heroCover}
            resizeMode="cover"
          />

          <View style={styles.heroInfo}>
            <Text style={styles.heroTitle} numberOfLines={3}>
              {novel.title}
            </Text>
            <Text style={styles.heroAuthor} numberOfLines={1}>
              {novel.author}
            </Text>

            <View style={styles.metaRow}>
              {novel.status && (
                <View style={styles.statusPill}>
                  <Text style={styles.statusPillText}>{novel.status}</Text>
                </View>
              )}
              {novel.sourceDomain ? (
                <View style={styles.statusPill}>
                  <Text style={styles.statusPillText}>{novel.sourceDomain}</Text>
                </View>
              ) : null}
              <Text style={styles.totalChaptersLabel}>
                {chapters.length || novel.totalChapters} Ch.
              </Text>
              <Text style={styles.downloadedCountLabel}>
                • {downloadedCount} saved
              </Text>
            </View>
          </View>
        </View>

        {/* Read Action Button */}
        <Pressable
          style={({ pressed }) => [styles.primaryReadButton, pressed && styles.buttonPressed]}
          onPress={handleStartOrResume}
        >
          <Ionicons
            name={progress ? 'bookmark' : 'book'}
            size={18}
            color="#0D0F14"
          />
          <Text style={styles.primaryReadButtonText}>
            {progress
              ? `Continue Ch. ${progress.chapterSerial} (${Math.round(
                  progress.scrollPercentage || 0
                )}%)`
              : 'Start Reading Ch. 1'}
          </Text>
        </Pressable>

        {/* Synopsis Section */}
        {novel.synopsis ? (
          <Pressable
            style={styles.synopsisCard}
            onPress={() => setSynopsisExpanded(!synopsisExpanded)}
          >
            <Text
              style={styles.synopsisText}
              numberOfLines={synopsisExpanded ? undefined : 3}
            >
              {stripHtmlTags(novel.synopsis)}
            </Text>
            <Text style={styles.synopsisToggle}>
              {synopsisExpanded ? 'Show less' : 'Read more'}
            </Text>
          </Pressable>
        ) : null}

        {/* LNReader-Style Offline Download Management */}
        <View style={styles.downloadSectionCard}>
          <View style={styles.downloadSectionHeader}>
            <View style={styles.downloadSectionTitleRow}>
              <Ionicons name="cloud-download" size={18} color={Colors.primary} />
              <Text style={styles.downloadSectionTitle}>Offline Downloads</Text>
            </View>
            <Text style={styles.downloadSectionBadge}>
              {downloadedCount} / {chapters.length} saved
            </Text>
          </View>

          {/* Active Download Progress */}
          {downloadTask && downloadTask.status !== 'idle' && (
            <View style={styles.activeTaskBox}>
              <View style={styles.activeTaskRow}>
                <Text style={styles.activeTaskChapter} numberOfLines={1}>
                  {downloadTask.currentChapterTitle}
                </Text>
                <Text
                  style={[
                    styles.activeTaskPercent,
                    downloadTask.status === 'failed' && { color: Colors.danger },
                  ]}
                >
                  {downloadTask.status === 'failed'
                    ? 'Failed'
                    : `${Math.round(
                        (downloadTask.completedChapters / (downloadTask.totalChapters || 1)) * 100
                      )}%`}
                </Text>
              </View>

              <View style={styles.downloadProgressBg}>
                <View
                  style={[
                    styles.downloadProgressFill,
                    {
                      width: `${(downloadTask.completedChapters / (downloadTask.totalChapters || 1)) * 100}%`,
                      backgroundColor:
                        downloadTask.status === 'failed' ? Colors.danger : Colors.primary,
                    },
                  ]}
                />
              </View>

              <View style={styles.taskActionsRow}>
                <Text style={styles.taskStatusText}>
                  {downloadTask.completedChapters} of {downloadTask.totalChapters} chapters
                  {(downloadTask.failedChapters || 0) > 0
                    ? ` • ${downloadTask.failedChapters} failed`
                    : ''}
                </Text>

                <View style={styles.taskButtons}>
                  {downloadTask.status === 'downloading' ? (
                    <Pressable
                      style={styles.taskControlButton}
                      onPress={() => DownloadManager.pauseDownload(novel.id)}
                    >
                      <Ionicons name="pause" size={14} color={Colors.warning} />
                      <Text style={styles.taskControlText}>Pause</Text>
                    </Pressable>
                  ) : downloadTask.status === 'paused' ? (
                    <Pressable
                      style={styles.taskControlButton}
                      onPress={() => DownloadManager.resumeDownload(novel.id)}
                    >
                      <Ionicons name="play" size={14} color={Colors.primary} />
                      <Text style={styles.taskControlText}>Resume</Text>
                    </Pressable>
                  ) : null}

                  {downloadTask.status === 'failed' && Object.keys(chapterErrors).length > 0 ? (
                    <Pressable
                      style={styles.taskControlButton}
                      onPress={handleRetryFailed}
                    >
                      <Ionicons name="refresh" size={14} color={Colors.primary} />
                      <Text style={styles.taskControlText}>Retry Failed</Text>
                    </Pressable>
                  ) : null}

                  {(downloadTask.status === 'downloading' || downloadTask.status === 'paused') && (
                    <Pressable
                      style={styles.taskControlButton}
                      onPress={() => DownloadManager.cancelDownload(novel.id)}
                    >
                      <Ionicons name="close" size={14} color={Colors.danger} />
                      <Text style={styles.taskControlDangerText}>Cancel</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </View>
          )}

          {Object.keys(chapterErrors).length > 0 &&
            (!downloadTask || downloadTask.status === 'idle') && (
              <View style={styles.chapterFailuresBanner}>
                <Text style={styles.chapterFailuresText}>
                  {Object.keys(chapterErrors).length} chapter(s) failed during download.
                </Text>
                <Pressable style={styles.retryFailedBtn} onPress={handleRetryFailed}>
                  <Text style={styles.retryFailedText}>Retry Failed</Text>
                </Pressable>
              </View>
            )}

          {/* Offline / Auth Notice when remote sync unavailable */}
          {isOfflineMode && (
            <View style={styles.offlineBanner}>
              <Ionicons name="cloud-offline-outline" size={16} color={Colors.warning} />
              <Text style={styles.offlineBannerText}>
                {syncError || 'Offline mode — showing cached chapters only'}
              </Text>
            </View>
          )}

          {/* Download Action Buttons (hidden when offline) */}
          {!isOfflineMode && (
            <View style={styles.downloadButtonsGrid}>
              <Pressable
                style={styles.downloadActionBtn}
                onPress={handleDownloadAll}
                disabled={downloadTask?.status === 'downloading'}
              >
                <Ionicons name="download" size={14} color={Colors.primary} />
                <Text style={styles.downloadActionBtnText}>Download All</Text>
              </Pressable>

              <Pressable
                style={styles.downloadActionBtn}
                onPress={() => handleDownloadNext(10)}
                disabled={downloadTask?.status === 'downloading'}
              >
                <Ionicons name="arrow-down-circle-outline" size={14} color={Colors.textSecondary} />
                <Text style={styles.downloadActionBtnText}>Next 10</Text>
              </Pressable>

              <Pressable
                style={styles.downloadActionBtn}
                onPress={() => handleDownloadNext(25)}
                disabled={downloadTask?.status === 'downloading'}
              >
                <Ionicons name="arrow-down-circle-outline" size={14} color={Colors.textSecondary} />
                <Text style={styles.downloadActionBtnText}>Next 25</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Chapters Header & Filter Controls */}
        <View style={styles.chapterListHeader}>
          <Text style={styles.chaptersHeading}>
            CHAPTERS ({displayedChapters.length})
          </Text>

          <View style={styles.chapterControlsRow}>
            {/* Downloaded only filter */}
            <Pressable
              style={[
                styles.chapterFilterBtn,
                filterDownloadedOnly && styles.chapterFilterBtnActive,
              ]}
              onPress={() => setFilterDownloadedOnly(!filterDownloadedOnly)}
            >
              <Ionicons
                name="checkmark-circle-outline"
                size={14}
                color={filterDownloadedOnly ? Colors.primary : Colors.textMuted}
              />
              <Text
                style={[
                  styles.chapterFilterBtnText,
                  filterDownloadedOnly && styles.chapterFilterBtnTextActive,
                ]}
              >
                Offline only
              </Text>
            </Pressable>

            {/* Sort order toggle */}
            <Pressable
              style={styles.sortButton}
              onPress={() => setSortAscending(!sortAscending)}
            >
              <Ionicons
                name={sortAscending ? 'arrow-up' : 'arrow-down'}
                size={14}
                color={Colors.textSecondary}
              />
              <Text style={styles.sortButtonText}>
                {sortAscending ? '1-N' : 'N-1'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  };

  const renderChapterItem = ({ item }: { item: Chapter }) => {
    const isCurrentProgress = progress?.chapterId === item.id;
    const chapterErr = chapterErrors[item.id];

    return (
      <Pressable
        style={({ pressed }) => [
          styles.chapterRow,
          isCurrentProgress && styles.chapterRowCurrent,
          chapterErr && !item.isDownloaded && styles.chapterRowFailed,
          pressed && styles.cardPressed,
        ]}
        onPress={() => {
          if (!novel) return;
          router.push({
            pathname: '/reader/[id]',
            params: { id: item.id, novelId: novel.id },
          });
        }}
      >
        <View style={styles.chapterRowLeft}>
          <Text style={styles.chapterSerialText}>{item.serial}</Text>
          <View style={styles.chapterTitleWrapper}>
            <Text
              style={[
                styles.chapterTitleText,
                isCurrentProgress && styles.chapterTitleCurrent,
              ]}
              numberOfLines={1}
            >
              {item.title}
            </Text>
            {isCurrentProgress && (
              <Text style={styles.readingNowBadge}>
                Reading • {Math.round(progress?.scrollPercentage || 0)}%
              </Text>
            )}
            {chapterErr && !item.isDownloaded && (
              <Text style={styles.chapterErrorBadge} numberOfLines={1}>
                Failed: {chapterErr}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.chapterRowRight}>
          {item.isDownloaded ? (
            <View style={styles.downloadedCheck}>
              <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
            </View>
          ) : chapterErr && !isOfflineMode ? (
            <Pressable
              style={styles.singleDownloadBtn}
              onPress={() => handleDownloadSingleChapter(item)}
              hitSlop={10}
            >
              <Ionicons name="refresh-circle" size={20} color={Colors.danger} />
            </Pressable>
          ) : !isOfflineMode ? (
            <Pressable
              style={styles.singleDownloadBtn}
              onPress={() => handleDownloadSingleChapter(item)}
              hitSlop={10}
            >
              <Ionicons
                name="cloud-download-outline"
                size={18}
                color={Colors.textMuted}
              />
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    );
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <FlatList
        data={displayedChapters}
        keyExtractor={(item) => item.id}
        renderItem={renderChapterItem}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  headerContainer: {
    paddingTop: 8,
    paddingBottom: 8,
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  navButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  navRight: {
    flexDirection: 'row',
    gap: 8,
  },
  heroCard: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    gap: 14,
    marginBottom: 14,
  },
  heroCover: {
    width: 90,
    height: 130,
    borderRadius: 8,
    backgroundColor: Colors.surfaceLight,
  },
  heroInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  heroTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    lineHeight: 22,
    marginBottom: 4,
  },
  heroAuthor: {
    fontSize: 13,
    color: Colors.textMuted,
    marginBottom: 10,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  statusPill: {
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusPillText: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  totalChaptersLabel: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  downloadedCountLabel: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: '600',
  },
  primaryReadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: 10,
    gap: 8,
    marginBottom: 14,
  },
  buttonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.99 }],
  },
  primaryReadButtonText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0D0F14',
  },
  synopsisCard: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 14,
  },
  synopsisText: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  synopsisToggle: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: '600',
    marginTop: 6,
  },
  downloadSectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    marginBottom: 16,
  },
  downloadSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  downloadSectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  downloadSectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  downloadSectionBadge: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: '600',
  },
  activeTaskBox: {
    backgroundColor: Colors.surfaceRaised,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  activeTaskRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  activeTaskChapter: {
    fontSize: 12,
    color: Colors.text,
    fontWeight: '600',
    flex: 1,
  },
  activeTaskPercent: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: '700',
    marginLeft: 8,
  },
  downloadProgressBg: {
    height: 4,
    backgroundColor: Colors.surface,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  downloadProgressFill: {
    height: '100%',
    backgroundColor: Colors.primary,
  },
  taskActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  taskStatusText: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  taskButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  taskControlButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    gap: 4,
  },
  taskControlText: {
    fontSize: 11,
    color: Colors.text,
    fontWeight: '600',
  },
  taskControlDangerText: {
    fontSize: 11,
    color: Colors.danger,
    fontWeight: '600',
  },
  downloadButtonsGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  downloadActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surfaceRaised,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  downloadActionBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.text,
  },
  chapterListHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  chaptersHeading: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 0.8,
  },
  chapterControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chapterFilterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 4,
  },
  chapterFilterBtnActive: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  chapterFilterBtnText: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  chapterFilterBtnTextActive: {
    color: Colors.primary,
    fontWeight: '600',
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 4,
  },
  sortButtonText: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  chapterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
  },
  chapterRowCurrent: {
    borderColor: Colors.primary,
    backgroundColor: Colors.surfaceRaised,
  },
  cardPressed: {
    opacity: 0.85,
  },
  chapterRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  chapterSerialText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: Colors.textMuted,
    width: 28,
  },
  chapterTitleWrapper: {
    flex: 1,
  },
  chapterTitleText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  chapterTitleCurrent: {
    color: Colors.primary,
  },
  readingNowBadge: {
    fontSize: 10,
    color: Colors.primary,
    marginTop: 2,
    fontWeight: '600',
  },
  chapterRowRight: {
    marginLeft: 8,
  },
  downloadedCheck: {
    padding: 4,
  },
  singleDownloadBtn: {
    padding: 4,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.warningMuted,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  offlineBannerText: {
    flex: 1,
    fontSize: 12,
    color: Colors.warning,
    lineHeight: 16,
  },
  chapterRowFailed: {
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  chapterErrorBadge: {
    fontSize: 10,
    color: Colors.danger,
    marginTop: 2,
    fontWeight: '600',
  },
  chapterFailuresBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.dangerMuted,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    gap: 8,
  },
  chapterFailuresText: {
    flex: 1,
    fontSize: 12,
    color: Colors.danger,
    fontWeight: '600',
  },
  retryFailedBtn: {
    backgroundColor: Colors.danger,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  retryFailedText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
