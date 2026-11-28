import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { lightColors, darkColors, AppColors } from './colors';
import { getReaderSettings, saveReaderSettings } from '../services/storage';

export type ThemeMode = 'light' | 'dark' | 'system';

type ThemeContextValue = {
  mode: ThemeMode;
  scheme: 'light' | 'dark';
  colors: AppColors;
  setMode: (m: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  scheme: 'light',
  colors: lightColors,
  setMode: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await getReaderSettings();
        const m = (s as any).appThemeMode;
        if (m === 'light' || m === 'dark' || m === 'system') setModeState(m);
      } catch {}
      setLoaded(true);
    })();
  }, []);

  const scheme: 'light' | 'dark' =
    mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;

  const colors = scheme === 'dark' ? darkColors : lightColors;

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    getReaderSettings().then((s) => saveReaderSettings({ ...s, appThemeMode: m } as any));
  };

  if (!loaded) return null;

  return (
    <ThemeContext.Provider value={{ mode, scheme, colors, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useAppTheme() {
  return useContext(ThemeContext);
}

// makeStyles pattern example:
// const styles = useMemo(() => createStyles(colors), [colors]);
