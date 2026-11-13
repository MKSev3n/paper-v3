# Paper - Expo Router TypeScript reader

Complete Expo Router project (SDK 58). Files preserved from the original archive:
library screen (app/index.tsx), reader screen (app/reader/[id].tsx),
sample novels (data/novels.ts), settings/scroll storage (utils/storage.ts).

## Run on your Android phone (no PC)

1. Install the free **Expo Go** app from the Play Store.
2. On Replit/Codespaces: unzip this zip, then run `npm install` then `npx expo start`.
3. Scan the QR code with Expo Go. Your phone and the workspace must be on the
   same network (or use `npx expo start --tunnel` for a public link).

## Notes

- Entry is `expo-router/entry` (package.json "main"). babel.config.js uses
  `babel-preset-expo` (installed as devDependency) for expo-router transforms.
- app.json: scheme `paper`, android package `com.paper.reader`, dark UI.
- Verify with `npm run typecheck` and `npx expo export --platform android`.
- To export a standalone APK later, use EAS Build: `npx eas build --platform android`.

## Backend plan

You planned to use an **Incrawl** backend as the live API for Paper. This build
does not call any Incrawl endpoints yet (no docs/credentials provided). Once you
have the base URL, auth approach and endpoint docs, add them in `lib/api.ts` and
swap `data/novels.ts` for fetched data; the reader screens already accept the
same Novel shape.
