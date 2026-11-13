import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Modal,
  NativeSyntheticEvent,
  NativeScrollEvent,
  Animated,
  Dimensions,
  Alert,
  LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ReaderThemes, ReaderThemeMode, Colors } from '../../src/theme/colors';
import { Chapter, Novel, ReaderSettings } from '../../src/types';
import {
  getChapterById,
  saveChapter,
  getChaptersForNovel,
  getNovelById,
  saveReadingProgress,
  getReadingProgress,
} from '../../src/services/database';
import {
  getReaderSettings,
  saveReaderSettings,
  setLastReadNovelId,
} from '../../src/services/storage';
import { LNCrawlService } from '../../src/services/lncrawl';
import { DownloadManager } from '../../src/services/downloadManager';

const { width } = Dimensions.get('window');

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function parseChapterParagraphs(rawContent: string): string[] {
  if (!rawContent) return [];
  const normalized = rawContent
    .replace(/\r\n/g, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|blockquote|section|article|tr|hr)[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  const decoded = decodeHtmlEntities(normalized);
  const chunks = decoded.includes('\n\n') ? decoded.split(/\n\s*\n/) : decoded.split(/\n/);

  return chunks.map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

export default function ReaderScreen() {
  const router = useRouter();
  const { id: chapterId, novelId } = useLocalSearchParams<{
    id: string;
    novelId: string;
  }>();

  const scrollViewRef = useRef<ScrollView>(null);

  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [novel, setNovel] = useState<Novel | null>(null);
  const [chaptersList, setChaptersList] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Appearance & Reader Settings
  const [settings, setSettings] = useState<ReaderSettings>({
    theme: 'dark',
    fontSize: 18,
    lineSpacing: 1.8,
    fontFamily: 'serif',
  });
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);

  // Chrome UI Visibility (Header & Footer)
  const [barsVisible, setBarsVisible] = useState(true);
  const barsAnim = useRef(new Animated.Value(1)).current;

  // Scroll Position Memory
  const scrollOffsetRef = useRef<number>(0);
  const pendingScrollOffsetRef = useRef<number | null>(null);
  const scrollReadyRef = useRef<{ layoutH: number; contentH: number }>({
    layoutH: 0,
    contentH: 0,
  });
  const pendingProgressSaveRef = useRef<{
    novelId: string;
    chapterId: string;
    chapterTitle: string;
    chapterSerial: number;
    scrollOffset: number;
    scrollPercentage: number;
  } | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active theme tokens
  const currentTheme = ReaderThemes[settings.theme] || ReaderThemes.dark;

  const flushPendingProgress = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const pending = pendingProgressSaveRef.current;
    if (pending) {
      pendingProgressSaveRef.current = null;
      saveReadingProgress({
        ...pending,
        updatedAt: Date.now(),
      }).catch(() => {});
    }
  }, []);

  // Load Chapter & Settings
  const loadChapter = useCallback(async (targetChapterId: string) => {
    setLoading(true);
    setError(null);
    pendingScrollOffsetRef.current = null;
    scrollReadyRef.current = { layoutH: 0, contentH: 0 };

    try {
      const savedSettings = await getReaderSettings();
      setSettings(savedSettings);

      // 1. Load Novel metadata
      if (novelId) {
        const novelData = await getNovelById(novelId);
        setNovel(novelData);
        const list = await getChaptersForNovel(novelId);
        setChaptersList(list);
        await setLastReadNovelId(novelId);
      }

      // 2. Load Chapter from local SQLite first
      let ch = await getChapterById(targetChapterId);

      // If chapter text not downloaded locally, fetch from LNCrawl API
      if (!ch || !ch.content) {
        try {
          const fetched = await LNCrawlService.fetchChapterContent(targetChapterId);
          const fullChapter: Chapter = {
            id: targetChapterId,
            novelId: novelId || ch?.novelId || '',
            serial: ch?.serial || 1,
            title:
              fetched.title && fetched.title !== 'Chapter Content'
                ? fetched.title
                : ch?.title || `Chapter ${ch?.serial || 1}`,
            content: fetched.content,
            wordsCount: fetched.wordCount ?? ch?.wordsCount,
            isDownloaded: true,
          };
          await saveChapter(fullChapter);
          ch = fullChapter;
        } catch (fetchErr: any) {
          if (!ch?.content) {
            setError(
              fetchErr.message ||
                'Unable to load chapter content. Check your network or download chapters for offline reading.'
            );
          }
        }
      }

      if (ch?.content) {
        // Best-effort sync to server read history when online & authenticated
        LNCrawlService.markChapterRead(targetChapterId).catch(() => {});
      }

      setChapter(ch);

      // 3. Restore scroll position memory for this novel
      const effectiveNovelId = novelId || ch?.novelId;
      if (effectiveNovelId && ch?.content) {
        await setLastReadNovelId(effectiveNovelId);
        const lastProgress = await getReadingProgress(effectiveNovelId);
        if (
          lastProgress &&
          lastProgress.chapterId === targetChapterId &&
          lastProgress.scrollOffset > 0
        ) {
          pendingScrollOffsetRef.current = lastProgress.scrollOffset;
          scrollOffsetRef.current = lastProgress.scrollOffset;
        } else {
          // Record chapter switch immediately so Continue Reading reflects current chapter
          await saveReadingProgress({
            novelId: effectiveNovelId,
            chapterId: ch.id,
            chapterTitle: ch.title,
            chapterSerial: ch.serial,
            scrollOffset: 0,
            scrollPercentage: 0,
            updatedAt: Date.now(),
          });
        }
      }
    } catch (e: any) {
      console.warn('Reader load error:', e);
      setError(e.message || 'Error loading reader.');
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    if (chapterId) {
      loadChapter(chapterId);
    }
    return () => {
      flushPendingProgress();
    };
  }, [chapterId, loadChapter, flushPendingProgress]);

  const tryRestoreScrollPosition = useCallback(() => {
    const targetY = pendingScrollOffsetRef.current;
    if (
      targetY !== null &&
      targetY > 0 &&
      scrollViewRef.current &&
      scrollReadyRef.current.layoutH > 0 &&
      scrollReadyRef.current.contentH > 0
    ) {
      pendingScrollOffsetRef.current = null;
      requestAnimationFrame(() => {
        scrollViewRef.current?.scrollTo({ y: targetY, animated: false });
      });
    }
  }, []);

  const handleScrollViewLayout = (e: LayoutChangeEvent) => {
    scrollReadyRef.current.layoutH = e.nativeEvent.layout.height;
    tryRestoreScrollPosition();
  };

  const handleContentSizeChange = (_w: number, h: number) => {
    scrollReadyRef.current.contentH = h;
    tryRestoreScrollPosition();
  };

  // Handle scroll position saving
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const currentY = contentOffset.y;
    scrollOffsetRef.current = currentY;

    const maxScroll = Math.max(1, contentSize.height - layoutMeasurement.height);
    const percentage = Math.min(100, Math.max(0, (currentY / maxScroll) * 100));

    const effectiveNovelId = novelId || chapter?.novelId;
    if (effectiveNovelId && chapter) {
      pendingProgressSaveRef.current = {
        novelId: effectiveNovelId,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        chapterSerial: chapter.serial,
        scrollOffset: currentY,
        scrollPercentage: percentage,
      };
    }

    // Debounce save to database
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      const pending = pendingProgressSaveRef.current;
      if (pending) {
        pendingProgressSaveRef.current = null;
        await saveReadingProgress({
          ...pending,
          updatedAt: Date.now(),
        });
      }
    }, 400);
  };

  const toggleBars = () => {
    const toValue = barsVisible ? 0 : 1;
    Animated.timing(barsAnim, {
      toValue,
      duration: 180,
      useNativeDriver: true,
    }).start(() => setBarsVisible(!barsVisible));
  };

  const updateSetting = async <K extends keyof ReaderSettings>(
    key: K,
    val: ReaderSettings[K]
  ) => {
    const updated = { ...settings, [key]: val };
    setSettings(updated);
    await saveReaderSettings(updated);
  };

  // Next / Previous Chapter Navigation
  const currentIndex = chaptersList.findIndex((c) => c.id === chapter?.id);
  const prevChapter = currentIndex > 0 ? chaptersList[currentIndex - 1] : null;
  const nextChapter =
    currentIndex >= 0 && currentIndex < chaptersList.length - 1
      ? chaptersList[currentIndex + 1]
      : null;

  const navigateToChapter = (target: Chapter | null) => {
    if (!target) return;
    flushPendingProgress();
    router.replace({
      pathname: '/reader/[id]',
      params: { id: target.id, novelId: novelId || chapter?.novelId },
    });
  };

  const handleDownloadCurrentChapter = async () => {
    if (!chapter) return;
    const targetNovel: Novel = novel || {
      id: novelId || chapter.novelId,
      title: 'Novel',
      author: 'Unknown',
      synopsis: '',
      coverUrl: '',
      genres: [],
      status: 'Ongoing',
      totalChapters: chaptersList.length,
    };
    try {
      const updated = await DownloadManager.downloadSingleChapter(targetNovel, chapter);
      setChapter(updated);
    } catch (err: any) {
      Alert.alert('Download Error', err?.message || 'Failed to download chapter.');
    }
  };

  // Format content paragraphs cleanly (handles both HTML and plain text)
  const paragraphs = parseChapterParagraphs(chapter?.content || '');

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: currentTheme.background }]}>
        <ActivityIndicator size="large" color={currentTheme.accent} />
        <Text style={[styles.loadingText, { color: currentTheme.textSecondary }]}>
          Opening Chapter...
        </Text>
      </View>
    );
  }

  if (error || !chapter) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: currentTheme.background }]}>
        <Ionicons name="cloud-offline-outline" size={48} color={currentTheme.textSecondary} />
        <Text style={[styles.errorTitle, { color: currentTheme.text }]}>Chapter Unavailable</Text>
        <Text style={[styles.errorSubtitle, { color: currentTheme.textSecondary }]}>{error}</Text>
        <Pressable
          style={[styles.retryButton, { backgroundColor: currentTheme.accent }]}
          onPress={() => chapterId && loadChapter(chapterId)}
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
        <Pressable style={styles.backButtonSimple} onPress={() => router.back()}>
          <Text style={[styles.backButtonSimpleText, { color: currentTheme.textSecondary }]}>
            Go Back
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: currentTheme.background }]}
      edges={['left', 'right']}
    >
      {/* Top Header Bar */}
      <Animated.View
        style={[
          styles.topBar,
          {
            backgroundColor: currentTheme.surface,
            borderBottomColor: currentTheme.border,
            opacity: barsAnim,
            transform: [
              {
                translateY: barsAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-60, 0],
                }),
              },
            ],
          },
        ]}
      >
        <Pressable style={styles.barIconButton} onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="arrow-back" size={22} color={currentTheme.text} />
        </Pressable>

        <View style={styles.topBarTitleContainer}>
          <Text style={[styles.topBarNovelTitle, { color: currentTheme.textSecondary }]} numberOfLines={1}>
            {novel?.title || 'Novel Reader'}
          </Text>
          <Text style={[styles.topBarChapterTitle, { color: currentTheme.text }]} numberOfLines={1}>
            {chapter.title}
          </Text>
        </View>

        <View style={styles.topBarActions}>
          {/* Download offline button */}
          <Pressable
            style={styles.barIconButton}
            onPress={handleDownloadCurrentChapter}
            hitSlop={10}
          >
            <Ionicons
              name={chapter.isDownloaded ? 'checkmark-circle' : 'cloud-download-outline'}
              size={20}
              color={chapter.isDownloaded ? Colors.success : currentTheme.text}
            />
          </Pressable>

          {/* Reader settings button */}
          <Pressable
            style={styles.barIconButton}
            onPress={() => setSettingsModalVisible(true)}
            hitSlop={10}
          >
            <Ionicons name="options-outline" size={20} color={currentTheme.text} />
          </Pressable>
        </View>
      </Animated.View>

      {/* Main Reading Text ScrollView */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        onLayout={handleScrollViewLayout}
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        scrollEventThrottle={64}
      >
        {/* Tap area to toggle bars */}
        <Pressable onPress={toggleBars}>
          <View style={styles.readingHeader}>
            <Text style={[styles.chapterHeading, { color: currentTheme.accent }]}>
              Chapter {chapter.serial}
            </Text>
            <Text style={[styles.chapterFullTitle, { color: currentTheme.text }]}>
              {chapter.title}
            </Text>
            <View style={[styles.headingDivider, { backgroundColor: currentTheme.border }]} />
          </View>

          {/* Chapter Paragraphs */}
          <View style={styles.textContainer}>
            {paragraphs.map((p, index) => (
              <Text
                key={index}
                style={[
                  styles.paragraph,
                  {
                    color: currentTheme.text,
                    fontSize: settings.fontSize,
                    lineHeight: settings.fontSize * settings.lineSpacing,
                    fontFamily:
                      settings.fontFamily === 'serif'
                        ? 'serif'
                        : settings.fontFamily === 'monospace'
                        ? 'monospace'
                        : undefined,
                  },
                ]}
              >
                {p}
              </Text>
            ))}
          </View>
        </Pressable>

        {/* Bottom Chapter Navigation inside ScrollView */}
        <View style={[styles.navFooterInScroll, { borderTopColor: currentTheme.border }]}>
          <Pressable
            style={[
              styles.navChapterBtn,
              !prevChapter && styles.navChapterBtnDisabled,
              { backgroundColor: currentTheme.surface, borderColor: currentTheme.border },
            ]}
            onPress={() => navigateToChapter(prevChapter)}
            disabled={!prevChapter}
          >
            <Ionicons
              name="chevron-back"
              size={16}
              color={prevChapter ? currentTheme.text : currentTheme.textSecondary}
            />
            <Text
              style={[
                styles.navChapterBtnText,
                { color: prevChapter ? currentTheme.text : currentTheme.textSecondary },
              ]}
            >
              Previous
            </Text>
          </Pressable>

          <Text style={[styles.chapterCounter, { color: currentTheme.textSecondary }]}>
            {currentIndex >= 0 ? `${currentIndex + 1} / ${chaptersList.length}` : ''}
          </Text>

          <Pressable
            style={[
              styles.navChapterBtn,
              !nextChapter && styles.navChapterBtnDisabled,
              { backgroundColor: currentTheme.surface, borderColor: currentTheme.border },
            ]}
            onPress={() => navigateToChapter(nextChapter)}
            disabled={!nextChapter}
          >
            <Text
              style={[
                styles.navChapterBtnText,
                { color: nextChapter ? currentTheme.text : currentTheme.textSecondary },
              ]}
            >
              Next
            </Text>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={nextChapter ? currentTheme.text : currentTheme.textSecondary}
            />
          </Pressable>
        </View>
      </ScrollView>

      {/* Reader Settings Modal */}
      <Modal
        visible={settingsModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSettingsModalVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setSettingsModalVisible(false)}
        >
          <Pressable
            style={[styles.modalSheet, { backgroundColor: Colors.surface, borderColor: Colors.border }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Reader Appearance</Text>
              <Pressable onPress={() => setSettingsModalVisible(false)} hitSlop={10}>
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>

            {/* Themes Selection */}
            <Text style={styles.settingGroupLabel}>THEME</Text>
            <View style={styles.themeRow}>
              {(['dark', 'sepia', 'light'] as ReaderThemeMode[]).map((mode) => {
                const isSelected = settings.theme === mode;
                const t = ReaderThemes[mode];
                return (
                  <Pressable
                    key={mode}
                    style={[
                      styles.themeOptionCard,
                      { backgroundColor: t.background, borderColor: isSelected ? Colors.primary : t.border },
                    ]}
                    onPress={() => updateSetting('theme', mode)}
                  >
                    <Text style={[styles.themeOptionText, { color: t.text }]}>
                      {t.name}
                    </Text>
                    {isSelected && (
                      <Ionicons name="checkmark-circle" size={16} color={Colors.primary} />
                    )}
                  </Pressable>
                );
              })}
            </View>

            {/* Font Size Adjuster */}
            <Text style={styles.settingGroupLabel}>FONT SIZE ({settings.fontSize}px)</Text>
            <View style={styles.sizeControlRow}>
              <Pressable
                style={styles.sizeStepButton}
                onPress={() => updateSetting('fontSize', Math.max(14, settings.fontSize - 1))}
              >
                <Text style={styles.sizeStepButtonText}>A-</Text>
              </Pressable>

              <View style={styles.sizeDisplay}>
                <Text style={styles.sizeDisplayText}>{settings.fontSize} pt</Text>
              </View>

              <Pressable
                style={styles.sizeStepButton}
                onPress={() => updateSetting('fontSize', Math.min(28, settings.fontSize + 1))}
              >
                <Text style={styles.sizeStepButtonText}>A+</Text>
              </Pressable>
            </View>

            {/* Line Spacing Adjuster */}
            <Text style={styles.settingGroupLabel}>LINE SPACING</Text>
            <View style={styles.spacingRow}>
              {[
                { label: 'Compact', val: 1.5 },
                { label: 'Normal', val: 1.8 },
                { label: 'Relaxed', val: 2.2 },
              ].map((sp) => {
                const isSelected = settings.lineSpacing === sp.val;
                return (
                  <Pressable
                    key={sp.label}
                    style={[
                      styles.spacingOption,
                      isSelected && styles.spacingOptionSelected,
                    ]}
                    onPress={() => updateSetting('lineSpacing', sp.val)}
                  >
                    <Text
                      style={[
                        styles.spacingOptionText,
                        isSelected && styles.spacingOptionTextSelected,
                      ]}
                    >
                      {sp.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Font Family Adjuster */}
            <Text style={styles.settingGroupLabel}>TYPEFACE</Text>
            <View style={styles.fontFamilyRow}>
              {[
                { label: 'Serif', val: 'serif' as const },
                { label: 'Sans', val: 'default' as const },
                { label: 'Mono', val: 'monospace' as const },
              ].map((f) => {
                const isSelected = settings.fontFamily === f.val;
                return (
                  <Pressable
                    key={f.label}
                    style={[
                      styles.fontFamilyOption,
                      isSelected && styles.fontFamilyOptionSelected,
                    ]}
                    onPress={() => updateSetting('fontFamily', f.val)}
                  >
                    <Text
                      style={[
                        styles.fontFamilyOptionText,
                        isSelected && styles.fontFamilyOptionTextSelected,
                      ]}
                    >
                      {f.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    fontSize: 14,
    marginTop: 12,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  errorSubtitle: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0D0F14',
  },
  backButtonSimple: {
    padding: 8,
  },
  backButtonSimpleText: {
    fontSize: 13,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    zIndex: 10,
  },
  barIconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  topBarTitleContainer: {
    flex: 1,
    marginHorizontal: 8,
  },
  topBarNovelTitle: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  topBarChapterTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  topBarActions: {
    flexDirection: 'row',
    gap: 4,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 70,
    paddingBottom: 60,
    paddingHorizontal: 20,
  },
  readingHeader: {
    marginBottom: 24,
  },
  chapterHeading: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  chapterFullTitle: {
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 28,
    marginBottom: 12,
  },
  headingDivider: {
    height: 1,
    width: '100%',
  },
  textContainer: {
    marginBottom: 32,
  },
  paragraph: {
    marginBottom: 20,
    textAlign: 'left',
  },
  navFooterInScroll: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    paddingTop: 24,
    marginTop: 16,
    marginBottom: 40,
  },
  navChapterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
  },
  navChapterBtnDisabled: {
    opacity: 0.4,
  },
  navChapterBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  chapterCounter: {
    fontSize: 12,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    padding: 20,
    paddingBottom: 36,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
  },
  settingGroupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 0.8,
    marginTop: 12,
    marginBottom: 8,
  },
  themeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  themeOptionCard: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  themeOptionText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sizeControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sizeStepButton: {
    backgroundColor: Colors.surfaceRaised,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sizeStepButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
  },
  sizeDisplay: {
    flex: 1,
    alignItems: 'center',
  },
  sizeDisplayText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.text,
  },
  spacingRow: {
    flexDirection: 'row',
    gap: 8,
  },
  spacingOption: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  spacingOptionSelected: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  spacingOptionText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  spacingOptionTextSelected: {
    color: Colors.primary,
  },
  fontFamilyRow: {
    flexDirection: 'row',
    gap: 8,
  },
  fontFamilyOption: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  fontFamilyOptionSelected: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  fontFamilyOptionText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  fontFamilyOptionTextSelected: {
    color: Colors.primary,
  },
});
