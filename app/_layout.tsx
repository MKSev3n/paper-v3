import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { Colors } from '../src/theme/colors';
import { getDatabase } from '../src/services/database';
import { initFileStorage } from '../src/services/fileStorage';

export default function RootLayout() {
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
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" backgroundColor={Colors.background} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Colors.background },
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
