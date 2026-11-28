import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform, StyleSheet } from 'react-native';
import { useAppTheme } from '../../src/theme/ThemeProvider';

export default function TabsLayout() {
  const { colors } = useAppTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.borderLight,
          borderTopWidth: StyleSheet.hairlineWidth < 1 ? 1 : StyleSheet.hairlineWidth,
          height: Platform.OS === 'android' ? 62 : 84,
          paddingBottom: Platform.OS === 'android' ? 8 : 28,
          paddingTop: 8,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="discover"
        options={{
          title: 'Discover',
          tabBarAccessibilityLabel: 'Discover tab',
          tabBarIcon: ({ color }) => <Ionicons name="compass-outline" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Library',
          tabBarAccessibilityLabel: 'Library tab',
          tabBarIcon: ({ color }) => <Ionicons name="book-outline" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="downloads"
        options={{
          title: 'Downloads',
          tabBarAccessibilityLabel: 'Downloads tab',
          tabBarIcon: ({ color }) => <Ionicons name="cloud-download-outline" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarAccessibilityLabel: 'Settings tab',
          tabBarIcon: ({ color }) => <Ionicons name="settings-outline" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}