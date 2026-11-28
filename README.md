# Paper - Light Novel Reader

A React Native (Expo) light novel reader for Android with offline downloads, built-in reader and reading progress. Version 3.0.0.

## Stack

- Expo SDK ~52.0.37, React Native 0.76.9, React 18.3.1, expo-router 4.0 (file-based routing)
- TypeScript, SQLite via expo-sqlite, file storage via expo-file-system
- Android package: `com.mksev3n.paper` (app.json), scheme `paper`, dark UI, versionCode 3

## Features

- **Discover / Search**: browse live catalog and paste a novel URL to add directly
- **Direct sources (scraped client-side, no backend needed)**: ReadNovelFull, NovelFull, NovelBin (`src/sources/readnovelfull.ts`, `src/sources/index.ts`)
- **Backend catalog**: Incrawl / LNCrawl-compatible API at `https://lightnovel-crawler-vit0.onrender.com` (set in `src/config.ts` as `LNCRAWL_API_BASE` / `API_URL`, change it to point at any LNCrawl-compatible backend)
- **Offline downloads**: chapter text stored in a local SQLite database (expo-sqlite), readable fully offline in the built-in reader with local reading progress (`src/services/database.ts`, `src/services/downloadManager.ts`)
- **Local storage**: novels, chapters and reading progress in SQLite; covers and exports kept in the app-private document directory, never in public Downloads (`src/services/fileStorage.ts`)
- **Reader**: built-in reader screen with scroll progress tracking (`app/reader/[id].tsx`)
- **Screens**: Discover, Library, Downloads, Settings tabs (`app/(tabs)/`), novel detail (`app/novel/[id].tsx`), reader (`app/reader/[id].tsx`)

## Run

1. Install dependencies: `npm install` (or `npm ci` for a clean install)
2. Start dev server: `npm start` (runs on port 3000) or `npm run android`
3. On a phone: install the free **Expo Go** app, scan the QR code from `npx expo start`. Phone and dev machine must be on the same network, or use a tunnel (`npx expo start --tunnel`) for a public link.
4. Verify: `npm run typecheck` (runs `tsc --noEmit`)

## Build Android APK

Use EAS Build: `npx eas build --platform android`. The EAS project is configured in `app.json` (`extra.eas.projectId`). A standalone app.json export bundle can be generated with `npx expo export --platform android`.

## Project layout

- `app/` - expo-router screens (tabs, novel detail, reader)
- `src/config.ts` - backend URL and app config
- `src/sources/` - direct source scrapers (ReadNovelFull, NovelFull, NovelBin)
- `src/services/` - SQLite database, download manager, file storage, LNCrawl client
- `assets/` - icons and splash
