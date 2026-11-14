/**
 * Paper Light Novel Reader - Configuration
 * Change the LNCRAWL_API_BASE here to point to any LNCrawl-compatible backend.
 */

export const LNCRAWL_API_BASE = 'https://lightnovel-crawler-vit0.onrender.com';

export const APP_CONFIG = {
  name: 'Paper',
  version: '2.10.0',
  defaultTimeoutMs: 90000,
  maxConcurrentDownloads: 3,
};
