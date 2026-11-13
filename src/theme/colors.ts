/**
 * Paper Theme & Color Design Tokens
 * Dark by default, airy paper-inspired reading palettes with soft sky-blue accents.
 */

export const Colors = {
  // Main App Palette (Dark by default)
  background: '#0D0F14',
  surface: '#161922',
  surfaceRaised: '#1E2330',
  surfaceLight: '#262D3D',
  border: '#252A3A',
  borderLight: '#32384C',

  text: '#F3F4F6',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',

  primary: '#38BDF8', // Soft Sky-Blue
  primaryMuted: 'rgba(56, 189, 248, 0.15)',
  primaryDark: '#0284C7',

  success: '#10B981',
  successMuted: 'rgba(16, 185, 129, 0.15)',

  warning: '#F59E0B',
  warningMuted: 'rgba(245, 158, 11, 0.15)',

  danger: '#EF4444',
  dangerMuted: 'rgba(239, 68, 68, 0.15)',
};

export type ReaderThemeMode = 'dark' | 'sepia' | 'light';

export const ReaderThemes: Record<
  ReaderThemeMode,
  {
    name: string;
    background: string;
    surface: string;
    border: string;
    text: string;
    textSecondary: string;
    accent: string;
  }
> = {
  dark: {
    name: 'Dark',
    background: '#0D0F14',
    surface: '#161922',
    border: '#252A3A',
    text: '#E5E7EB',
    textSecondary: '#9CA3AF',
    accent: '#38BDF8',
  },
  sepia: {
    name: 'Sepia',
    background: '#F4ECD8',
    surface: '#EAE1CC',
    border: '#D8CEB6',
    text: '#433422',
    textSecondary: '#7A6248',
    accent: '#B45309',
  },
  light: {
    name: 'Paper Light',
    background: '#FAF8F5',
    surface: '#FFFFFF',
    border: '#E5E7EB',
    text: '#1F2937',
    textSecondary: '#6B7280',
    accent: '#0284C7',
  },
};
