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

export type AppColors = {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderLight: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primaryPressed: string;
  primaryMuted: string;
  success: string;
  successMuted: string;
  warning: string;
  danger: string;
  dangerMuted: string;
};

export const lightColors: AppColors = {
  background: '#F6F1E7',
  surface: '#FCFAF4',
  surfaceRaised: '#FFFFFF',
  border: '#E3DAC6',
  borderLight: '#EFE9D9',
  text: '#2D2924',
  textSecondary: '#6F6455',
  textMuted: '#776C5D',
  primary: '#8C5A33',
  primaryPressed: '#7F502D',
  primaryMuted: 'rgba(140,90,51,0.12)',
  success: '#4F7A5B',
  successMuted: 'rgba(79,122,91,0.14)',
  warning: '#B07E2E',
  danger: '#A3493F',
  dangerMuted: 'rgba(163,73,63,0.12)',
};

export const darkColors: AppColors = {
  background: '#17140F',
  surface: '#201C16',
  surfaceRaised: '#28231B',
  border: '#332E25',
  borderLight: '#28231B',
  text: '#ECE5D6',
  textSecondary: '#A99D87',
  textMuted: '#8F846F',
  primary: '#C99B6A',
  primaryPressed: '#B88A5B',
  primaryMuted: 'rgba(201,155,106,0.16)',
  success: '#7FAF8B',
  successMuted: 'rgba(127,175,139,0.16)',
  warning: '#D2A24C',
  danger: '#D9776C',
  dangerMuted: 'rgba(217,119,108,0.16)',
};

export type ReaderThemeMode = 'dark' | 'sepia' | 'light';

export const ReaderThemes: Record<
  ReaderThemeMode,
  {
    name: string;
    background: string;
    surface: string;
    surfaceRaised: string;
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
    surfaceRaised: '#1E2330',
    border: '#252A3A',
    text: '#E5E7EB',
    textSecondary: '#9CA3AF',
    accent: '#38BDF8',
  },
  sepia: {
    name: 'Sepia',
    background: '#F4ECD8',
    surface: '#EAE1CC',
    surfaceRaised: '#E0D5BC',
    border: '#D8CEB6',
    text: '#433422',
    textSecondary: '#7A6248',
    accent: '#B45309',
  },
  light: {
    name: 'Paper Light',
    background: '#FAF8F5',
    surface: '#FFFFFF',
    surfaceRaised: '#F1F2F4',
    border: '#E5E7EB',
    text: '#1F2937',
    textSecondary: '#6B7280',
    accent: '#0284C7',
  },
};
