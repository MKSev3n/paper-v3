import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../src/theme/colors';
import { Novel, DownloadTask } from '../../src/types';
import {
  getAllNovels,
  getDownloadedNovels,
  deleteDownloadedChapters,
} from '../../src/services/database';
import { deleteLocalCover } from '../../src/services/fileStorage';
import { DownloadManager } from '../../src/services/downloadManager';

export default function DownloadsScreen() {
  const router = useRouter();
  const [downloadedNovels, setDownloadedNovels] = useState<Novel[]>([]);
  const [novelTitles, setNovelTitles] = useState<Record<string, string>>({});
  const [tasksByNovel, setTasksByNovel] = useState<Record<string, DownloadTask>>({});
  const [loading, setLoading] = useState(true);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const loadDownloadsData = useCallback(async () => {
    try {
      const [allNovels, downloaded] = await Promise.all([
        getAllNovels(),
        getDownloadedNovels(),
      ]);

      const titleMap: Record<string, string> = {};
      const activeTasks: Record<string, DownloadTask> = {};
      for (const n of allNovels) {
        titleMap[n.id] = n.title;
        const task = DownloadManager.getTask(n.id);
        if (task && task.status !== 'idle') {
          activeTasks[n.id] = { ...task };
        }
      }

      setNovelTitles(titleMap);
      setTasksByNovel(activeTasks);
      setDownloadedNovels(downloaded);
    } catch (err) {
      console.warn('Error loading downloads:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDownloadsData();
    }, [loadDownloadsData])
  );

  useEffect(() => {
    const unsubscribe = DownloadManager.subscribe((task) => {
      setTasksByNovel((prev) => {
        if (task.status === 'idle') {
          const next = { ...prev };
          delete next[task.novelId];
          return next;
        }
        return { ...prev, [task.novelId]: { ...task } };
      });

      if (task.status === 'completed' || task.status === 'idle') {
        loadDownloadsData();
      }
    });

    return () => unsubscribe();
  }, [loadDownloadsData]);

  const handleDeleteDownloads = (novel: Novel) => {
    Alert.alert(
      'Delete Offline Downloads?',
      `This will remove all downloaded chapter texts for "${novel.title}". Your reading progress will remain saved.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteDownloadedChapters(novel.id);
              if (novel.localCoverPath) {
                await deleteLocalCover(novel.localCoverPath);
              }
              await loadDownloadsData();
            } catch (err) {
              console.warn('Failed to delete downloads:', err);
            }
          },
        },
      ]
    );
  };

  const handleExportEpub = async (novel: Novel) => {
    setExportingId(novel.id);
    try {
      await DownloadManager.exportNovelAsEpub(novel.id);
    } catch (err: any) {
      Alert.alert('Export Error', err.message || 'Could not export novel.');
    } finally {
      setExportingId(null);
    }
  };

  const activeTasksList = Object.values(tasksByNovel).filter(
    (t) => t.status !== 'idle'
  );

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      <Text style={styles.screenTitle}>Downloads</Text>
      <Text style={styles.screenSubtitle}>
        Monitor active chapter downloads and manage offline novels
      </Text>

      {/* Active Queue Section */}
      <Text style={styles.sectionTitle}>ACTIVE QUEUE ({activeTasksList.length})</Text>
      {activeTasksList.length === 0 ? (
        <View style={styles.queueEmptyCard}>
          <Ionicons name="checkmark-done-circle-outline" size={20} color={Colors.textMuted} />
          <Text style={styles.queueEmptyText}>
            No active downloads. Open any novel to queue chapters for offline reading.
          </Text>
        </View>
      ) : (
        <View style={styles.queueList}>
          {activeTasksList.map((task) => {
            const pct = Math.round(
              (task.completedChapters / (task.totalChapters || 1)) * 100
            );
            const isFailed = task.status === 'failed';
            return (
              <Pressable
                key={task.novelId}
                style={styles.activeTaskCard}
                onPress={() =>
                  router.push({
                    pathname: '/novel/[id]',
                    params: { id: task.novelId },
                  })
                }
              >
                <View style={styles.taskTopRow}>
                  <View style={styles.taskTitleGroup}>
                    <Text style={styles.taskNovelTitle} numberOfLines={1}>
                      {novelTitles[task.novelId] || 'Novel Download'}
                    </Text>
                    <Text style={styles.taskChapterTitle} numberOfLines={1}>
                      {task.currentChapterTitle}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.taskPercent,
                      isFailed && { color: Colors.danger },
                    ]}
                  >
                    {isFailed ? 'Failed' : `${pct}%`}
                  </Text>
                </View>

                <View style={styles.progressBg}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${pct}%`,
                        backgroundColor: isFailed ? Colors.danger : Colors.primary,
                      },
                    ]}
                  />
                </View>

                <View style={styles.taskFooterRow}>
                  <Text style={styles.taskCountText}>
                    {task.completedChapters} of {task.totalChapters} chapters
                  </Text>

                  {(task.status === 'downloading' || task.status === 'paused') && (
                    <View style={styles.taskButtons}>
                      {task.status === 'downloading' ? (
                        <Pressable
                          style={styles.taskControlButton}
                          onPress={() => DownloadManager.pauseDownload(task.novelId)}
                        >
                          <Ionicons name="pause" size={14} color={Colors.warning} />
                          <Text style={styles.taskControlText}>Pause</Text>
                        </Pressable>
                      ) : (
                        <Pressable
                          style={styles.taskControlButton}
                          onPress={() => DownloadManager.resumeDownload(task.novelId)}
                        >
                          <Ionicons name="play" size={14} color={Colors.primary} />
                          <Text style={styles.taskControlText}>Resume</Text>
                        </Pressable>
                      )}

                      <Pressable
                        style={styles.taskControlButton}
                        onPress={() => DownloadManager.cancelDownload(task.novelId)}
                      >
                        <Ionicons name="close" size={14} color={Colors.danger} />
                        <Text style={styles.taskControlDangerText}>Cancel</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      <Text style={styles.sectionTitle}>
        DOWNLOADED NOVELS ({downloadedNovels.length})
      </Text>
    </View>
  );

  const renderNovelItem = ({ item }: { item: Novel }) => {
    const isExporting = exportingId === item.id;
    const coverUri = item.localCoverPath || item.coverUrl;

    return (
      <View style={styles.novelItemCard}>
        <View style={styles.novelRowTop}>
          <Image
            source={coverUri ? { uri: coverUri } : require('../../assets/icon.png')}
            style={styles.novelCover}
            resizeMode="cover"
          />
          <View style={styles.novelInfo}>
            <Text style={styles.novelTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.novelAuthor} numberOfLines={1}>
              {item.author}
            </Text>
            <View style={styles.savedBadge}>
              <Ionicons name="checkmark-done" size={14} color={Colors.primary} />
              <Text style={styles.savedBadgeText}>
                {item.downloadedChaptersCount || 0} chapters saved offline
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.novelActionsRow}>
          <Pressable
            style={styles.actionButtonSecondary}
            onPress={() =>
              router.push({
                pathname: '/novel/[id]',
                params: { id: item.id },
              })
            }
          >
            <Ionicons name="book-outline" size={14} color={Colors.text} />
            <Text style={styles.actionButtonSecondaryText}>Chapters</Text>
          </Pressable>

          <Pressable
            style={[styles.actionButtonPrimary, isExporting && styles.actionButtonDisabled]}
            onPress={() => handleExportEpub(item)}
            disabled={isExporting}
          >
            {isExporting ? (
              <ActivityIndicator size="small" color="#0D0F14" />
            ) : (
              <>
                <Ionicons name="share-outline" size={14} color="#0D0F14" />
                <Text style={styles.actionButtonPrimaryText}>Export EPUB</Text>
              </>
            )}
          </Pressable>

          <Pressable
            style={styles.actionButtonDanger}
            onPress={() => handleDeleteDownloads(item)}
          >
            <Ionicons name="trash-outline" size={14} color={Colors.danger} />
            <Text style={styles.actionButtonDangerText}>Delete</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const renderEmpty = () => {
    if (loading) {
      return (
        <View style={styles.loadingWrapper}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      );
    }

    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="cloud-download-outline" size={48} color={Colors.surfaceLight} />
        <Text style={styles.emptyTitle}>No Downloaded Novels</Text>
        <Text style={styles.emptyText}>
          Download chapters from any novel page to store them locally for offline reading.
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <FlatList
        data={downloadedNovels}
        keyExtractor={(item) => item.id}
        renderItem={renderNovelItem}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
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
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  headerContainer: {
    paddingTop: 12,
    paddingBottom: 8,
  },
  screenTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  screenSubtitle: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 4,
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 1,
    marginBottom: 10,
  },
  queueEmptyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    gap: 10,
    marginBottom: 22,
  },
  queueEmptyText: {
    flex: 1,
    fontSize: 12,
    color: Colors.textMuted,
    lineHeight: 17,
  },
  queueList: {
    gap: 10,
    marginBottom: 22,
  },
  activeTaskCard: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
  },
  taskTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  taskTitleGroup: {
    flex: 1,
    marginRight: 8,
  },
  taskNovelTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  taskChapterTitle: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  taskPercent: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
  },
  progressBg: {
    height: 4,
    backgroundColor: Colors.surfaceRaised,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.primary,
  },
  taskFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  taskCountText: {
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
    backgroundColor: Colors.surfaceRaised,
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
  novelItemCard: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    marginBottom: 12,
  },
  novelRowTop: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  novelCover: {
    width: 55,
    height: 80,
    borderRadius: 6,
    backgroundColor: Colors.surfaceLight,
  },
  novelInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  novelTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    lineHeight: 18,
  },
  novelAuthor: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  savedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
  },
  savedBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.primary,
  },
  novelActionsRow: {
    flexDirection: 'row',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 10,
  },
  actionButtonPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 4,
  },
  actionButtonPrimaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0D0F14',
  },
  actionButtonSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surfaceRaised,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  actionButtonSecondaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.text,
  },
  actionButtonDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.dangerMuted,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  actionButtonDangerText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.danger,
  },
  actionButtonDisabled: {
    opacity: 0.6,
  },
  loadingWrapper: {
    paddingTop: 40,
    alignItems: 'center',
  },
  emptyContainer: {
    paddingTop: 40,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
    marginTop: 12,
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
});
