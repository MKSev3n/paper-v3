import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { Colors } from '../src/theme/colors';
import { ThemeProvider, useAppTheme } from '../src/theme/ThemeProvider';
import { getDatabase } from '../src/services/database';
import { initFileStorage } from '../src/services/fileStorage';
import HiddenChapterWebView from '../src/components/HiddenChapterWebView';

function RootLayoutInner() {
  const { scheme, colors } = useAppTheme();
  const [ready, setReady] = React.useState(false);

  useEffect(() => {
    async function prepare() {
      try {
        await Promise.all([
          getDatabase(),
          initFileStorage(),
        ]);
      } catch (e) {
        console.warn('Initialization error:', e);
      } finally {
        setReady(true);
      }
    }
    prepare();
  }, []);

  if (!ready) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} backgroundColor={colors.background} />
      <HiddenChapterWebView />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="novel/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="reader/[id]" options={{ headerShown: false }} />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootLayoutInner />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
