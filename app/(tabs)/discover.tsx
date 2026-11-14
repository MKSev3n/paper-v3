import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  Pressable,
  Image,
  ActivityIndicator,
  Keyboard,
  Modal,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../src/theme/colors';
import {
  Chapter,
  LNCrawlUser,
  Novel,
  SearchProviderId,
} from '../../src/types';
import {
  LNCrawlService,
  normalizeSearchTitle,
  processSearchResults,
} from '../../src/services/lncrawl';
import { API_URL, APP_CONFIG } from '../../src/config';
import { saveChaptersBatch, upsertNovel } from '../../src/services/database';
import { getDiscoverProviders, saveDiscoverProviders } from '../../src/services/storage';
import {
  buildLocalChapterId,
  buildLocalNovelId,
  extractSourceDomain,
  getSource,
  matchSourceByUrl,
  Source,
  SOURCES,
  toAbsoluteUrl,
} from '../../src/sources';

const QUICK_TAGS = ['Fantasy', 'Isekai', 'Action', 'Adventure', 'Romance', 'Cultivation', 'Sci-Fi'];
const LOCAL_SEARCH_TIMEOUT_MS = 15000;

const PROVIDER_CHIPS: { id: SearchProviderId; label: string }[] = [
  { id: 'readnovelfull', label: 'ReadNovelFull' },
  { id: 'novelfull', label: 'NovelFull' },
  { id: 'novelbin', label: 'NovelBin' },
  { id: 'lncrawl', label: 'Server (slow)' },
];

interface UnifiedSearchResult {
  key: string;
  provider: SearchProviderId;
  sourceName: string;
  title: string;
  displayTitle: string;
  isMtl: boolean;
  path: string;
  url: string;
  domain: string;
  cover?: string;
  author?: string;
  info?: string;
  normalizedTitle: string;
}

interface ProviderSearchState {
  status: 'idle' | 'loading' | 'done' | 'error';
  count: number;
  error?: string;
}

interface ServerStatusState {
  tested: boolean;
  online: boolean;
  authenticated: boolean;
  latencyMs: number;
  user?: LNCrawlUser;
  error?: string;
}

function getProviderDisplayName(id: SearchProviderId): string {
  const found = PROVIDER_CHIPS.find((c) => c.id === id);
  return found ? found.label : id;
}

function normalizeNovelStatus(rawStatus?: string): 'Ongoing' | 'Completed' | 'Hiatus' {
  const lower = (rawStatus || '').toLowerCase();
  if (lower.includes('complete')) return 'Completed';
  if (lower.includes('hiatus') || lower.includes('stub')) return 'Hiatus';
  return 'Ongoing';
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ==========================================
// TOP-LEVEL SUBCOMPONENTS (prevents keyboard blur/remount)
// ==========================================

interface StatusBannerProps {
  serverStatus: ServerStatusState;
  isWaking: boolean;
  onPressAccount: () => void;
  onRetryConnection: () => void;
}

function ServerStatusBanner({
  serverStatus,
  isWaking,
  onPressAccount,
  onRetryConnection,
}: StatusBannerProps) {
  const dotColor = isWaking
    ? Colors.warning
    : serverStatus.online && serverStatus.authenticated
    ? Colors.success
    : Colors.danger;

  const subtext = isWaking
    ? 'Waking up server...'
    : serverStatus.authenticated
    ? `Connected • ${serverStatus.user?.email || 'Active session'}`
    : serverStatus.tested
    ? serverStatus.error || 'Disconnected / Unauthorized'
    : 'Connecting to server...';

  return (
    <Pressable style={styles.apiStatusCard} onPress={onPressAccount}>
      <View style={styles.apiStatusLeft}>
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
        <View style={styles.apiStatusTextGroup}>
          <Text style={styles.apiStatusText} numberOfLines={1}>
            {API_URL.replace(/^https?:\/\//, '')}
          </Text>
          <Text style={styles.apiAuthSubtext} numberOfLines={1}>
            {subtext}
          </Text>
        </View>
      </View>

      <View style={styles.apiRightAction}>
        {serverStatus.tested && !serverStatus.authenticated && !isWaking ? (
          <Pressable
            style={styles.bannerRetryBtn}
            onPress={(e) => {
              e.stopPropagation();
              onRetryConnection();
            }}
            hitSlop={8}
          >
            <Text style={styles.bannerRetryText}>Retry</Text>
          </Pressable>
        ) : (
          <Text style={styles.apiLatencyText}>
            {isWaking
              ? 'Waking...'
              : serverStatus.tested
              ? serverStatus.online
                ? `${serverStatus.latencyMs}ms`
                : 'Offline'
              : '...'}
          </Text>
        )}
        <Ionicons
          name={serverStatus.authenticated ? 'person-circle' : 'log-in-outline'}
          size={18}
          color={serverStatus.authenticated ? Colors.success : Colors.primary}
        />
      </View>
    </Pressable>
  );
}

interface SearchBarProps {
  value: string;
  loading: boolean;
  onChangeText: (text: string) => void;
  onClear: () => void;
  onSubmit: () => void;
}

function SearchBar({ value, loading, onChangeText, onClear, onSubmit }: SearchBarProps) {
  const trimmedLen = value.trim().length;
  return (
    <View style={styles.searchBar}>
      <Ionicons name="search" size={20} color={Colors.textMuted} style={styles.searchIcon} />
      <TextInput
        style={styles.searchInput}
        placeholder="Search light novels (min 2 chars)..."
        placeholderTextColor={Colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        returnKeyType="search"
        autoCorrect={false}
        maxLength={50}
      />
      {value.length > 0 && (
        <Pressable onPress={onClear} hitSlop={10} style={styles.clearButton}>
          <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
        </Pressable>
      )}
      <Pressable
        style={[
          styles.searchSubmitButton,
          trimmedLen < 2 && styles.searchSubmitDisabled,
        ]}
        onPress={onSubmit}
        disabled={trimmedLen < 2}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#0D0F14" />
        ) : (
          <Ionicons name="arrow-forward" size={18} color="#0D0F14" />
        )}
      </Pressable>
    </View>
  );
}

interface SourceChipsRowProps {
  selectedProviders: SearchProviderId[];
  onToggleProvider: (id: SearchProviderId) => void;
}

function SourceChipsRow({ selectedProviders, onToggleProvider }: SourceChipsRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.providerChipsList}
    >
      {PROVIDER_CHIPS.map((chip) => {
        const isSelected = selectedProviders.includes(chip.id);
        return (
          <Pressable
            key={chip.id}
            style={[
              styles.providerChip,
              isSelected && styles.providerChipSelected,
            ]}
            onPress={() => onToggleProvider(chip.id)}
          >
            <Ionicons
              name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
              size={14}
              color={isSelected ? Colors.primary : Colors.textMuted}
            />
            <Text
              style={[
                styles.providerChipText,
                isSelected && styles.providerChipTextSelected,
              ]}
            >
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

interface ProviderStatusStripProps {
  selectedProviders: SearchProviderId[];
  statuses: Partial<Record<SearchProviderId, ProviderSearchState>>;
  onRetryProvider: (id: SearchProviderId) => void;
}

function ProviderStatusStrip({
  selectedProviders,
  statuses,
  onRetryProvider,
}: ProviderStatusStripProps) {
  const activeEntries = selectedProviders
    .map((id) => ({ id, state: statuses[id] }))
    .filter((entry) => entry.state && entry.state.status !== 'idle');

  if (activeEntries.length === 0) return null;

  return (
    <View style={styles.statusStripWrap}>
      {activeEntries.map(({ id, state }) => {
        if (!state) return null;
        const name = getProviderDisplayName(id);
        const isErr = state.status === 'error';
        const isLoading = state.status === 'loading';
        return (
          <View
            key={id}
            style={[
              styles.sourceStatusPill,
              isErr && styles.sourceStatusPillError,
            ]}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : isErr ? (
              <Ionicons name="alert-circle" size={13} color={Colors.danger} />
            ) : (
              <Ionicons name="checkmark-circle" size={13} color={Colors.success} />
            )}

            <Text
              style={[
                styles.sourceStatusText,
                isErr && styles.sourceStatusTextError,
              ]}
              numberOfLines={1}
            >
              {isLoading
                ? `${name}...`
                : isErr
                ? `${name}: ${state.error || 'Failed'}`
                : `${name}: ${state.count}`}
            </Text>

            {isErr && (
              <Pressable
                style={styles.sourceRetryBtn}
                onPress={() => onRetryProvider(id)}
                hitSlop={6}
              >
                <Text style={styles.sourceRetryText}>Retry</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

interface QuickGenrePillsProps {
  onSelectGenre: (genre: string) => void;
}

function QuickGenrePills({ onSelectGenre }: QuickGenrePillsProps) {
  return (
    <View style={styles.tagsContainer}>
      <Text style={styles.tagsLabel}>POPULAR GENRES</Text>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        data={QUICK_TAGS}
        keyExtractor={(item) => item}
        contentContainerStyle={styles.tagsList}
        renderItem={({ item }) => (
          <Pressable style={styles.tagChip} onPress={() => onSelectGenre(item)}>
            <Text style={styles.tagChipText}>{item}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

interface ExternalResultCardProps {
  item: UnifiedSearchResult;
  onPress: (item: UnifiedSearchResult) => void;
}

function ExternalResultCard({ item, onPress }: ExternalResultCardProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.resultCard, pressed && styles.cardPressed]}
      onPress={() => onPress(item)}
    >
      <Image
        source={item.cover ? { uri: item.cover } : require('../../assets/icon.png')}
        style={styles.resultCover}
        resizeMode="cover"
      />
      <View style={styles.resultDetails}>
        <View style={styles.resultTitleRow}>
          <Text style={styles.resultTitle} numberOfLines={2}>
            {item.displayTitle}
          </Text>
          {item.isMtl && (
            <View style={styles.mtlBadge}>
              <Text style={styles.mtlBadgeText}>MTL</Text>
            </View>
          )}
        </View>

        <View style={styles.resultSourceRow}>
          <View style={styles.sourceNameBadge}>
            <Text style={styles.sourceNameBadgeText}>{item.sourceName}</Text>
          </View>
          {item.author ? (
            <Text style={styles.resultAuthor} numberOfLines={1}>
              {item.author}
            </Text>
          ) : (
            <Text style={styles.resultDomain} numberOfLines={1}>
              {item.domain}
            </Text>
          )}
        </View>

        <View style={styles.resultMetaRow}>
          {item.info ? (
            <View style={styles.metaBadge}>
              <Text style={styles.metaBadgeText} numberOfLines={1}>
                {item.info}
              </Text>
            </View>
          ) : (
            <View />
          )}
          <View style={styles.viewButton}>
            <Text style={styles.viewButtonText}>Add & View</Text>
            <Ionicons name="add-circle-outline" size={13} color={Colors.primary} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ==========================================
// MAIN DISCOVER SCREEN
// ==========================================

export default function DiscoverScreen() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProviders, setSelectedProviders] = useState<SearchProviderId[]>([
    'readnovelfull',
    'novelfull',
    'novelbin',
  ]);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  const [providerStatuses, setProviderStatuses] = useState<
    Partial<Record<SearchProviderId, ProviderSearchState>>
  >({});
  const [resultsByProvider, setResultsByProvider] = useState<
    Partial<Record<SearchProviderId, UnifiedSearchResult[]>>
  >({});

  const [searching, setSearching] = useState(false);
  const [serverProgress, setServerProgress] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const [lastSearchedQuery, setLastSearchedQuery] = useState('');
  const [isWaking, setIsWaking] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatusState>({
    tested: false,
    online: true,
    authenticated: false,
    latencyMs: 0,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Opening/adding search result state
  const [importingLabel, setImportingLabel] = useState<string | null>(null);
  const [importingSublabel, setImportingSublabel] = useState<string>('');
  const [importingStatus, setImportingStatus] = useState('Adding to library...');
  const [importError, setImportError] = useState<string | null>(null);
  const retryImportActionRef = useRef<(() => void) | null>(null);

  // Add by link modal state
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  // LNCrawl Auth Modal State
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [authMode, setAuthMode] = useState<'credentials' | 'token'>('credentials');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Refs for cleanup, debounce & job cancellation
  const activeJobIdRef = useRef<string | null>(null);
  const searchRunIdRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextDebounceRef = useRef<boolean>(false);
  const lastSubmittedQueryRef = useRef<string>('');
  const selectedProvidersRef = useRef<SearchProviderId[]>(selectedProviders);

  useEffect(() => {
    selectedProvidersRef.current = selectedProviders;
  }, [selectedProviders]);

  useEffect(() => {
    getDiscoverProviders().then((saved) => {
      setSelectedProviders(saved);
      selectedProvidersRef.current = saved;
      setProvidersLoaded(true);
    });
  }, []);

  const lncrawlSelected = selectedProviders.includes('lncrawl');

  const stopActiveSearch = useCallback(() => {
    searchRunIdRef.current += 1;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (activeJobIdRef.current) {
      const oldJobId = activeJobIdRef.current;
      activeJobIdRef.current = null;
      LNCrawlService.cancelJob(oldJobId).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const unsubWaking = LNCrawlService.subscribeWaking(setIsWaking);
    return () => {
      unsubWaking();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      stopActiveSearch();
    };
  }, [stopActiveSearch]);

  const checkServer = useCallback(() => {
    LNCrawlService.testConnection()
      .then((res) => {
        setServerStatus({
          tested: true,
          online: res.online,
          authenticated: res.authenticated,
          latencyMs: res.latencyMs,
          user: res.user,
          error: res.error,
        });
      })
      .catch((err: any) => {
        setServerStatus({
          tested: true,
          online: false,
          authenticated: false,
          latencyMs: 0,
          error: err?.message || 'Unable to connect to LNCrawl server.',
        });
      });
  }, []);

  useEffect(() => {
    if (providersLoaded && lncrawlSelected) {
      checkServer();
    }
  }, [providersLoaded, lncrawlSelected, checkServer]);

  useFocusEffect(
    useCallback(() => {
      if (providersLoaded && lncrawlSelected) {
        checkServer();
      }
    }, [providersLoaded, lncrawlSelected, checkServer])
  );

  const runLocalProvider = useCallback(
    async (
      source: Source,
      query: string,
      currentRunId: number,
      markGlobalDoneIfFinished: () => void
    ) => {
      const providerId = source.id as SearchProviderId;
      setProviderStatuses((prev) => ({
        ...prev,
        [providerId]: { status: 'loading', count: 0 },
      }));

      try {
        const rawItems = await withTimeout(
          source.search(query),
          LOCAL_SEARCH_TIMEOUT_MS,
          source.name
        );

        if (searchRunIdRef.current !== currentRunId) return;

        // Dedupe by normalized title within the same source only
        const seenTitles = new Set<string>();
        const seenPaths = new Set<string>();
        const domain = extractSourceDomain(source);
        const mapped: UnifiedSearchResult[] = [];

        for (const item of rawItems) {
          const normTitle = normalizeSearchTitle(item.title);
          const normPath = item.path.trim();
          if (!normTitle || !normPath) continue;
          if (seenTitles.has(normTitle) || seenPaths.has(normPath)) continue;

          seenTitles.add(normTitle);
          seenPaths.add(normPath);

          mapped.push({
            key: `${source.id}:${normPath}`,
            provider: providerId,
            sourceName: source.name,
            title: item.title,
            displayTitle: item.title,
            isMtl: false,
            path: normPath,
            url: toAbsoluteUrl(normPath, source.site),
            domain,
            cover: item.cover,
            author: item.author,
            normalizedTitle: normTitle,
          });
        }

        setResultsByProvider((prev) => ({
          ...prev,
          [providerId]: mapped,
        }));
        setProviderStatuses((prev) => ({
          ...prev,
          [providerId]: { status: 'done', count: mapped.length },
        }));
      } catch (err: any) {
        if (searchRunIdRef.current !== currentRunId) return;
        const msg = err?.message || 'Search failed';
        setProviderStatuses((prev) => ({
          ...prev,
          [providerId]: { status: 'error', count: 0, error: msg },
        }));
      } finally {
        if (searchRunIdRef.current === currentRunId) {
          markGlobalDoneIfFinished();
        }
      }
    },
    []
  );

  const runLncrawlProvider = useCallback(
    async (
      query: string,
      currentRunId: number,
      markGlobalDoneIfFinished: () => void
    ) => {
      setProviderStatuses((prev) => ({
        ...prev,
        lncrawl: { status: 'loading', count: 0 },
      }));
      setServerProgress(0);

      try {
        const job = await LNCrawlService.createSearchSourcesJob(query);

        if (searchRunIdRef.current !== currentRunId) {
          LNCrawlService.cancelJob(job.id).catch(() => {});
          return;
        }

        activeJobIdRef.current = job.id;
        setServerStatus((prev) => ({
          ...prev,
          tested: true,
          online: true,
          authenticated: true,
          error: undefined,
        }));

        const mapServerItems = (rawSearchResults: any): UnifiedSearchResult[] => {
          const processed = processSearchResults(rawSearchResults);
          return processed.map((item) => ({
            key: `lncrawl:${item.url}`,
            provider: 'lncrawl',
            sourceName: 'Server',
            title: item.title,
            displayTitle: item.displayTitle,
            isMtl: item.isMtl,
            path: item.url,
            url: item.url,
            domain: item.domain,
            info: item.info,
            normalizedTitle: item.normalizedTitle,
          }));
        };

        const initialMapped = mapServerItems(job.extra?.search_results);
        if (initialMapped.length > 0) {
          setResultsByProvider((prev) => ({ ...prev, lncrawl: initialMapped }));
          setProviderStatuses((prev) => ({
            ...prev,
            lncrawl: { status: 'loading', count: initialMapped.length },
          }));
        }

        const deadline = Date.now() + APP_CONFIG.searchTimeoutMs;

        const pollOnce = async () => {
          if (searchRunIdRef.current !== currentRunId) return;

          if (Date.now() >= deadline) {
            if (activeJobIdRef.current === job.id) {
              activeJobIdRef.current = null;
            }
            LNCrawlService.cancelJob(job.id).catch(() => {});
            setProviderStatuses((prev) => ({
              ...prev,
              lncrawl: {
                status: 'done',
                count: prev.lncrawl?.count || 0,
              },
            }));
            markGlobalDoneIfFinished();
            return;
          }

          try {
            const latestJob = await LNCrawlService.getJobStatus(job.id);
            if (searchRunIdRef.current !== currentRunId) return;

            setServerProgress(Math.max(0, Math.min(100, latestJob.progress || 0)));

            const mapped = mapServerItems(latestJob.extra?.search_results);
            setResultsByProvider((prev) => ({ ...prev, lncrawl: mapped }));

            if (latestJob.error) {
              activeJobIdRef.current = null;
              setProviderStatuses((prev) => ({
                ...prev,
                lncrawl: {
                  status: 'error',
                  count: mapped.length,
                  error: latestJob.error || 'Server search error',
                },
              }));
              markGlobalDoneIfFinished();
              return;
            }

            if (latestJob.is_done) {
              setServerProgress(100);
              activeJobIdRef.current = null;
              setProviderStatuses((prev) => ({
                ...prev,
                lncrawl: { status: 'done', count: mapped.length },
              }));
              markGlobalDoneIfFinished();
              return;
            }

            setProviderStatuses((prev) => ({
              ...prev,
              lncrawl: { status: 'loading', count: mapped.length },
            }));
            pollTimerRef.current = setTimeout(pollOnce, APP_CONFIG.searchPollIntervalMs);
          } catch (pollErr: any) {
            if (searchRunIdRef.current !== currentRunId) return;
            activeJobIdRef.current = null;
            setProviderStatuses((prev) => ({
              ...prev,
              lncrawl: {
                status: 'error',
                count: prev.lncrawl?.count || 0,
                error: pollErr?.message || 'Polling failed',
              },
            }));
            markGlobalDoneIfFinished();
          }
        };

        pollTimerRef.current = setTimeout(pollOnce, APP_CONFIG.searchPollIntervalMs);
      } catch (err: any) {
        if (searchRunIdRef.current !== currentRunId) return;
        setProviderStatuses((prev) => ({
          ...prev,
          lncrawl: {
            status: 'error',
            count: 0,
            error: err?.message || 'Server search failed',
          },
        }));
        if (err?.status === 401) {
          setServerStatus((prev) => ({
            ...prev,
            authenticated: false,
            error: err?.message,
          }));
        }
        markGlobalDoneIfFinished();
      }
    },
    []
  );

  const runLiveSearch = useCallback(
    async (rawQuery: string, forceRestart: boolean = false) => {
      const trimmed = rawQuery.trim();
      if (trimmed.length < 2) {
        if (forceRestart) {
          setErrorMessage('Enter at least 2 characters to search.');
        }
        return;
      }

      if (trimmed.length > 50) {
        setErrorMessage('Search query must be 50 characters or fewer.');
        return;
      }

      const activeProviders = selectedProvidersRef.current;
      if (activeProviders.length === 0) {
        setErrorMessage('Select at least one source chip above to search.');
        return;
      }

      if (
        !forceRestart &&
        lastSubmittedQueryRef.current.toLowerCase() === trimmed.toLowerCase()
      ) {
        return;
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      stopActiveSearch();
      const currentRunId = searchRunIdRef.current;
      lastSubmittedQueryRef.current = trimmed;

      setSearching(true);
      setServerProgress(0);
      setErrorMessage(null);
      setHasSearched(true);
      setLastSearchedQuery(trimmed);
      setResultsByProvider({});

      const initialStatuses: Partial<Record<SearchProviderId, ProviderSearchState>> = {};
      for (const pid of activeProviders) {
        initialStatuses[pid] = { status: 'loading', count: 0 };
      }
      setProviderStatuses(initialStatuses);

      let remaining = activeProviders.length;
      const markProviderFinished = () => {
        if (searchRunIdRef.current !== currentRunId) return;
        remaining = Math.max(0, remaining - 1);
        if (remaining === 0) {
          setSearching(false);
        }
      };

      const tasks: Promise<void>[] = [];

      for (const pid of activeProviders) {
        if (pid === 'lncrawl') {
          tasks.push(runLncrawlProvider(trimmed, currentRunId, markProviderFinished));
        } else {
          const source = getSource(pid);
          if (source) {
            tasks.push(runLocalProvider(source, trimmed, currentRunId, markProviderFinished));
          } else {
            markProviderFinished();
          }
        }
      }

      await Promise.allSettled(tasks);
    },
    [stopActiveSearch, runLocalProvider, runLncrawlProvider]
  );

  const handleRetrySingleProvider = useCallback(
    async (providerId: SearchProviderId) => {
      const query = (lastSearchedQuery || searchQuery).trim();
      if (query.length < 2) return;

      const currentRunId = searchRunIdRef.current;
      setSearching(true);

      const finishSingle = () => {
        setProviderStatuses((latest) => {
          const stillLoading = Object.values(latest).some((s) => s?.status === 'loading');
          if (!stillLoading) {
            setSearching(false);
          }
          return latest;
        });
      };

      if (providerId === 'lncrawl') {
        await runLncrawlProvider(query, currentRunId, finishSingle);
      } else {
        const source = getSource(providerId);
        if (source) {
          await runLocalProvider(source, query, currentRunId, finishSingle);
        }
      }
    },
    [lastSearchedQuery, searchQuery, runLocalProvider, runLncrawlProvider]
  );

  // 700ms debounce when typing >= 2 characters
  useEffect(() => {
    if (!providersLoaded) return;

    if (suppressNextDebounceRef.current) {
      suppressNextDebounceRef.current = false;
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      runLiveSearch(trimmed, false);
    }, 700);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [searchQuery, providersLoaded, runLiveSearch]);

  const handleToggleProvider = async (id: SearchProviderId) => {
    const exists = selectedProviders.includes(id);
    const next = exists
      ? selectedProviders.filter((p) => p !== id)
      : [...selectedProviders, id];
    setSelectedProviders(next);
    selectedProvidersRef.current = next;
    await saveDiscoverProviders(next);
  };

  const handleSubmitSearch = () => {
    Keyboard.dismiss();
    runLiveSearch(searchQuery, true);
  };

  const handleSelectGenre = (genre: string) => {
    Keyboard.dismiss();
    suppressNextDebounceRef.current = true;
    setSearchQuery(genre);
    runLiveSearch(genre, true);
  };

  const handleClearSearch = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    stopActiveSearch();
    lastSubmittedQueryRef.current = '';
    setSearchQuery('');
    setSearching(false);
    setServerProgress(0);
    setHasSearched(false);
    setLastSearchedQuery('');
    setResultsByProvider({});
    setProviderStatuses({});
    setErrorMessage(null);
  };

  const importLocalNovel = useCallback(
    async (source: Source, path: string, hintTitle?: string, hintCover?: string, hintAuthor?: string) => {
      const domain = extractSourceDomain(source);
      setImportingLabel(hintTitle || 'Loading novel...');
      setImportingSublabel(domain);
      setImportingStatus(`Fetching novel details from ${source.name}...`);
      setImportError(null);

      retryImportActionRef.current = () => {
        importLocalNovel(source, path, hintTitle, hintCover, hintAuthor);
      };

      try {
        const detail = await source.getNovel(path);
        const novelId = buildLocalNovelId(source.id, path);
        const novelUrl = toAbsoluteUrl(path, source.site);

        const novel: Novel = {
          id: novelId,
          title: detail.title || hintTitle || 'Untitled Novel',
          author: detail.author || hintAuthor || 'Unknown',
          synopsis: detail.summary || '',
          coverUrl: detail.cover || hintCover || '',
          genres: [],
          status: normalizeNovelStatus(detail.status),
          totalChapters: detail.chapters.length,
          provider: source.id,
          path,
          sourceDomain: domain,
          url: novelUrl,
          isDownloaded: false,
        };

        const chapters: Chapter[] = detail.chapters.map((ch, idx) => ({
          id: buildLocalChapterId(source.id, ch.path),
          novelId,
          serial: idx + 1,
          title: ch.title || `Chapter ${idx + 1}`,
          provider: source.id,
          path: ch.path,
          url: toAbsoluteUrl(ch.path, source.site),
          isDownloaded: false,
        }));

        setImportingStatus(`Saving ${chapters.length} chapters to library...`);
        await upsertNovel(novel);
        if (chapters.length > 0) {
          await saveChaptersBatch(chapters);
        }

        setImportingLabel(null);
        setLinkModalVisible(false);
        setLinkInput('');
        router.push({
          pathname: '/novel/[id]',
          params: { id: novel.id },
        });
      } catch (err: any) {
        console.warn(`Failed importing local novel from ${source.id}:`, err);
        setImportError(err?.message || `Failed to load novel from ${source.name}.`);
      }
    },
    [router]
  );

  const importLncrawlNovel = useCallback(
    async (item: UnifiedSearchResult) => {
      setImportingLabel(item.displayTitle);
      setImportingSublabel(item.domain);
      setImportingStatus('Adding to library...');
      setImportError(null);

      retryImportActionRef.current = () => {
        importLncrawlNovel(item);
      };

      try {
        const novel = await LNCrawlService.fetchAndImportNovelByUrl(
          item.url,
          item.displayTitle,
          setImportingStatus
        );
        await upsertNovel({
          ...novel,
          provider: 'lncrawl',
          path: novel.url || item.url,
        });
        setImportingLabel(null);
        router.push({
          pathname: '/novel/[id]',
          params: { id: novel.id },
        });
      } catch (err: any) {
        console.warn('Error adding novel from server result:', err);
        setImportError(err?.message || 'Failed to add novel to library.');
      }
    },
    [router]
  );

  const handleOpenSearchResult = useCallback(
    (item: UnifiedSearchResult) => {
      Keyboard.dismiss();
      if (item.provider === 'lncrawl') {
        importLncrawlNovel(item);
        return;
      }
      const source = getSource(item.provider);
      if (!source) {
        setErrorMessage(`Source "${item.provider}" is not available.`);
        return;
      }
      importLocalNovel(source, item.path, item.displayTitle, item.cover, item.author);
    },
    [importLncrawlNovel, importLocalNovel]
  );

  const handleAddByLinkSubmit = () => {
    setLinkError(null);
    const trimmed = linkInput.trim();
    if (!trimmed) {
      setLinkError('Paste a novel URL first.');
      return;
    }

    const matched = matchSourceByUrl(trimmed);
    if (!matched) {
      const supported = SOURCES.map((s) => extractSourceDomain(s)).join(', ');
      setLinkError(`Unsupported domain. Supported sources: ${supported}.`);
      return;
    }

    setLinkModalVisible(false);
    importLocalNovel(matched.source, matched.path);
  };

  const handleLogin = async () => {
    setAuthError(null);
    setAuthLoading(true);
    try {
      if (authMode === 'credentials') {
        if (!emailInput.trim() || !passwordInput) {
          setAuthError('Enter your email/username and password.');
          setAuthLoading(false);
          return;
        }
        const res = await LNCrawlService.login(emailInput.trim(), passwordInput);
        setServerStatus((prev) => ({
          ...prev,
          online: true,
          authenticated: true,
          user: res.user,
          error: undefined,
        }));
      } else {
        if (!tokenInput.trim()) {
          setAuthError('Paste a valid Bearer token.');
          setAuthLoading(false);
          return;
        }
        const user = await LNCrawlService.setTokenAndVerify(tokenInput.trim());
        setServerStatus((prev) => ({
          ...prev,
          online: true,
          authenticated: true,
          user,
          error: undefined,
        }));
      }
      setAuthModalVisible(false);
      setPasswordInput('');
      setTokenInput('');
      setErrorMessage(null);
    } catch (err: any) {
      setAuthError(err?.message || 'Sign in failed.');
    } finally {
      setAuthLoading(false);
    }
  };

  const closeAuthModal = () => {
    setAuthModalVisible(false);
    setPasswordInput('');
    setTokenInput('');
    setAuthError(null);
  };

  const handleLogout = async () => {
    await LNCrawlService.logout();
    setServerStatus((prev) => ({
      ...prev,
      authenticated: false,
      user: undefined,
    }));
    closeAuthModal();
  };

  // Merge results from selected providers in chip order (preserves per-source deduplication only)
  const combinedResults = useMemo(() => {
    const merged: UnifiedSearchResult[] = [];
    for (const chip of PROVIDER_CHIPS) {
      const list = resultsByProvider[chip.id];
      if (list && list.length > 0) {
        merged.push(...list);
      }
    }
    return merged;
  }, [resultsByProvider]);

  const renderEmptyComponent = () => {
    if (searching) {
      return (
        <View style={styles.emptyStateBox}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.emptyStateTitle}>Searching selected sources...</Text>
          <Text style={styles.emptyStateSub}>
            Results appear immediately as each site responds.
          </Text>
        </View>
      );
    }

    if (hasSearched && !errorMessage) {
      return (
        <View style={styles.emptyStateBox}>
          <Ionicons name="search-outline" size={44} color={Colors.surfaceLight} />
          <Text style={styles.emptyStateTitle}>No novels found</Text>
          <Text style={styles.emptyStateSub}>
            No matches returned for "{lastSearchedQuery}". Try another title or enable more sources.
          </Text>
        </View>
      );
    }

    if (!hasSearched && !errorMessage) {
      return (
        <View style={styles.emptyStateBox}>
          <Ionicons name="compass-outline" size={44} color={Colors.surfaceLight} />
          <Text style={styles.emptyStateTitle}>Discover Light Novels</Text>
          <Text style={styles.emptyStateSub}>
            Type a novel title, pick a genre, or paste a novel link to add directly from ReadNovelFull, NovelFull, or NovelBin.
          </Text>
        </View>
      );
    }

    return null;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Fixed Header & SearchBar kept outside FlatList so TextInput NEVER unmounts */}
      <View style={styles.headerContainer}>
        <View style={styles.titleRow}>
          <View style={styles.titleTextGroup}>
            <Text style={styles.screenTitle}>Discover & Search</Text>
            <Text style={styles.screenSubtitle}>
              Fast direct source search & optional server crawl
            </Text>
          </View>
          <Pressable
            style={styles.addLinkButton}
            onPress={() => {
              setLinkError(null);
              setLinkModalVisible(true);
            }}
          >
            <Ionicons name="link-outline" size={16} color={Colors.primary} />
            <Text style={styles.addLinkButtonText}>Add by link</Text>
          </Pressable>
        </View>

        <SourceChipsRow
          selectedProviders={selectedProviders}
          onToggleProvider={handleToggleProvider}
        />

        {lncrawlSelected && (
          <ServerStatusBanner
            serverStatus={serverStatus}
            isWaking={isWaking}
            onPressAccount={() => setAuthModalVisible(true)}
            onRetryConnection={checkServer}
          />
        )}

        <SearchBar
          value={searchQuery}
          loading={searching}
          onChangeText={setSearchQuery}
          onClear={handleClearSearch}
          onSubmit={handleSubmitSearch}
        />

        {/* Thin server progress bar when Server (slow) is active */}
        {searching && providerStatuses.lncrawl?.status === 'loading' && (
          <View style={styles.searchProgressTrack}>
            <View
              style={[
                styles.searchProgressFill,
                { width: `${Math.max(5, serverProgress)}%` },
              ]}
            />
          </View>
        )}

        <ProviderStatusStrip
          selectedProviders={selectedProviders}
          statuses={providerStatuses}
          onRetryProvider={handleRetrySingleProvider}
        />

        <QuickGenrePills onSelectGenre={handleSelectGenre} />

        {errorMessage && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color={Colors.warning} />
            <Text style={styles.errorText}>{errorMessage}</Text>
            <Pressable
              style={styles.retryInlineBtn}
              onPress={() => {
                if (searchQuery.trim().length >= 2) {
                  runLiveSearch(searchQuery, true);
                }
              }}
            >
              <Text style={styles.retryInlineText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {(combinedResults.length > 0 || searching) && (
          <View style={styles.resultsCountRow}>
            <Text style={styles.resultsCountText}>
              {searching
                ? `Searching... ${combinedResults.length} found so far`
                : `Found ${combinedResults.length} novels`}
            </Text>
          </View>
        )}
      </View>

      <FlatList
        data={combinedResults}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (
          <ExternalResultCard item={item} onPress={handleOpenSearchResult} />
        )}
        ListEmptyComponent={renderEmptyComponent}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      />

      {/* Add by Link Modal */}
      <Modal
        visible={linkModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setLinkModalVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setLinkModalVisible(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Novel by Link</Text>
              <Pressable onPress={() => setLinkModalVisible(false)} hitSlop={10}>
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>

            <Text style={styles.linkHelperText}>
              Paste a novel URL from ReadNovelFull, NovelFull, or NovelBin.
            </Text>

            <TextInput
              style={styles.modalInput}
              placeholder="https://novelbin.com/b/..."
              placeholderTextColor={Colors.textMuted}
              value={linkInput}
              onChangeText={(t) => {
                setLinkInput(t);
                if (linkError) setLinkError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />

            {linkError && <Text style={styles.authErrorText}>{linkError}</Text>}

            <Pressable style={styles.loginSubmitBtn} onPress={handleAddByLinkSubmit}>
              <Text style={styles.loginSubmitText}>Load Novel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Adding Novel to Library Modal */}
      <Modal
        visible={importingLabel !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (importError) {
            setImportingLabel(null);
            setImportError(null);
          }
        }}
      >
        <View style={styles.importBackdrop}>
          <View style={styles.importCard}>
            {!importError ? (
              <>
                <ActivityIndicator size="large" color={Colors.primary} />
                <Text style={styles.importTitle}>{importingStatus}</Text>
                <Text style={styles.importSubtitle} numberOfLines={2}>
                  {importingLabel}
                </Text>
                <Text style={styles.importDomain}>{importingSublabel}</Text>
              </>
            ) : (
              <>
                <Ionicons name="alert-circle" size={36} color={Colors.danger} />
                <Text style={styles.importTitle}>Could Not Add Novel</Text>
                <Text style={styles.importErrorText}>{importError}</Text>
                <View style={styles.importActions}>
                  <Pressable
                    style={styles.importCancelBtn}
                    onPress={() => {
                      setImportingLabel(null);
                      setImportError(null);
                    }}
                  >
                    <Text style={styles.importCancelText}>Close</Text>
                  </Pressable>
                  <Pressable
                    style={styles.importRetryBtn}
                    onPress={() => retryImportActionRef.current?.()}
                  >
                    <Text style={styles.importRetryText}>Retry</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* LNCrawl Account Modal */}
      <Modal
        visible={authModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeAuthModal}
      >
        <Pressable style={styles.modalBackdrop} onPress={closeAuthModal}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {serverStatus.authenticated ? 'LNCrawl Account' : 'Sign In to LNCrawl'}
              </Text>
              <Pressable onPress={closeAuthModal} hitSlop={10}>
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>

            {serverStatus.authenticated && serverStatus.user ? (
              <View style={styles.signedInBox}>
                <Text style={styles.signedInLabel}>Active Session</Text>
                <Text style={styles.signedInEmail}>{serverStatus.user.email}</Text>
                <Text style={styles.signedInRole}>
                  Role: {serverStatus.user.role} • Tier {serverStatus.user.tier}
                </Text>
                <Pressable style={styles.logoutBtn} onPress={handleLogout}>
                  <Ionicons name="log-out-outline" size={16} color={Colors.danger} />
                  <Text style={styles.logoutBtnText}>Sign Out</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <View style={styles.modeSwitchRow}>
                  <Pressable
                    style={[
                      styles.modeBtn,
                      authMode === 'credentials' && styles.modeBtnActive,
                    ]}
                    onPress={() => setAuthMode('credentials')}
                  >
                    <Text
                      style={[
                        styles.modeBtnText,
                        authMode === 'credentials' && styles.modeBtnTextActive,
                      ]}
                    >
                      Password
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.modeBtn,
                      authMode === 'token' && styles.modeBtnActive,
                    ]}
                    onPress={() => setAuthMode('token')}
                  >
                    <Text
                      style={[
                        styles.modeBtnText,
                        authMode === 'token' && styles.modeBtnTextActive,
                      ]}
                    >
                      Bearer Token
                    </Text>
                  </Pressable>
                </View>

                {authMode === 'credentials' ? (
                  <>
                    <Text style={styles.inputLabel}>Email or Username</Text>
                    <TextInput
                      style={styles.modalInput}
                      placeholder="user@example.com or username"
                      placeholderTextColor={Colors.textMuted}
                      value={emailInput}
                      onChangeText={setEmailInput}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={styles.inputLabel}>Password</Text>
                    <TextInput
                      style={styles.modalInput}
                      placeholder="Password"
                      placeholderTextColor={Colors.textMuted}
                      value={passwordInput}
                      onChangeText={setPasswordInput}
                      secureTextEntry
                    />
                  </>
                ) : (
                  <>
                    <Text style={styles.inputLabel}>LNCrawl Bearer Token</Text>
                    <TextInput
                      style={styles.modalInput}
                      placeholder="Paste token from LNCrawl..."
                      placeholderTextColor={Colors.textMuted}
                      value={tokenInput}
                      onChangeText={setTokenInput}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </>
                )}

                {authError && <Text style={styles.authErrorText}>{authError}</Text>}

                <Pressable
                  style={[styles.loginSubmitBtn, authLoading && styles.searchSubmitDisabled]}
                  onPress={handleLogin}
                  disabled={authLoading}
                >
                  {authLoading ? (
                    <ActivityIndicator size="small" color="#0D0F14" />
                  ) : (
                    <Text style={styles.loginSubmitText}>Connect & Verify</Text>
                  )}
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    flexGrow: 1,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 10,
  },
  titleTextGroup: {
    flex: 1,
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
  },
  addLinkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    marginTop: 4,
  },
  addLinkButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
  },
  providerChipsList: {
    gap: 8,
    paddingBottom: 10,
  },
  providerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  providerChipSelected: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  providerChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  providerChipTextSelected: {
    color: Colors.primary,
    fontWeight: '700',
  },
  apiStatusCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 10,
  },
  apiStatusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  apiStatusTextGroup: {
    flex: 1,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  apiStatusText: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontFamily: 'monospace',
  },
  apiAuthSubtext: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 1,
  },
  apiRightAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 8,
  },
  apiLatencyText: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  bannerRetryBtn: {
    backgroundColor: Colors.primaryMuted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  bannerRetryText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.primary,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    height: 48,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 14,
    height: '100%',
  },
  clearButton: {
    padding: 4,
    marginRight: 6,
  },
  searchSubmitButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchSubmitDisabled: {
    opacity: 0.5,
  },
  searchProgressTrack: {
    height: 3,
    backgroundColor: Colors.surfaceRaised,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 6,
  },
  searchProgressFill: {
    height: '100%',
    backgroundColor: Colors.primary,
  },
  statusStripWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  sourceStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    maxWidth: '100%',
  },
  sourceStatusPillError: {
    borderColor: 'rgba(239, 68, 68, 0.4)',
    backgroundColor: Colors.dangerMuted,
  },
  sourceStatusText: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '600',
    flexShrink: 1,
  },
  sourceStatusTextError: {
    color: Colors.danger,
  },
  sourceRetryBtn: {
    backgroundColor: Colors.danger,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 2,
  },
  sourceRetryText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  tagsContainer: {
    marginTop: 12,
    marginBottom: 10,
  },
  tagsLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  tagsList: {
    gap: 8,
  },
  tagChip: {
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tagChipText: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.warningMuted,
    borderRadius: 8,
    padding: 12,
    gap: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: Colors.warning,
    lineHeight: 18,
  },
  retryInlineBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  retryInlineText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0D0F14',
  },
  resultsCountRow: {
    marginBottom: 8,
  },
  resultsCountText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  resultCard: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 10,
    marginBottom: 12,
    gap: 12,
  },
  cardPressed: {
    opacity: 0.85,
  },
  resultCover: {
    width: 68,
    height: 94,
    borderRadius: 6,
    backgroundColor: Colors.surfaceLight,
  },
  resultDetails: {
    flex: 1,
    justifyContent: 'space-between',
  },
  resultTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  resultTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    lineHeight: 19,
  },
  mtlBadge: {
    backgroundColor: Colors.warningMuted,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  mtlBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: Colors.warning,
  },
  resultSourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 5,
  },
  sourceNameBadge: {
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sourceNameBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.primary,
  },
  resultAuthor: {
    flex: 1,
    fontSize: 12,
    color: Colors.textSecondary,
  },
  resultDomain: {
    flex: 1,
    fontSize: 11,
    color: Colors.textMuted,
    fontFamily: 'monospace',
  },
  resultMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    gap: 8,
  },
  metaBadge: {
    flexShrink: 1,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  metaBadgeText: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  viewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primaryMuted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  viewButtonText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.primary,
  },
  emptyStateBox: {
    paddingVertical: 48,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyStateTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
    marginTop: 14,
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyStateSub: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 19,
  },
  importBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  importCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 22,
    alignItems: 'center',
  },
  importTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    marginTop: 14,
    textAlign: 'center',
  },
  importSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 6,
    textAlign: 'center',
  },
  importDomain: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 4,
    fontFamily: 'monospace',
  },
  importErrorText: {
    fontSize: 13,
    color: Colors.danger,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
    lineHeight: 18,
  },
  importActions: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  importCancelBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: Colors.surfaceRaised,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  importCancelText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  importRetryBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  importRetryText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0D0F14',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    paddingBottom: 36,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.text,
  },
  linkHelperText: {
    fontSize: 12,
    color: Colors.textMuted,
    marginBottom: 12,
    lineHeight: 18,
  },
  modeSwitchRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Colors.surfaceRaised,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modeBtnActive: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  modeBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  modeBtnTextActive: {
    color: Colors.primary,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 46,
    color: Colors.text,
    fontSize: 14,
    marginBottom: 12,
  },
  authErrorText: {
    fontSize: 12,
    color: Colors.danger,
    marginBottom: 12,
  },
  loginSubmitBtn: {
    backgroundColor: Colors.primary,
    height: 46,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  loginSubmitText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0D0F14',
  },
  signedInBox: {
    backgroundColor: Colors.surfaceRaised,
    padding: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  signedInLabel: {
    fontSize: 11,
    color: Colors.success,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  signedInEmail: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
  },
  signedInRole: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 4,
    marginBottom: 14,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.dangerMuted,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  logoutBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.danger,
  },
});
