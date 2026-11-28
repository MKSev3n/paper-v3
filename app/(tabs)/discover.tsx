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
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { APP_CONFIG } from '../../src/config';
import { saveChaptersBatch, upsertNovel } from '../../src/services/database';
import { getDiscoverProviders, saveDiscoverProviders } from '../../src/services/storage';
import {
  buildLocalChapterId,
  buildLocalNovelId,
  extractSourceDomain,
  getSource,
  ListingKind,
  matchSourceByUrl,
  SearchItem,
  Source,
  SOURCES,
  toAbsoluteUrl,
} from '../../src/sources';

const QUICK_TAGS = ['Fantasy', 'Action', 'Adventure', 'Comedy', 'Drama', 'Eastern', 'Harem', 'Romance'];
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

function mapSearchItem(
  source: Source,
  providerId: SearchProviderId,
  item: SearchItem
): UnifiedSearchResult {
  const normTitle = normalizeSearchTitle(item.title);
  const normPath = item.path.trim();
  return {
    key: `${source.id}:${normPath}`,
    provider: providerId,
    sourceName: source.name,
    title: item.title,
    displayTitle: item.title,
    isMtl: false,
    path: normPath,
    url: toAbsoluteUrl(normPath, source.site),
    domain: extractSourceDomain(source),
    cover: item.cover,
    author: item.author,
    normalizedTitle: normTitle,
  };
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
// Recommended (listing) helpers
// ==========================================

const LISTING_TABS: { kind: ListingKind; label: string }[] = [
  { kind: 'hot', label: 'Hot' },
  { kind: 'popular', label: 'Popular' },
  { kind: 'latest', label: 'Latest' },
];

const RECOMMEND_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function recommendCacheKey(sourceId: string, tab: ListingKind): string {
  return `paper:recommend:${sourceId}:${tab}`;
}

async function readRecommendCache(
  sourceId: string,
  tab: ListingKind
): Promise<UnifiedSearchResult[] | null> {
  try {
    const raw = await AsyncStorage.getItem(recommendCacheKey(sourceId, tab));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== 'number' || !Array.isArray(parsed.items)) {
      return null;
    }
    if (Date.now() - parsed.savedAt > RECOMMEND_CACHE_TTL_MS) return null;
    return parsed.items as UnifiedSearchResult[];
  } catch {
    return null;
  }
}

async function writeRecommendCache(
  sourceId: string,
  tab: ListingKind,
  items: UnifiedSearchResult[]
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      recommendCacheKey(sourceId, tab),
      JSON.stringify({ savedAt: Date.now(), items })
    );
  } catch {
    // Cache writes are best-effort; never surface errors.
  }
}

/**
 * Interleave one item from each source in turn (round-robin), de-duplicating
 * by normalized title so a novel shared across sources appears once.
 */
function interleaveByProvider(
  perProvider: Partial<Record<SearchProviderId, UnifiedSearchResult[]>>
): UnifiedSearchResult[] {
  const lists = PROVIDER_CHIPS.map((chip) => perProvider[chip.id] || []).filter(
    (list) => list.length > 0
  );
  const out: UnifiedSearchResult[] = [];
  const seen = new Set<string>();
  let index = 0;
  let addedAny = true;
  while (addedAny) {
    addedAny = false;
    for (const list of lists) {
      if (index < list.length) {
        addedAny = true;
        const item = list[index];
        if (!seen.has(item.normalizedTitle)) {
          seen.add(item.normalizedTitle);
          out.push(item);
        }
      }
    }
    index += 1;
  }
  return out;
}

// ==========================================
// TOP-LEVEL SUBCOMPONENTS (prevents keyboard blur/remount)
// ==========================================

interface ServerStatusCompactProps {
  serverStatus: ServerStatusState;
  isWaking: boolean;
  onPressAccount: () => void;
  onRetryConnection: () => void;
}

// Compact server status: only rendered while waking or when the server is not
// authenticated. Successful connections render nothing to keep the header clean.
function ServerStatusCompact({
  serverStatus,
  isWaking,
  onPressAccount,
  onRetryConnection,
}: ServerStatusCompactProps) {
  const showError = serverStatus.tested && !serverStatus.authenticated && !isWaking;
  // Show the compact while waking, after a failed test, or whenever lncrawl is
  // needed but the user is not logged in (so they can sign in).
  if (!isWaking && serverStatus.authenticated) return null;
  if (!isWaking && !showError && serverStatus.tested) return null;

  return (
    <View style={[styles.serverCompact, showError && styles.serverCompactError]}>
      {isWaking ? (
        <ActivityIndicator size="small" color={Colors.primary} />
      ) : (
        <Ionicons name="alert-circle" size={14} color={Colors.danger} />
      )}
      <Text
        style={[styles.serverCompactText, showError && styles.serverCompactTextError]}
        numberOfLines={1}
      >
        {isWaking
          ? 'Waking up server...'
          : serverStatus.error
            ? serverStatus.error
            : serverStatus.tested
              ? 'Server disconnected / unauthorized'
              : 'Log in to lncrawl'}
      </Text>
      <View style={styles.serverCompactActions}>
        {showError && (
          <Pressable
            style={styles.serverCompactRetry}
            onPress={onRetryConnection}
            hitSlop={6}
          >
            <Text style={styles.serverCompactRetryText}>Retry</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.serverCompactAccount}
          onPress={onPressAccount}
          hitSlop={6}
        >
          <Ionicons name="log-in-outline" size={16} color={Colors.primary} />
          <Text style={styles.serverCompactLoginText}>Log in to lncrawl</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface SourcesButtonProps {
  count: number;
  onPress: () => void;
}

// Compact filter button that opens the source picker instead of a full chip row.
function SourcesButton({ count, onPress }: SourcesButtonProps) {
  return (
    <Pressable
      style={styles.sourcesBtn}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Sources, ${count} selected`}
    >
      <Ionicons name="options-outline" size={15} color={Colors.primary} />
      <Text style={styles.sourcesBtnText}>Sources</Text>
      <View style={styles.sourcesCountBadge}>
        <Text style={styles.sourcesCountText}>{count}</Text>
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

interface ProviderStatusStripProps {
  selectedProviders: SearchProviderId[];
  statuses: Partial<Record<SearchProviderId, ProviderSearchState>>;
  onRetryProvider: (id: SearchProviderId) => void;
}

// Only surface compact loading indicators and errors. Successful providers and
// their result counts are intentionally hidden to reduce header clutter.
function ProviderStatusStrip({
  selectedProviders,
  statuses,
  onRetryProvider,
}: ProviderStatusStripProps) {
  const activeEntries = selectedProviders
    .map((id) => ({ id, state: statuses[id] }))
    .filter(
      (entry) =>
        entry.state &&
        (entry.state.status === 'loading' || entry.state.status === 'error')
    );

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
            ) : (
              <Ionicons name="alert-circle" size={13} color={Colors.danger} />
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
                : `${name}: ${state.error || 'Failed'}`}
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
  selectedGenre: string | null;
  onSelectGenre: (genre: string) => void;
}

const GENRE_PREVIEW_COUNT = 5;

function QuickGenrePills({ selectedGenre, onSelectGenre }: QuickGenrePillsProps) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = QUICK_TAGS.length > GENRE_PREVIEW_COUNT;

  let visibleTags = expanded
    ? QUICK_TAGS
    : QUICK_TAGS.slice(0, GENRE_PREVIEW_COUNT);
  // Keep an off-preview selection visible so the active genre is never hidden.
  if (selectedGenre && !visibleTags.includes(selectedGenre)) {
    visibleTags = [selectedGenre, ...visibleTags.slice(0, GENRE_PREVIEW_COUNT - 1)];
  }

  return (
    <View style={styles.genreRow}>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        data={visibleTags}
        keyExtractor={(item) => item}
        extraData={selectedGenre}
        style={styles.genreList}
        contentContainerStyle={styles.genreListContent}
        renderItem={({ item }) => {
          const isSelected = selectedGenre === item;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              style={[styles.tagChip, isSelected && styles.tagChipSelected]}
              onPress={() => onSelectGenre(item)}
            >
              <Text
                style={[
                  styles.tagChipText,
                  isSelected && styles.tagChipTextSelected,
                ]}
              >
                {item}
              </Text>
            </Pressable>
          );
        }}
      />
      {canExpand && (
        <Pressable
          style={styles.seeAllBtn}
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
        >
          <Text style={styles.seeAllText}>{expanded ? 'Less' : 'See all'}</Text>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={13}
            color={Colors.textMuted}
          />
        </Pressable>
      )}
    </View>
  );
}

interface ExternalResultCardProps {
  item: UnifiedSearchResult;
  onPress: (item: UnifiedSearchResult) => void;
  variant?: 'list' | 'grid';
}

function ExternalResultCard({ item, onPress, variant = 'list' }: ExternalResultCardProps) {
  if (variant === 'grid') {
    return (
      <Pressable
        style={({ pressed }) => [styles.gridCard, pressed && styles.cardPressed]}
        onPress={() => onPress(item)}
        accessibilityRole="button"
      >
        <Image
          source={item.cover ? { uri: item.cover } : require('../../assets/icon.png')}
          style={styles.gridCardCover}
          resizeMode="cover"
        />
        <Text style={styles.gridCardTitle} numberOfLines={2}>
          {item.displayTitle}
        </Text>
        <View style={styles.sourceNameBadge}>
          <Text style={styles.sourceNameBadgeText} numberOfLines={1}>
            {item.sourceName}
          </Text>
        </View>
      </Pressable>
    );
  }

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
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
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

  // Genre listing state
  const [genrePage, setGenrePage] = useState(1);
  const [genreLoadingMore, setGenreLoadingMore] = useState(false);

  // Recommended (listing) state
  const [recommendedTab, setRecommendedTab] = useState<ListingKind>('hot');
  const [recommendByProvider, setRecommendByProvider] = useState<
    Partial<Record<SearchProviderId, UnifiedSearchResult[]>>
  >({});
  const [recommendStatuses, setRecommendStatuses] = useState<
    Partial<Record<SearchProviderId, ProviderSearchState>>
  >({});
  const [recommendLoading, setRecommendLoading] = useState(true);
  const [recommendLoadingMore, setRecommendLoadingMore] = useState(false);
  const [recommendRefreshing, setRecommendRefreshing] = useState(false);

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

  // Sources filter modal state
  const [sourcesModalVisible, setSourcesModalVisible] = useState(false);

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
  // Mirrors resultsByProvider so genre appends can dedupe & count synchronously
  const resultsByProviderRef = useRef<
    Partial<Record<SearchProviderId, UnifiedSearchResult[]>>
  >({});
  // Recommended (listing) refs
  const recommendRunIdRef = useRef(0);
  const recommendByProviderRef = useRef<
    Partial<Record<SearchProviderId, UnifiedSearchResult[]>>
  >({});
  const recommendPageRef = useRef(1);
  const recommendedTabRef = useRef<ListingKind>('hot');

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
        const mapped: UnifiedSearchResult[] = [];

        for (const item of rawItems) {
          const normTitle = normalizeSearchTitle(item.title);
          const normPath = item.path.trim();
          if (!normTitle || !normPath) continue;
          if (seenTitles.has(normTitle) || seenPaths.has(normPath)) continue;

          seenTitles.add(normTitle);
          seenPaths.add(normPath);

          mapped.push(mapSearchItem(source, providerId, item));
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

  const runGenreProvider = useCallback(
    async (
      source: Source,
      genre: string,
      page: number,
      currentRunId: number,
      markGlobalDoneIfFinished: () => void
    ) => {
      const providerId = source.id as SearchProviderId;
      setProviderStatuses((prev) => ({
        ...prev,
        [providerId]: { status: 'loading', count: prev[providerId]?.count || 0 },
      }));

      try {
        const rawItems = await withTimeout(
          source.getByGenre(genre, page),
          LOCAL_SEARCH_TIMEOUT_MS,
          source.name
        );

        if (searchRunIdRef.current !== currentRunId) return;

        const mapped = rawItems
          .map((item) => mapSearchItem(source, providerId, item))
          .filter((it) => it.normalizedTitle && it.path);

        // Append to any existing page results, deduping by normalized title
        const prevList = resultsByProviderRef.current[providerId] || [];
        const seen = new Set(prevList.map((r) => r.normalizedTitle));
        const additions = mapped.filter((m) => !seen.has(m.normalizedTitle));
        const nextList = [...prevList, ...additions];
        const nextMap = { ...resultsByProviderRef.current, [providerId]: nextList };
        resultsByProviderRef.current = nextMap;
        setResultsByProvider(nextMap);

        setProviderStatuses((prev) => ({
          ...prev,
          [providerId]: { status: 'done', count: nextList.length },
        }));
      } catch (err: any) {
        if (searchRunIdRef.current !== currentRunId) return;
        const msg = err?.message || 'Genre load failed';
        setProviderStatuses((prev) => ({
          ...prev,
          [providerId]: {
            status: 'error',
            count: prev[providerId]?.count || 0,
            error: msg,
          },
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
        setErrorMessage('Select at least one source using the Sources button above.');
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
      resultsByProviderRef.current = {};

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

  // Load a genre listing from all selected sources (never calls search()).
  // page 1 resets results; later pages append and dedupe by normalized title.
  const runGenreSearch = useCallback(
    async (genre: string, page: number, append: boolean) => {
      const activeProviders = selectedProvidersRef.current;
      if (activeProviders.length === 0) {
        if (!append) {
          setErrorMessage('Select at least one source using the Sources button above to load a genre.');
        }
        return;
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (!append) {
        stopActiveSearch();
      }
      const currentRunId = searchRunIdRef.current;

      if (!append) {
        lastSubmittedQueryRef.current = '';
        resultsByProviderRef.current = {};
        setSearchQuery('');
        setResultsByProvider({});
        setProviderStatuses({});
        setErrorMessage(null);
        setHasSearched(true);
        setLastSearchedQuery(genre);
        setSearching(true);
        setGenreLoadingMore(false);
      } else {
        setGenreLoadingMore(true);
      }
      setGenrePage(page);

      let remaining = activeProviders.length;
      const markProviderFinished = () => {
        if (searchRunIdRef.current !== currentRunId) return;
        remaining = Math.max(0, remaining - 1);
        if (remaining === 0) {
          setSearching(false);
          setGenreLoadingMore(false);
        }
      };

      const tasks: Promise<void>[] = [];
      for (const pid of activeProviders) {
        const source = getSource(pid);
        if (source) {
          tasks.push(runGenreProvider(source, genre, page, currentRunId, markProviderFinished));
        } else {
          markProviderFinished();
        }
      }

      await Promise.allSettled(tasks);
    },
    [stopActiveSearch, runGenreProvider]
  );

  const getSelectedLocalSources = useCallback(
    () =>
      selectedProvidersRef.current
        .map((id) => getSource(id))
        .filter((s): s is Source => Boolean(s)),
    []
  );

  // Load one source's listing page for the Recommended section.
  const runRecommendProvider = useCallback(
    async (
      source: Source,
      tab: ListingKind,
      page: number,
      currentRunId: number,
      append: boolean,
      markDone: () => void
    ) => {
      const providerId = source.id as SearchProviderId;
      setRecommendStatuses((prev) => ({
        ...prev,
        [providerId]: { status: 'loading', count: prev[providerId]?.count || 0 },
      }));

      try {
        const rawItems = await withTimeout(
          source.getListing(tab, page),
          LOCAL_SEARCH_TIMEOUT_MS,
          source.name
        );

        if (recommendRunIdRef.current !== currentRunId) return;

        const mapped = rawItems
          .map((item) => mapSearchItem(source, providerId, item))
          .filter((it) => it.normalizedTitle && it.path);

        const prevList = append ? recommendByProviderRef.current[providerId] || [] : [];
        const seen = new Set(prevList.map((r) => r.normalizedTitle));
        const additions = mapped.filter((m) => !seen.has(m.normalizedTitle));
        const nextList = append ? [...prevList, ...additions] : additions;

        const nextMap = { ...recommendByProviderRef.current, [providerId]: nextList };
        recommendByProviderRef.current = nextMap;
        setRecommendByProvider(nextMap);

        writeRecommendCache(providerId, tab, nextList);

        setRecommendStatuses((prev) => ({
          ...prev,
          [providerId]: { status: 'done', count: nextList.length },
        }));
      } catch (err: any) {
        if (recommendRunIdRef.current !== currentRunId) return;
        setRecommendStatuses((prev) => ({
          ...prev,
          [providerId]: {
            status: 'error',
            count: prev[providerId]?.count || 0,
            error: err?.message || 'Failed',
          },
        }));
      } finally {
        if (recommendRunIdRef.current === currentRunId) markDone();
      }
    },
    []
  );

  const fetchRecommendInto = useCallback(
    async (tab: ListingKind, page: number, append: boolean, runId: number) => {
      const sources = getSelectedLocalSources();
      if (sources.length === 0) {
        setRecommendLoading(false);
        setRecommendLoadingMore(false);
        setRecommendRefreshing(false);
        return;
      }

      let remaining = sources.length;
      const markDone = () => {
        if (recommendRunIdRef.current !== runId) return;
        remaining = Math.max(0, remaining - 1);
        if (remaining === 0) {
          setRecommendLoading(false);
          setRecommendLoadingMore(false);
          setRecommendRefreshing(false);
        }
      };

      const tasks = sources.map((source) =>
        runRecommendProvider(source, tab, page, runId, append, markDone)
      );
      await Promise.allSettled(tasks);
    },
    [getSelectedLocalSources, runRecommendProvider]
  );

  // Show cached results immediately, then refresh page 1 from the network.
  const loadRecommendedInitial = useCallback(
    async (tab: ListingKind) => {
      const sources = getSelectedLocalSources();
      const runId = ++recommendRunIdRef.current;
      recommendPageRef.current = 1;

      if (sources.length === 0) {
        recommendByProviderRef.current = {};
        setRecommendByProvider({});
        setRecommendStatuses({});
        setRecommendLoading(false);
        return;
      }

      recommendByProviderRef.current = {};
      setRecommendByProvider({});
      setRecommendStatuses({});
      setRecommendLoading(true);

      const cached = await Promise.all(
        sources.map((source) => readRecommendCache(source.id, tab))
      );
      if (recommendRunIdRef.current !== runId) return;

      const cacheMap: Partial<Record<SearchProviderId, UnifiedSearchResult[]>> = {};
      const cacheStatuses: Partial<Record<SearchProviderId, ProviderSearchState>> = {};
      sources.forEach((source, i) => {
        const pid = source.id as SearchProviderId;
        const items = cached[i];
        if (items && items.length > 0) {
          cacheMap[pid] = items;
          cacheStatuses[pid] = { status: 'done', count: items.length };
        }
      });
      recommendByProviderRef.current = cacheMap;
      setRecommendByProvider(cacheMap);
      setRecommendStatuses(cacheStatuses);

      await fetchRecommendInto(tab, 1, false, runId);
    },
    [getSelectedLocalSources, fetchRecommendInto]
  );

  const handleSelectRecommendTab = useCallback((tab: ListingKind) => {
    if (tab === recommendedTabRef.current) return;
    recommendedTabRef.current = tab;
    setRecommendedTab(tab);
  }, []);

  const handleRecommendRefresh = useCallback(async () => {
    const tab = recommendedTabRef.current;
    const runId = ++recommendRunIdRef.current;
    recommendPageRef.current = 1;
    setRecommendRefreshing(true);
    setRecommendLoading(true);
    setRecommendStatuses({});
    await fetchRecommendInto(tab, 1, false, runId);
  }, [fetchRecommendInto]);

  const handleRecommendLoadMore = useCallback(async () => {
    if (recommendLoadingMore || recommendLoading) return;
    const tab = recommendedTabRef.current;
    const nextPage = recommendPageRef.current + 1;
    const runId = recommendRunIdRef.current;
    recommendPageRef.current = nextPage;
    setRecommendLoadingMore(true);
    await fetchRecommendInto(tab, nextPage, true, runId);
  }, [fetchRecommendInto, recommendLoadingMore, recommendLoading]);

  const handleRetryRecommendProvider = useCallback(
    async (providerId: SearchProviderId) => {
      const source = getSource(providerId);
      if (!source) return;
      const tab = recommendedTabRef.current;
      const page = recommendPageRef.current;
      const runId = recommendRunIdRef.current;
      await runRecommendProvider(source, tab, page, runId, page > 1, () => {});
    },
    [runRecommendProvider]
  );

  const showRecommended = searchQuery.trim().length === 0 && !selectedGenre;

  // Load recommendations whenever the Recommended section is visible, the tab
  // changes, or the selected sources change.
  useEffect(() => {
    if (!providersLoaded) return;
    if (!showRecommended) return;
    loadRecommendedInitial(recommendedTab);
  }, [providersLoaded, showRecommended, recommendedTab, selectedProviders, loadRecommendedInitial]);

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
    if (selectedGenre === genre) {
      // Tapping the selected pill again clears the selection & results
      setSelectedGenre(null);
      handleClearSearch();
      return;
    }
    setSelectedGenre(genre);
    runGenreSearch(genre, 1, false);
  };

  const handleLoadMore = () => {
    if (!selectedGenre || genreLoadingMore || searching) return;
    runGenreSearch(selectedGenre, genrePage + 1, true);
  };

  // Typing in the search box exits genre mode and runs a normal title search.
  const handleSearchQueryChange = (text: string) => {
    if (selectedGenre) {
      setSelectedGenre(null);
      setGenreLoadingMore(false);
      setGenrePage(1);
    }
    setSearchQuery(text);
  };

  const handleClearSearch = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    stopActiveSearch();
    lastSubmittedQueryRef.current = '';
    resultsByProviderRef.current = {};
    setSearchQuery('');
    setSearching(false);
    setServerProgress(0);
    setHasSearched(false);
    setLastSearchedQuery('');
    setResultsByProvider({});
    setProviderStatuses({});
    setErrorMessage(null);
    setSelectedGenre(null);
    setGenrePage(1);
    setGenreLoadingMore(false);
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

  // Recommended list: interleave one item from each source, dedupe by title.
  const recommendList = useMemo(
    () => interleaveByProvider(recommendByProvider),
    [recommendByProvider]
  );

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

  const renderRecommendSkeleton = () => (
    <View>
      {[0, 1, 2].map((row) => (
        <View key={row} style={styles.gridRow}>
          <View style={styles.skeletonCard} />
          <View style={styles.skeletonCard} />
        </View>
      ))}
    </View>
  );

  const renderRecommendEmpty = () => {
    const hasSources = selectedProviders.some((id) => Boolean(getSource(id)));
    if (!hasSources) {
      return (
        <View style={styles.emptyStateBox}>
          <Ionicons name="library-outline" size={44} color={Colors.surfaceLight} />
          <Text style={styles.emptyStateTitle}>No sources selected</Text>
          <Text style={styles.emptyStateSub}>
            Enable at least one source using the Sources button above to load recommendations.
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyStateBox}>
        <Ionicons name="star-outline" size={44} color={Colors.surfaceLight} />
        <Text style={styles.emptyStateTitle}>No recommendations</Text>
        <Text style={styles.emptyStateSub}>
          Pull down to refresh or try another tab.
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Fixed Header & SearchBar kept outside FlatList so TextInput NEVER unmounts */}
      <View style={styles.headerContainer}>
        <View style={styles.titleRow}>
          <Text style={styles.screenTitle}>Discover</Text>
          <View style={styles.titleActions}>
            <SourcesButton
              count={selectedProviders.length}
              onPress={() => setSourcesModalVisible(true)}
            />
            <Pressable
              style={styles.addLinkButton}
              onPress={() => {
                setLinkError(null);
                setLinkModalVisible(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Add by link"
            >
              <Ionicons name="link-outline" size={16} color={Colors.primary} />
              <Text style={styles.addLinkButtonText}>Add link</Text>
            </Pressable>
          </View>
        </View>

        <SearchBar
          value={searchQuery}
          loading={searching}
          onChangeText={handleSearchQueryChange}
          onClear={handleClearSearch}
          onSubmit={handleSubmitSearch}
        />

        <QuickGenrePills
          selectedGenre={selectedGenre}
          onSelectGenre={handleSelectGenre}
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

        {lncrawlSelected && (
          <ServerStatusCompact
            serverStatus={serverStatus}
            isWaking={isWaking}
            onPressAccount={() => setAuthModalVisible(true)}
            onRetryConnection={checkServer}
          />
        )}

        {!showRecommended && (
          <ProviderStatusStrip
            selectedProviders={selectedProviders}
            statuses={providerStatuses}
            onRetryProvider={handleRetrySingleProvider}
          />
        )}

        {!showRecommended && errorMessage && (
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

        {!showRecommended && (combinedResults.length > 0 || searching) && (
          <View style={styles.resultsCountRow}>
            <Text style={styles.resultsCountText}>
              {searching
                ? `Searching... ${combinedResults.length} found so far`
                : `Found ${combinedResults.length} novels`}
            </Text>
          </View>
        )}
      </View>

      {showRecommended ? (
        <FlatList
          key="recommended-grid"
          data={recommendList}
          keyExtractor={(item) => item.key}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          renderItem={({ item }) => (
            <ExternalResultCard item={item} variant="grid" onPress={handleOpenSearchResult} />
          )}
          ListHeaderComponent={
            <View>
              <View style={styles.recommendHeaderRow}>
                <Text style={styles.recommendTitle}>Recommended</Text>
                {recommendLoading && recommendList.length > 0 && (
                  <ActivityIndicator size="small" color={Colors.primary} />
                )}
              </View>
              <View style={styles.recommendTabsRow}>
                {LISTING_TABS.map((t) => {
                  const active = recommendedTab === t.kind;
                  return (
                    <Pressable
                      key={t.kind}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: active }}
                      style={[styles.recommendTab, active && styles.recommendTabActive]}
                      onPress={() => handleSelectRecommendTab(t.kind)}
                    >
                      <Text
                        style={[
                          styles.recommendTabText,
                          active && styles.recommendTabTextActive,
                        ]}
                      >
                        {t.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <ProviderStatusStrip
                selectedProviders={selectedProviders}
                statuses={recommendStatuses}
                onRetryProvider={handleRetryRecommendProvider}
              />
            </View>
          }
          ListEmptyComponent={
            recommendLoading && recommendList.length === 0
              ? renderRecommendSkeleton()
              : renderRecommendEmpty()
          }
          ListFooterComponent={
            recommendList.length > 0 ? (
              <Pressable
                style={[styles.loadMoreBtn, recommendLoadingMore && styles.loadMoreBtnDisabled]}
                onPress={handleRecommendLoadMore}
                disabled={recommendLoadingMore}
                accessibilityRole="button"
              >
                {recommendLoadingMore ? (
                  <ActivityIndicator size="small" color="#0D0F14" />
                ) : (
                  <>
                    <Text style={styles.loadMoreText}>Load more</Text>
                    <Ionicons name="chevron-down" size={16} color="#0D0F14" />
                  </>
                )}
              </Pressable>
            ) : null
          }
          contentContainerStyle={styles.recommendContent}
          refreshControl={
            <RefreshControl
              refreshing={recommendRefreshing}
              onRefresh={handleRecommendRefresh}
              tintColor={Colors.primary}
              colors={[Colors.primary]}
            />
          }
          keyboardShouldPersistTaps="handled"
        />
      ) : (
        <FlatList
          key="search-list"
          data={combinedResults}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <ExternalResultCard item={item} onPress={handleOpenSearchResult} />
          )}
          ListEmptyComponent={renderEmptyComponent}
          ListFooterComponent={
            selectedGenre && combinedResults.length > 0 ? (
              <Pressable
                style={[styles.loadMoreBtn, genreLoadingMore && styles.loadMoreBtnDisabled]}
                onPress={handleLoadMore}
                disabled={genreLoadingMore}
                accessibilityRole="button"
              >
                {genreLoadingMore ? (
                  <ActivityIndicator size="small" color="#0D0F14" />
                ) : (
                  <>
                    <Text style={styles.loadMoreText}>Load more</Text>
                    <Ionicons name="chevron-down" size={16} color="#0D0F14" />
                  </>
                )}
              </Pressable>
            ) : null
          }
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
        />
      )}

      {/* Sources Filter Modal */}
      <Modal
        visible={sourcesModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSourcesModalVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setSourcesModalVisible(false)}
        >
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Sources</Text>
              <Pressable
                onPress={() => setSourcesModalVisible(false)}
                hitSlop={10}
              >
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>

            <Text style={styles.linkHelperText}>
              Select which sources to use for search and recommendations.
            </Text>

            {PROVIDER_CHIPS.map((chip) => {
              const isSelected = selectedProviders.includes(chip.id);
              return (
                <Pressable
                  key={chip.id}
                  style={[
                    styles.sourceOptionRow,
                    isSelected && styles.sourceOptionRowSelected,
                  ]}
                  onPress={() => handleToggleProvider(chip.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                >
                  <Ionicons
                    name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                    size={20}
                    color={isSelected ? Colors.primary : Colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.sourceOptionText,
                      isSelected && styles.sourceOptionTextSelected,
                    ]}
                  >
                    {chip.label}
                  </Text>
                </Pressable>
              );
            })}

            {lncrawlSelected && (
              <Pressable
                style={styles.sourceAccountRow}
                onPress={() => {
                  setSourcesModalVisible(false);
                  setAuthModalVisible(true);
                }}
              >
                <Ionicons
                  name={
                    serverStatus.authenticated ? 'person-circle' : 'log-in-outline'
                  }
                  size={18}
                  color={serverStatus.authenticated ? Colors.success : Colors.primary}
                />
                <Text style={styles.sourceAccountText} numberOfLines={1}>
                  {serverStatus.authenticated
                    ? serverStatus.user?.email || 'Server account'
                    : 'Sign in to server'}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
              </Pressable>
            )}

            <Pressable
              style={styles.loginSubmitBtn}
              onPress={() => setSourcesModalVisible(false)}
            >
              <Text style={styles.loginSubmitText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

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
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.4,
  },
  titleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  },
  addLinkButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
  },
  sourcesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  sourcesBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  sourcesCountBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourcesCountText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#0D0F14',
  },
  serverCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 6,
  },
  serverCompactError: {
    borderColor: 'rgba(239, 68, 68, 0.4)',
    backgroundColor: Colors.dangerMuted,
  },
  serverCompactText: {
    flex: 1,
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  serverCompactTextError: {
    color: Colors.danger,
  },
  serverCompactActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  serverCompactRetry: {
    backgroundColor: Colors.danger,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  serverCompactRetryText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  serverCompactAccount: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 2,
  },
  serverCompactLoginText: {
    fontSize: 12,
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
  genreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 6,
  },
  genreList: {
    flex: 1,
  },
  genreListContent: {
    gap: 8,
    paddingRight: 8,
  },
  seeAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  seeAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textMuted,
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
  tagChipSelected: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  tagChipTextSelected: {
    color: '#0D0F14',
    fontWeight: '700',
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
  loadMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  loadMoreBtnDisabled: {
    opacity: 0.7,
  },
  loadMoreText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0D0F14',
  },
  recommendContent: {
    paddingHorizontal: 12,
    paddingBottom: 40,
  },
  recommendHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 10,
  },
  recommendTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.3,
  },
  recommendTabsRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 3,
    marginBottom: 10,
  },
  recommendTab: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recommendTabActive: {
    backgroundColor: Colors.primary,
  },
  recommendTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  recommendTabTextActive: {
    color: '#0D0F14',
    fontWeight: '700',
  },
  gridRow: {
    flexDirection: 'row',
    gap: 10,
  },
  gridCard: {
    flex: 1,
    marginBottom: 12,
    backgroundColor: Colors.surface,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    padding: 6,
  },
  gridCardCover: {
    width: '100%',
    aspectRatio: 0.64,
    borderRadius: 6,
    backgroundColor: Colors.surfaceLight,
  },
  gridCardTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.text,
    marginTop: 6,
    marginBottom: 5,
    minHeight: 34,
  },
  skeletonCard: {
    flex: 1,
    height: 200,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    marginBottom: 12,
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
  sourceOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
  },
  sourceOptionRowSelected: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  sourceOptionText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  sourceOptionTextSelected: {
    color: Colors.primary,
    fontWeight: '700',
  },
  sourceAccountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.surfaceRaised,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: 4,
    marginBottom: 8,
  },
  sourceAccountText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
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
