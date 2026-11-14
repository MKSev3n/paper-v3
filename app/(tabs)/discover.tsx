import React, { useState, useEffect, useCallback } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../src/theme/colors';
import { Novel, LNCrawlUser } from '../../src/types';
import { LNCrawlService } from '../../src/services/lncrawl';
import { LNCRAWL_API_BASE } from '../../src/config';
import { upsertNovel } from '../../src/services/database';

const QUICK_TAGS = ['Fantasy', 'Isekai', 'Action', 'Adventure', 'Romance', 'Cultivation', 'Sci-Fi'];

//Queries currently running (or already finished with) an external crawl job.
//Prevents launching duplicate crawl jobs for the same query.
const externalSearchAttempts = new Map<string, 'running' | 'done'>();

export default function SearchScreen() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Novel[]>([]);
  const [serverStatus, setServerStatus] = useState<{
    tested: boolean;
    online: boolean;
    authenticated: boolean;
    latencyMs: number;
    user?: LNCrawlUser;
  }>({ tested: false, online: true, authenticated: false, latencyMs: 0 });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [externalSearchState, setExternalSearchState] = useState<
    | { active: false }
    | { active: true; phase: 'searching' | 'fetching'; detail: string }
  >({ active: false });

  // Auth Modal State
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [authMode, setAuthMode] = useState<'credentials' | 'token'>('credentials');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const checkServer = useCallback(() => {
    LNCrawlService.testConnection()
      .then((res) => {
        setServerStatus({
          tested: true,
          online: res.online,
          authenticated: res.authenticated,
          latencyMs: res.latencyMs,
          user: res.user,
        });
      })
      .catch(() => {
        setServerStatus({
          tested: true,
          online: false,
          authenticated: false,
          latencyMs: 0,
        });
      });
  }, []);

  useEffect(() => {
    checkServer();
  }, [checkServer]);

  useFocusEffect(
    useCallback(() => {
      checkServer();
    }, [checkServer])
  );

  const handleSearch = async (queryToSearch?: string) => {
    const term = (queryToSearch !== undefined ? queryToSearch : searchQuery).trim();
    if (!term) return;

    Keyboard.dismiss();
    setLoading(true);
    setErrorMessage(null);

    try {
      const novels = await LNCrawlService.searchNovels(term);
      setResults(novels);
      if (novels.length === 0) {
        setErrorMessage(`No novels found for "${term}" in the server database.`);
        await runExternalSearch(term);
      }
    } catch (err: any) {
      console.warn('Search failed:', err);
      if (err?.status === 401) {
        setErrorMessage(
          'LNCrawl requires a free account to search. Sign in below to search and download novels.'
        );
        setAuthModalVisible(true);
      } else {
        setErrorMessage(
          err.message || 'Unable to connect to LNCrawl server. Please check your connection or custom API URL.'
        );
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * External crawl fallback, only after a genuine database miss.
   * Guards against duplicate jobs for the same query via a module-level map.
   */
  const runExternalSearch = async (term: string) => {
    const key = term.trim().toLowerCase();
    if (externalSearchAttempts.get(key) === 'running') {
      setErrorMessage('An external search for this title is already in progress.');
      return;
    }
    if (externalSearchAttempts.get(key) === 'done') {
      setErrorMessage(
        `No novels found for "${term}". External sources were already searched for this title.`
      );
      return;
    }

    externalSearchAttempts.set(key, 'running');
    setExternalSearchState({ active: true, phase: 'searching', detail: 'Searching external sources...' });

    try {
      const outcome = await LNCrawlService.externalSearch(term, {
        onPhase: (phase, detail) => setExternalSearchState({ active: true, phase, detail }),
      });

      switch (outcome.outcome) {
        case 'results': {
          externalSearchAttempts.set(key, 'done');
          const novels = await LNCrawlService.searchNovels(term);
          setResults(novels);
          if (novels.length > 0) {
            setErrorMessage(null);
          } else {
            setErrorMessage(
              `External sources matched "${term}", but the details are still being processed. Try again in a minute.`
            );
          }
          break;
        }
        case 'no_results':
          externalSearchAttempts.set(key, 'done');
          setErrorMessage(
            `No novels found for "${term}" in the server database or on any external source.`
          );
          break;
        case 'canceled':
          externalSearchAttempts.delete(key);
          setErrorMessage('The external search was canceled on the server.');
          break;
        case 'timeout':
          externalSearchAttempts.delete(key);
          setErrorMessage(
            'The external search took too long and was stopped. Try again - the server may be busy.'
          );
          break;
        case 'failed':
          externalSearchAttempts.delete(key);
          setErrorMessage(`External search failed: ${outcome.reason}`);
          break;
      }
    } finally {
      setExternalSearchState({ active: false });
    }
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
    setResults([]);
    closeAuthModal();
  };

  const handleSelectNovel = async (novel: Novel) => {
    try {
      await upsertNovel(novel);
      router.push({
        pathname: '/novel/[id]',
        params: { id: novel.id },
      });
    } catch (err) {
      console.warn('Error selecting novel:', err);
      router.push({
        pathname: '/novel/[id]',
        params: { id: novel.id },
      });
    }
  };

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      <Text style={styles.screenTitle}>Discover & Search</Text>
      <Text style={styles.screenSubtitle}>
        Search novels from your crawler API to download for offline reading
      </Text>

      {/* API & Auth Status Banner */}
      <Pressable
        style={styles.apiStatusCard}
        onPress={() => setAuthModalVisible(true)}
      >
        <View style={styles.apiStatusLeft}>
          <View
            style={[
              styles.statusDot,
              {
                backgroundColor: !serverStatus.online
                  ? Colors.danger
                  : serverStatus.authenticated
                  ? Colors.success
                  : Colors.warning,
              },
            ]}
          />
          <View style={styles.apiStatusTextGroup}>
            <Text style={styles.apiStatusText} numberOfLines={1}>
              {LNCRAWL_API_BASE.replace(/^https?:\/\//, '')}
            </Text>
            <Text style={styles.apiAuthSubtext} numberOfLines={1}>
              {serverStatus.authenticated
                ? `Signed in: ${serverStatus.user?.email || 'Active session'}`
                : serverStatus.online
                ? 'Tap to sign in (401 auth required)'
                : 'Offline / Cold start'}
            </Text>
          </View>
        </View>
        <View style={styles.apiRightAction}>
          <Text style={styles.apiLatencyText}>
            {serverStatus.tested
              ? serverStatus.online
                ? `${serverStatus.latencyMs}ms`
                : 'Offline'
              : 'Checking...'}
          </Text>
          <Ionicons
            name={serverStatus.authenticated ? 'person-circle' : 'log-in-outline'}
            size={18}
            color={serverStatus.authenticated ? Colors.success : Colors.primary}
          />
        </View>
      </Pressable>

      {/* Search Input Bar */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={20} color={Colors.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by title, author, keyword..."
          placeholderTextColor={Colors.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onSubmitEditing={() => handleSearch()}
          returnKeyType="search"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <Pressable
            onPress={() => setSearchQuery('')}
            hitSlop={10}
            style={styles.clearButton}
          >
            <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
          </Pressable>
        )}
        <Pressable
          style={[styles.searchSubmitButton, !searchQuery.trim() && styles.searchSubmitDisabled]}
          onPress={() => handleSearch()}
          disabled={!searchQuery.trim() || loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#0D0F14" />
          ) : (
            <Ionicons name="arrow-forward" size={18} color="#0D0F14" />
          )}
        </Pressable>
      </View>

      {/* Quick Tags */}
      <View style={styles.tagsContainer}>
        <Text style={styles.tagsLabel}>POPULAR GENRES</Text>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={QUICK_TAGS}
          keyExtractor={(item) => item}
          contentContainerStyle={styles.tagsList}
          renderItem={({ item }) => (
            <Pressable
              style={styles.tagChip}
              onPress={() => {
                setSearchQuery(item);
                handleSearch(item);
              }}
            >
              <Text style={styles.tagChipText}>{item}</Text>
            </Pressable>
          )}
        />
      </View>

      {externalSearchState.active && (
        <View style={styles.externalProgressCard}>
          <View style={styles.externalProgressRow}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <View style={styles.externalProgressTextGroup}>
              <Text style={styles.externalProgressTitle}>
                {externalSearchState.phase === 'searching'
                  ? 'Searching external sources'
                  : 'Fetching novel details'}
              </Text>
              <Text style={styles.externalProgressDetail}>{externalSearchState.detail}</Text>
            </View>
          </View>
          <View style={styles.externalProgressBarBg}>
            <View
              style={[
                styles.externalProgressBarFill,
                externalSearchState.phase === 'fetching' && styles.externalProgressBarWide,
              ]}
            />
          </View>
          <Text style={styles.externalProgressHint}>
            This can take a couple of minutes on the free server. Results appear automatically.
          </Text>
        </View>
      )}

      {errorMessage && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle" size={18} color={Colors.warning} />
          <Text style={styles.errorText}>{errorMessage}</Text>
          {!serverStatus.authenticated && (
            <Pressable
              style={styles.signInInlineBtn}
              onPress={() => setAuthModalVisible(true)}
            >
              <Text style={styles.signInInlineText}>Sign In</Text>
            </Pressable>
          )}
        </View>
      )}

      {results.length > 0 && (
        <View style={styles.resultsCountRow}>
          <Text style={styles.resultsCountText}>Found {results.length} results</Text>
        </View>
      )}
    </View>
  );

  const renderNovelItem = ({ item }: { item: Novel }) => (
    <Pressable
      style={({ pressed }) => [styles.resultCard, pressed && styles.cardPressed]}
      onPress={() => handleSelectNovel(item)}
    >
      <Image
        source={
          item.coverUrl
            ? { uri: item.coverUrl }
            : require('../../assets/icon.png')
        }
        style={styles.resultCover}
        resizeMode="cover"
      />
      <View style={styles.resultDetails}>
        <Text style={styles.resultTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.resultAuthor} numberOfLines={1}>
          {item.author}
        </Text>

        <Text style={styles.resultSynopsis} numberOfLines={2}>
          {item.synopsis}
        </Text>

        <View style={styles.resultMetaRow}>
          {item.status && (
            <View style={styles.metaBadge}>
              <Text style={styles.metaBadgeText}>{item.status}</Text>
            </View>
          )}
          {item.totalChapters > 0 && (
            <Text style={styles.chaptersCountText}>
              {item.totalChapters} chapters
            </Text>
          )}
          <View style={styles.viewButton}>
            <Text style={styles.viewButtonText}>Download</Text>
            <Ionicons name="download-outline" size={12} color={Colors.primary} />
          </View>
        </View>
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        renderItem={renderNovelItem}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      />

      {/* LNCrawl Sign-In Modal */}
      <Modal
        visible={authModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeAuthModal}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={closeAuthModal}
        >
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderTextGroup}>
                <Text style={styles.modalTitle}>
                  {serverStatus.authenticated ? 'LNCrawl Account' : 'Sign In to LNCrawl'}
                </Text>
                {!serverStatus.authenticated && (
                  <Text style={styles.modalSubtitle}>
                    The server requires an account to search or download.
                  </Text>
                )}
              </View>
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
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  headerContainer: {
    paddingTop: 12,
    paddingBottom: 16,
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
    marginBottom: 12,
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
    marginBottom: 14,
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
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    height: 48,
    marginBottom: 16,
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
  tagsContainer: {
    marginBottom: 16,
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
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: Colors.warning,
    lineHeight: 18,
  },
  signInInlineBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  signInInlineText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0D0F14',
  },
  resultsCountRow: {
    marginBottom: 12,
  },
  externalProgressCard: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primaryMuted,
    padding: 14,
    marginBottom: 16,
  },
  externalProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  externalProgressTextGroup: {
    flex: 1,
  },
  externalProgressTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  externalProgressDetail: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  externalProgressBarBg: {
    height: 6,
    backgroundColor: Colors.surfaceRaised,
    borderRadius: 3,
    marginTop: 12,
    overflow: 'hidden',
  },
  externalProgressBarFill: {
    height: '100%',
    width: '25%',
    backgroundColor: Colors.primary,
    borderRadius: 3,
  },
  externalProgressBarWide: {
    width: '65%',
  },
  externalProgressHint: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 8,
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
    width: 75,
    height: 105,
    borderRadius: 6,
    backgroundColor: Colors.surfaceLight,
  },
  resultDetails: {
    flex: 1,
    justifyContent: 'space-between',
  },
  resultTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    lineHeight: 18,
  },
  resultAuthor: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  resultSynopsis: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 16,
    marginTop: 4,
  },
  resultMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  metaBadge: {
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  metaBadgeText: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  chaptersCountText: {
    fontSize: 11,
    color: Colors.textMuted,
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
    marginBottom: 16,
  },
  modalHeaderTextGroup: {
    flex: 1,
    marginRight: 8,
  },
  modalSubtitle: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.text,
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
