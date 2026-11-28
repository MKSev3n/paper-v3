import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Image,
  RefreshControl,
  Dimensions,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../src/theme/colors';
import { deleteLocalCover } from '../../src/services/fileStorage';
import { DownloadManager } from '../../src/services/downloadManager';
import { Novel, ReadingProgress, ReaderSettings } from '../../src/types';
import {
  getAllNovels,
  getDownloadedNovels,
  getAllReadingProgress,
  getNovelById,
  deleteNovel,
  deleteDownloadedChapters,
} from '../../src/services/database';
import { getReaderSettings, saveReaderSettings } from '../../src/services/storage';

const { width } = Dimensions.get('window');
const COLUMN_WIDTH = (width - 48) / 2;

type FilterType = 'all' | 'downloaded' | 'reading';

export default function LibraryScreen() {
  const router = useRouter();
  const [novels, setNovels] = useState<Novel[]>([]);
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [continueReading, setContinueReading] = useState<{
    novel: Novel;
    progress: ReadingProgress;
  } | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const loadLibraryData = useCallback(async () => {
    try {
      let novelList: Novel[];
      if (activeFilter === 'downloaded') {
        novelList = await getDownloadedNovels();
      } else {
        novelList = await getAllNovels();
      }

      // Check reading progress
      const progressList = await getAllReadingProgress();
      if (activeFilter === 'reading') {
        const novelIdsInProgress = new Set(progressList.map((p) => p.novelId));
        novelList = novelList.filter((n) => novelIdsInProgress.has(n.id));
      }

      setNovels(novelList);

      // Latest continue-reading
      if (progressList.length > 0) {
        const latest = progressList[0];
        const novel = await getNovelById(latest.novelId);
        if (novel) {
          setContinueReading({ novel, progress: latest });
        } else {
          setContinueReading(null);
        }
      } else {
        setContinueReading(null);
      }
    } catch (err) {
      console.warn('Error loading library:', err);
    }
  }, [activeFilter]);

  useFocusEffect(
    useCallback(() => {
      loadLibraryData();
    }, [loadLibraryData])
  );

  useEffect(() => {
    getReaderSettings().then((settings: ReaderSettings) => {
      setViewMode(settings.viewMode || 'grid');
    });
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadLibraryData();
    setRefreshing(false);
  };

  const handleRemoveBook = (novel: Novel) => {
    Alert.alert(
      'Remove from library',
      `Remove "${novel.title}", its chapters, downloads and progress?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            DownloadManager.cancelDownload(novel.id);
            await deleteDownloadedChapters(novel.id);
            await deleteLocalCover(novel.localCoverPath);
            await deleteNovel(novel.id);
            setNovels((prev) => prev.filter((n) => n.id !== novel.id));
            loadLibraryData();
          },
        },
      ]
    );
  };

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      {/* Brand Header */}
      <View style={styles.brandRow}>
        <View style={styles.brandTitleContainer}>
          <Text style={styles.brandTitle}>Paper</Text>
          <Text style={styles.brandBadge}>v3.0</Text>
        </View>
        <View style={styles.headerActions} />
        <Pressable
          style={styles.viewModeButton}
          onPress={() => {
            const next = viewMode === 'grid' ? 'list' : 'grid';
            setViewMode(next);
            getReaderSettings().then((s: ReaderSettings) =>
              saveReaderSettings({ ...s, viewMode: next })
            );
          }}
          hitSlop={12}
          accessibilityLabel={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
        >
          <Ionicons
            name={viewMode === 'grid' ? 'list-outline' : 'grid-outline'}
            size={22}
            color={Colors.text}
          />
        </Pressable>
        <Pressable
          style={styles.searchIconButton}
          onPress={() => router.push('/(tabs)/discover')}
          hitSlop={10}
        >
          <Ionicons name="search" size={20} color={Colors.text} />
        </Pressable>
      </View>
      <Text style={styles.subtitle}>Calm light novel reader & offline archive</Text>

      {/* Continue Reading Section */}
      {continueReading && (
        <View style={styles.continueSection}>
          <Text style={styles.sectionLabel}>CONTINUE READING</Text>
          <Pressable
            style={({ pressed }) => [
              styles.continueCard,
              pressed && styles.cardPressed,
            ]}
            onPress={() =>
              router.push({
                pathname: '/reader/[id]',
                params: {
                  id: continueReading.progress.chapterId,
                  novelId: continueReading.novel.id,
                },
              })
            }
          >
            <Image
              source={
                continueReading.novel.localCoverPath
                  ? { uri: continueReading.novel.localCoverPath }
                  : continueReading.novel.coverUrl
                  ? { uri: continueReading.novel.coverUrl }
                  : require('../../assets/icon.png')
              }
              style={styles.continueCover}
              resizeMode="cover"
            />
            <View style={styles.continueInfo}>
              <Text style={styles.continueNovelTitle} numberOfLines={1}>
                {continueReading.novel.title}
              </Text>
              <Text style={styles.continueChapterTitle} numberOfLines={1}>
                {continueReading.progress.chapterTitle ||
                  `Chapter ${continueReading.progress.chapterSerial}`}
              </Text>

              {/* Progress bar */}
              <View style={styles.progressBarBg}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${Math.min(
                        100,
                        Math.max(5, continueReading.progress.scrollPercentage || 0)
                      )}%`,
                    },
                  ]}
                />
              </View>

              <View style={styles.continueFooter}>
                <Text style={styles.progressPercentText}>
                  {Math.round(continueReading.progress.scrollPercentage || 0)}% read
                </Text>
                <View style={styles.resumeButton}>
                  <Text style={styles.resumeButtonText}>Resume</Text>
                  <Ionicons name="play" size={12} color="#0D0F14" />
                </View>
              </View>
            </View>
          </Pressable>
        </View>
      )}

      {/* Filter Tabs */}
      <View style={styles.filterRow}>
        {(['all', 'downloaded', 'reading'] as FilterType[]).map((filter) => {
          const isSelected = activeFilter === filter;
          const labels = {
            all: 'All Books',
            downloaded: 'Downloaded',
            reading: 'In Progress',
          };
          return (
            <Pressable
              key={filter}
              style={[
                styles.filterChip,
                isSelected && styles.filterChipSelected,
              ]}
              onPress={() => setActiveFilter(filter)}
            >
              <Text
                style={[
                  styles.filterChipText,
                  isSelected && styles.filterChipTextSelected,
                ]}
              >
                {labels[filter]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const renderNovelItem = ({ item }: { item: Novel }) => {
    const coverUri = item.localCoverPath || item.coverUrl;
    const isOfflineAvailable =
      item.isDownloaded || (item.downloadedChaptersCount ?? 0) > 0;

    return (
      <Pressable
        style={({ pressed }) => [styles.novelCard, pressed && styles.cardPressed]}
        onPress={() =>
          router.push({
            pathname: '/novel/[id]',
            params: { id: item.id },
          })
        }
        onLongPress={() => handleRemoveBook(item)}
      >
        <View style={styles.coverWrapper}>
          <Image
            source={
              coverUri
                ? { uri: coverUri }
                : require('../../assets/icon.png')
            }
            style={styles.novelCover}
            resizeMode="cover"
          />

          {isOfflineAvailable && (
            <View style={styles.downloadedBadge}>
              <Ionicons name="checkmark-circle" size={13} color="#10B981" />
              <Text style={styles.downloadedBadgeText}>Offline</Text>
            </View>
          )}

          {item.status && (
            <View style={styles.statusBadge}>
              <Text style={styles.statusBadgeText}>{item.status}</Text>
            </View>
          )}
        </View>

        <View style={styles.novelCardInfo}>
          <Text style={styles.novelCardTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.novelCardAuthor} numberOfLines={1}>
            {item.author}
          </Text>

          {item.downloadedChaptersCount !== undefined &&
            item.downloadedChaptersCount > 0 && (
              <Text style={styles.novelCardChCount}>
                {item.downloadedChaptersCount} ch. saved
              </Text>
            )}
        </View>
      </Pressable>
    );
  };

  const renderNovelItemList = ({ item }: { item: Novel }) => {
    const coverUri = item.localCoverPath || item.coverUrl;
    const isOfflineAvailable =
      item.isDownloaded || (item.downloadedChaptersCount ?? 0) > 0;
    const totalChapters = item.totalChapters || 0;
    const readChapters = item.downloadedChaptersCount ?? 0;

    return (
      <Pressable
        style={({ pressed }) => [styles.novelListItem, pressed && styles.cardPressed]}
        onPress={() =>
          router.push({
            pathname: '/novel/[id]',
            params: { id: item.id },
          })
        }
        onLongPress={() => handleRemoveBook(item)}
      >
        <Image
          source={
            coverUri
              ? { uri: coverUri }
              : require('../../assets/icon.png')
          }
          style={styles.listCover}
          resizeMode="cover"
        />
        <View style={styles.listInfo}>
          <Text style={styles.listTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.listAuthor} numberOfLines={1}>
            {item.author}
          </Text>
          {totalChapters > 0 && (
            <Text style={styles.listProgress}>
              {readChapters} / {totalChapters} chapters
            </Text>
          )}
        </View>
        {isOfflineAvailable && (
          <View style={styles.listDownloadedBadge}>
            <Ionicons name="checkmark-circle" size={14} color="#10B981" />
            <Text style={styles.listDownloadedBadgeText}>Downloaded</Text>
          </View>
        )}
      </Pressable>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="book-outline" size={56} color={Colors.surfaceLight} />
      <Text style={styles.emptyTitle}>Your Library is Empty</Text>
      <Text style={styles.emptyText}>
        Search and download novels to read them offline anytime without network.
      </Text>
      <Pressable
        style={styles.emptyButton}
        onPress={() => router.push('/(tabs)/discover')}
      >
        <Ionicons name="search" size={16} color="#0D0F14" />
        <Text style={styles.emptyButtonText}>Explore Novels</Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <FlatList
        data={novels}
        keyExtractor={(item) => item.id}
        renderItem={viewMode === 'grid' ? renderNovelItem : renderNovelItemList}
        key={`lib-${viewMode}`}
        numColumns={viewMode === 'grid' ? 2 : 1}
        columnWrapperStyle={viewMode === 'grid' && novels.length > 0 ? styles.columnWrapper : undefined}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  headerContainer: {
    paddingTop: 12,
    paddingBottom: 16,
  },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  brandBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.primary,
    backgroundColor: Colors.primaryMuted,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  searchIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  subtitle: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 4,
    marginBottom: 16,
  },
  continueSection: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 1,
    marginBottom: 8,
  },
  continueCard: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    alignItems: 'center',
    gap: 12,
  },
  cardPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },
  continueCover: {
    width: 60,
    height: 85,
    borderRadius: 6,
    backgroundColor: Colors.surfaceLight,
  },
  continueInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  continueNovelTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 4,
  },
  continueChapterTitle: {
    fontSize: 13,
    color: Colors.primary,
    fontWeight: '500',
    marginBottom: 8,
  },
  progressBarBg: {
    height: 4,
    backgroundColor: Colors.surfaceRaised,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: 2,
  },
  continueFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressPercentText: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  resumeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  resumeButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0D0F14',
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipSelected: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  filterChipText: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  filterChipTextSelected: {
    color: Colors.primary,
    fontWeight: '700',
  },
  columnWrapper: {
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  novelCard: {
    width: COLUMN_WIDTH,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  coverWrapper: {
    width: '100%',
    height: COLUMN_WIDTH * 1.35,
    backgroundColor: Colors.surfaceLight,
    position: 'relative',
  },
  novelCover: {
    width: '100%',
    height: '100%',
  },
  downloadedBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(13, 15, 20, 0.85)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    gap: 3,
    borderWidth: 0.5,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  downloadedBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#10B981',
  },
  statusBadge: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    backgroundColor: 'rgba(13, 15, 20, 0.75)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusBadgeText: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  novelCardInfo: {
    padding: 10,
  },
  novelCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
    lineHeight: 18,
    minHeight: 36,
  },
  novelCardAuthor: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  novelCardChCount: {
    fontSize: 10,
    color: Colors.primary,
    marginTop: 4,
    fontWeight: '600',
  },
  emptyContainer: {
    paddingTop: 60,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.text,
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  emptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  emptyButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0D0F14',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  viewModeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  novelListItem: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  listCover: {
    width: 56,
    height: 76,
    borderRadius: 6,
    backgroundColor: Colors.surfaceLight,
  },
  listInfo: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    lineHeight: 20,
    maxHeight: 40,
  },
  listAuthor: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  listProgress: {
    fontSize: 11,
    color: Colors.primary,
    marginTop: 4,
    fontWeight: '600',
  },
  listDownloadedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
    marginLeft: 8,
  },
  listDownloadedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#10B981',
  },
});
