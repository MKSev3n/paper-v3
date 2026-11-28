/**
 * Hidden-WebView chapter loader.
 *
 * Some sources (e.g. ReadNovelFull behind Cloudflare) return a JS challenge to
 * plain HTTP clients but render real content in a real browser. As a last-resort
 * fallback, a hidden <WebView> loads the chapter URL, waits for the content
 * element (#chr-content), and posts the rendered HTML back here.
 *
 * The actual WebView is mounted once in the root layout and registers its handler
 * via `registerWebViewChapterHandler`. On platforms without a WebView (web), no
 * handler is registered and requests reject cleanly.
 */

export type WebViewChapterHandler = (
  url: string,
  timeoutMs: number
) => Promise<string>;

let handler: WebViewChapterHandler | null = null;

export function registerWebViewChapterHandler(
  next: WebViewChapterHandler | null
): void {
  handler = next;
}

export function isWebViewChapterLoaderAvailable(): boolean {
  return handler !== null;
}

/**
 * Load a chapter URL in the hidden WebView and resolve with the rendered HTML of
 * the content element. Rejects on timeout or if no WebView is available.
 */
export async function loadChapterHtmlViaWebView(
  url: string,
  timeoutMs = 35000
): Promise<string> {
  if (!handler) {
    throw new Error('WebView chapter loader is unavailable on this platform.');
  }
  return handler(url, timeoutMs);
}