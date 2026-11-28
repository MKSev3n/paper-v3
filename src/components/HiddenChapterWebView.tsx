/**
 * Hidden WebView used as a last-resort chapter loader.
 *
 * Mounted once (see app/_layout.tsx). It registers a handler with
 * `webviewChapterLoader`; when a chapter must be rendered by a real browser
 * (e.g. a Cloudflare JS challenge that plain HTTP cannot pass), the URL is
 * loaded here, a small script waits for the content element (#chr-content), and
 * the rendered HTML is posted back.
 *
 * This does not bypass CAPTCHAs or auth: it simply renders the page like a
 * browser and reads the content element if/when it appears.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  registerWebViewChapterHandler,
} from '../services/webviewChapterLoader';
import type { WebViewChapterHandler } from '../services/webviewChapterLoader';

interface PendingRequest {
  resolve: (html: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const INJECTED_JS = `
(function () {
  var tries = 0;
  var maxTries = 120;
  var iv = setInterval(function () {
    try {
      var el = document.getElementById('chr-content') ||
               document.querySelector('#chapter-content, .chr-c, .chapter-c');
      if (el && el.innerText && el.innerText.trim().length > 0) {
        clearInterval(iv);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ok', html: el.outerHTML }));
        return;
      }
    } catch (e) {}
    tries += 1;
    if (tries >= maxTries) {
      clearInterval(iv);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'timeout' }));
    }
  }, 300);
})();
`;

export default function HiddenChapterWebView() {
  const [uri, setUri] = useState<string | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      // No native WebView on web; leave the loader unavailable.
      registerWebViewChapterHandler(null);
      return;
    }

    const handler: WebViewChapterHandler = (url, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        if (pendingRef.current) {
          reject(new Error('WebView chapter loader is busy.'));
          return;
        }
        const timer = setTimeout(() => {
          if (pendingRef.current) {
            pendingRef.current.reject(new Error('WebView chapter load timed out.'));
            pendingRef.current = null;
          }
          setUri(null);
        }, timeoutMs);
        pendingRef.current = { resolve, reject, timer };
        setUri(url);
      });

    registerWebViewChapterHandler(handler);
    return () => registerWebViewChapterHandler(null);
  }, []);

  const handleMessage = useCallback((event: any) => {
    const pending = pendingRef.current;
    if (!pending) return;
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data?.type === 'ok' && typeof data.html === 'string' && data.html.length > 0) {
        clearTimeout(pending.timer);
        pendingRef.current = null;
        setUri(null);
        pending.resolve(data.html);
      } else if (data?.type === 'timeout') {
        clearTimeout(pending.timer);
        pendingRef.current = null;
        setUri(null);
        pending.reject(new Error('Chapter content element not found.'));
      }
    } catch {
      // Ignore malformed messages.
    }
  }, []);

  if (!uri) {
    return <View style={{ width: 0, height: 0, opacity: 0 }} pointerEvents="none" />;
  }

  return (
    <View
      style={{ width: 1, height: 1, opacity: 0.01, position: 'absolute', overflow: 'hidden' }}
      pointerEvents="none"
    >
      <WebView
        source={{ uri }}
        style={{ width: 1, height: 1, backgroundColor: 'transparent' }}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        injectedJavaScript={INJECTED_JS}
        onMessage={handleMessage}
      />
    </View>
  );
}