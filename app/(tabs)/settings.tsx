import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors, ReaderThemes, ReaderThemeMode } from '../../src/theme/colors';
import { Novel, ReaderSettings, StorageUsageStats } from '../../src/types';
import { APP_CONFIG, LNCRAWL_API_BASE } from '../../src/config';
import {
  getDownloadedNovels,
  deleteDownloadedChapters,
} from '../../src/services/database';
import {
  calculateStorageUsage,
  formatBytes,
  deleteLocalCover,
} from '../../src/services/fileStorage';
import { getReaderSettings, saveReaderSettings } from '../../src/services/storage';
import {
  runSourceDiagnostic,
  Source,
  SourceDiagnosticResult,
  SOURCES,
} from '../../src/sources';

export default function SettingsScreen() {
  const router = useRouter();
  const [novels, setNovels] = useState<Novel[]>([]);
  const [stats, setStats] = useState<StorageUsageStats | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>({
    theme: 'dark',
    fontSize: 18,
    lineSpacing: 1.8,
    fontFamily: 'serif',
  });

  // Sources diagnostic state
  const [runningDiagnostics, setRunningDiagnostics] = useState<Record<string, boolean>>({});
  const [diagnosticResults, setDiagnosticResults] = useState<
    Record<string, SourceDiagnosticResult>
  >({});

  const loadSettingsData = useCallback(async () => {
    try {
      const [downloaded, usage, savedReader] = await Promise.all([
        getDownloadedNovels(),
        calculateStorageUsage(),
        getReaderSettings(),
      ]);
      setNovels(downloaded);
      setStats(usage);
      setReaderSettings(savedReader);
    } catch (err) {
      console.warn('Error loading settings data:', err);
    } finally {
      setLoadingStorage(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadSettingsData();
    }, [loadSettingsData])
  );

  const updateReaderSetting = async <K extends keyof ReaderSettings>(
    key: K,
    val: ReaderSettings[K]
  ) => {
    const updated = { ...readerSettings, [key]: val };
    setReaderSettings(updated);
    await saveReaderSettings(updated);
  };

  const handleTestSingleSource = async (source: Source) => {
    setRunningDiagnostics((prev) => ({ ...prev, [source.id]: true }));
    try {
      const result = await runSourceDiagnostic(source);
      setDiagnosticResults((prev) => ({ ...prev, [source.id]: result }));
    } finally {
      setRunningDiagnostics((prev) => ({ ...prev, [source.id]: false }));
    }
  };

  const handleTestAllSources = async () => {
    const loadingMap: Record<string, boolean> = {};
    for (const s of SOURCES) {
      loadingMap[s.id] = true;
    }
    setRunningDiagnostics((prev) => ({ ...prev, ...loadingMap }));

    await Promise.allSettled(
      SOURCES.map(async (source) => {
        try {
          const result = await runSourceDiagnostic(source);
          setDiagnosticResults((prev) => ({ ...prev, [source.id]: result }));
        } finally {
          setRunningDiagnostics((prev) => ({ ...prev, [source.id]: false }));
        }
      })
    );
  };

  const isAnyDiagnosticRunning = Object.values(runningDiagnostics).some(Boolean);

  const handleDeleteNovelStorage = (novel: Novel) => {
    Alert.alert(
      'Delete Offline Downloads?',
      `Remove all downloaded chapters for "${novel.title}" to free up storage? Your reading progress remains saved.`,
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
              await loadSettingsData();
            } catch (err) {
              console.warn('Failed to delete downloads:', err);
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.screenTitle}>Settings</Text>
        <Text style={styles.screenSubtitle}>
          Storage management, local source diagnostics, reading preferences, and backend details
        </Text>

        {/* Storage Management Category */}
        <Text style={styles.sectionTitle}>STORAGE MANAGEMENT</Text>
        <View style={styles.statsCard}>
          <View style={styles.statsHeader}>
            <View style={styles.storageIconWrapper}>
              <Ionicons name="pie-chart" size={20} color={Colors.primary} />
            </View>
            <View>
              <Text style={styles.statsMainValue}>
                {stats ? formatBytes(stats.totalSizeBytes) : 'Calculating...'}
              </Text>
              <Text style={styles.statsMainLabel}>Total App Storage Used</Text>
            </View>
          </View>

          <View style={styles.statsDivider} />

          <View style={styles.statsRow}>
            <View style={styles.statCol}>
              <Text style={styles.statColValue}>
                {stats ? formatBytes(stats.databaseSizeBytes) : '0 B'}
              </Text>
              <Text style={styles.statColLabel}>SQLite Text DB</Text>
            </View>

            <View style={styles.statColDivider} />

            <View style={styles.statCol}>
              <Text style={styles.statColValue}>
                {stats ? formatBytes(stats.coversSizeBytes) : '0 B'}
              </Text>
              <Text style={styles.statColLabel}>Cover Images</Text>
            </View>

            <View style={styles.statColDivider} />

            <View style={styles.statCol}>
              <Text style={styles.statColValue}>
                {stats ? stats.downloadedChaptersCount : 0}
              </Text>
              <Text style={styles.statColLabel}>Chapters Saved</Text>
            </View>
          </View>
        </View>

        <View style={styles.privacyNotice}>
          <Ionicons name="shield-checkmark" size={16} color={Colors.success} />
          <Text style={styles.privacyNoticeText}>
            Chapters are stored in app-private SQLite ({stats?.downloadedNovelsCount ?? 0} novels) and covers in sandboxed app storage.
          </Text>
        </View>

        {loadingStorage ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={Colors.primary} />
          </View>
        ) : novels.length > 0 ? (
          <View style={styles.storageListCard}>
            {novels.map((novel, idx) => (
              <View
                key={novel.id}
                style={[
                  styles.storageNovelRow,
                  idx === novels.length - 1 && styles.storageNovelRowLast,
                ]}
              >
                <Pressable
                  style={styles.storageNovelInfo}
                  onPress={() =>
                    router.push({
                      pathname: '/novel/[id]',
                      params: { id: novel.id },
                    })
                  }
                >
                  <Text style={styles.storageNovelTitle} numberOfLines={1}>
                    {novel.title}
                  </Text>
                  <Text style={styles.storageNovelMeta}>
                    {novel.downloadedChaptersCount || 0} chapters saved
                  </Text>
                </Pressable>

                <Pressable
                  style={styles.deleteNovelBtn}
                  onPress={() => handleDeleteNovelStorage(novel)}
                  hitSlop={8}
                >
                  <Ionicons name="trash-outline" size={16} color={Colors.danger} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {/* Sources Section & Diagnostic */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>SOURCES</Text>
          <Pressable
            style={[
              styles.testAllBtn,
              isAnyDiagnosticRunning && styles.testAllBtnDisabled,
            ]}
            onPress={handleTestAllSources}
            disabled={isAnyDiagnosticRunning}
          >
            {isAnyDiagnosticRunning ? (
              <ActivityIndicator size="small" color="#0D0F14" />
            ) : (
              <>
                <Ionicons name="pulse-outline" size={14} color="#0D0F14" />
                <Text style={styles.testAllBtnText}>Test source</Text>
              </>
            )}
          </Pressable>
        </View>

        <View style={styles.sourcesCard}>
          <Text style={styles.sourcesIntro}>
            Diagnostic checks search ("love"), novel page, chapter list, and first chapter text directly from your phone.
          </Text>

          {SOURCES.map((source, idx) => {
            const isTesting = Boolean(runningDiagnostics[source.id]);
            const diag = diagnosticResults[source.id];
            const isLast = idx === SOURCES.length - 1;

            return (
              <View
                key={source.id}
                style={[styles.sourceItemRow, isLast && styles.sourceItemRowLast]}
              >
                <View style={styles.sourceItemHeader}>
                  <View style={styles.sourceItemInfo}>
                    <Text style={styles.sourceItemName}>{source.name}</Text>
                    <Text style={styles.sourceItemSite} numberOfLines={1}>
                      {source.site}
                    </Text>
                  </View>

                  <View style={styles.sourceItemActions}>
                    {diag && !isTesting && (
                      <View
                        style={[
                          styles.diagBadge,
                          diag.passed ? styles.diagBadgePass : styles.diagBadgeFail,
                        ]}
                      >
                        <Text
                          style={[
                            styles.diagBadgeText,
                            diag.passed
                              ? styles.diagBadgeTextPass
                              : styles.diagBadgeTextFail,
                          ]}
                        >
                          {diag.passed ? 'PASS' : 'FAIL'}
                        </Text>
                      </View>
                    )}

                    <Pressable
                      style={styles.singleTestBtn}
                      onPress={() => handleTestSingleSource(source)}
                      disabled={isTesting}
                    >
                      {isTesting ? (
                        <ActivityIndicator size="small" color={Colors.primary} />
                      ) : (
                        <Text style={styles.singleTestBtnText}>Test</Text>
                      )}
                    </Pressable>
                  </View>
                </View>

                {diag && (
                  <View style={styles.diagStepsBox}>
                    {diag.steps.map((st, sIdx) => (
                      <View key={`${source.id}-${st.step}-${sIdx}`} style={styles.diagStepRow}>
                        <Ionicons
                          name={st.passed ? 'checkmark-circle' : 'close-circle'}
                          size={14}
                          color={st.passed ? Colors.success : Colors.danger}
                        />
                        <Text
                          style={[
                            styles.diagStepLabel,
                            !st.passed && styles.diagStepLabelFail,
                          ]}
                        >
                          {st.passed ? 'PASS' : 'FAIL'} • {st.label}:
                        </Text>
                        <Text style={styles.diagStepDetail}>
                          {st.httpStatus ? `[HTTP ${st.httpStatus}] ` : ''}
                          {st.detail}
                        </Text>
                      </View>
                    ))}
                    <Text style={styles.diagDurationText}>
                      Completed in {(diag.durationMs / 1000).toFixed(2)}s
                    </Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>

        {/* Default Reading Preferences Category (persisted via storage.ts) */}
        <Text style={styles.sectionTitle}>READING PREFERENCES</Text>
        <View style={styles.prefsCard}>
          <Text style={styles.prefLabel}>DEFAULT THEME</Text>
          <View style={styles.themeRow}>
            {(['dark', 'sepia', 'light'] as ReaderThemeMode[]).map((mode) => {
              const isSelected = readerSettings.theme === mode;
              const t = ReaderThemes[mode];
              return (
                <Pressable
                  key={mode}
                  style={[
                    styles.themeOptionCard,
                    {
                      backgroundColor: t.background,
                      borderColor: isSelected ? Colors.primary : t.border,
                    },
                  ]}
                  onPress={() => updateReaderSetting('theme', mode)}
                >
                  <Text style={[styles.themeOptionText, { color: t.text }]}>
                    {t.name}
                  </Text>
                  {isSelected && (
                    <Ionicons name="checkmark-circle" size={15} color={Colors.primary} />
                  )}
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.prefLabel}>
            DEFAULT FONT SIZE ({readerSettings.fontSize}pt)
          </Text>
          <View style={styles.sizeControlRow}>
            <Pressable
              style={styles.sizeStepButton}
              onPress={() =>
                updateReaderSetting('fontSize', Math.max(14, readerSettings.fontSize - 1))
              }
            >
              <Text style={styles.sizeStepButtonText}>A-</Text>
            </Pressable>
            <View style={styles.sizeDisplay}>
              <Text style={styles.sizeDisplayText}>{readerSettings.fontSize} pt</Text>
            </View>
            <Pressable
              style={styles.sizeStepButton}
              onPress={() =>
                updateReaderSetting('fontSize', Math.min(28, readerSettings.fontSize + 1))
              }
            >
              <Text style={styles.sizeStepButtonText}>A+</Text>
            </Pressable>
          </View>

          <Text style={styles.prefLabel}>LINE SPACING</Text>
          <View style={styles.optionRow}>
            {[
              { label: 'Compact', val: 1.5 },
              { label: 'Normal', val: 1.8 },
              { label: 'Relaxed', val: 2.2 },
            ].map((sp) => {
              const isSelected = readerSettings.lineSpacing === sp.val;
              return (
                <Pressable
                  key={sp.label}
                  style={[styles.chipOption, isSelected && styles.chipOptionSelected]}
                  onPress={() => updateReaderSetting('lineSpacing', sp.val)}
                >
                  <Text
                    style={[
                      styles.chipOptionText,
                      isSelected && styles.chipOptionTextSelected,
                    ]}
                  >
                    {sp.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.prefLabel}>TYPEFACE</Text>
          <View style={styles.optionRow}>
            {[
              { label: 'Serif', val: 'serif' as const },
              { label: 'Sans', val: 'default' as const },
              { label: 'Mono', val: 'monospace' as const },
            ].map((f) => {
              const isSelected = readerSettings.fontFamily === f.val;
              return (
                <Pressable
                  key={f.label}
                  style={[styles.chipOption, isSelected && styles.chipOptionSelected]}
                  onPress={() => updateReaderSetting('fontFamily', f.val)}
                >
                  <Text
                    style={[
                      styles.chipOptionText,
                      isSelected && styles.chipOptionTextSelected,
                    ]}
                  >
                    {f.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Backend & App Info */}
        <Text style={styles.sectionTitle}>BACKEND & APPLICATION</Text>
        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Version</Text>
            <Text style={styles.infoValue}>
              {APP_CONFIG.name} v{APP_CONFIG.version}
            </Text>
          </View>
          <View style={styles.infoDivider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>LNCrawl API</Text>
            <Text style={styles.infoValueMono} numberOfLines={1}>
              {LNCRAWL_API_BASE}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 40,
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
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 1,
    marginBottom: 8,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 6,
  },
  testAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  testAllBtnDisabled: {
    opacity: 0.6,
  },
  testAllBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0D0F14',
  },
  statsCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    marginBottom: 12,
  },
  statsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  storageIconWrapper: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsMainValue: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
  },
  statsMainLabel: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  statsDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 14,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statCol: {
    flex: 1,
    alignItems: 'center',
  },
  statColDivider: {
    width: 1,
    backgroundColor: Colors.border,
  },
  statColValue: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 2,
  },
  statColLabel: {
    fontSize: 10,
    color: Colors.textMuted,
  },
  privacyNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 14,
  },
  privacyNoticeText: {
    flex: 1,
    fontSize: 11,
    color: Colors.textSecondary,
    lineHeight: 16,
  },
  loadingRow: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  storageListCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    marginBottom: 22,
  },
  storageNovelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  storageNovelRowLast: {
    borderBottomWidth: 0,
  },
  storageNovelInfo: {
    flex: 1,
    marginRight: 12,
  },
  storageNovelTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
  },
  storageNovelMeta: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  deleteNovelBtn: {
    padding: 8,
    borderRadius: 6,
    backgroundColor: Colors.dangerMuted,
  },
  sourcesCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    marginBottom: 22,
  },
  sourcesIntro: {
    fontSize: 11,
    color: Colors.textMuted,
    lineHeight: 16,
    marginBottom: 10,
  },
  sourceItemRow: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  sourceItemRowLast: {
    paddingBottom: 2,
  },
  sourceItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  sourceItemInfo: {
    flex: 1,
  },
  sourceItemName: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  sourceItemSite: {
    fontSize: 11,
    color: Colors.textMuted,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  sourceItemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  diagBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  diagBadgePass: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  diagBadgeFail: {
    backgroundColor: Colors.dangerMuted,
    borderColor: 'rgba(239, 68, 68, 0.45)',
  },
  diagBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  diagBadgeTextPass: {
    color: Colors.success,
  },
  diagBadgeTextFail: {
    color: Colors.danger,
  },
  singleTestBtn: {
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    minWidth: 52,
    alignItems: 'center',
  },
  singleTestBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.primary,
  },
  diagStepsBox: {
    marginTop: 10,
    backgroundColor: Colors.background,
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 6,
  },
  diagStepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  diagStepLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.success,
  },
  diagStepLabelFail: {
    color: Colors.danger,
  },
  diagStepDetail: {
    flex: 1,
    fontSize: 11,
    color: Colors.textSecondary,
    lineHeight: 15,
  },
  diagDurationText: {
    fontSize: 10,
    color: Colors.textMuted,
    marginTop: 2,
    fontFamily: 'monospace',
  },
  prefsCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    marginBottom: 22,
  },
  prefLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 8,
  },
  themeRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  themeOptionCard: {
    flex: 1,
    paddingVertical: 10,
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
    marginBottom: 8,
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
  optionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  chipOption: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipOptionSelected: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  chipOptionText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  chipOptionTextSelected: {
    color: Colors.primary,
  },
  infoCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  infoLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: '600',
  },
  infoValue: {
    fontSize: 12,
    color: Colors.text,
    fontWeight: '600',
  },
  infoValueMono: {
    flex: 1,
    textAlign: 'right',
    fontSize: 11,
    fontFamily: 'monospace',
    color: Colors.textSecondary,
  },
  infoDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 10,
  },
});
