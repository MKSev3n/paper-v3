/**
 * Paper Light Novel Reader - Configuration
 * Change the LNCRAWL_API_BASE here to point to any LNCrawl-compatible backend.
 */

export const API_URL = 'https://lightnovel-crawler-vit0.onrender.com';
export const API_EMAIL = 'admin';
export const API_PASSWORD = 'admin';

export const LNCRAWL_API_BASE = API_URL;

export const APP_CONFIG = {
  name: 'Paper',
  version: '2.10.0',
  firstRequestTimeoutMs: 60000,
  defaultTimeoutMs: 45000,
  searchPollIntervalMs: 2000,
  searchTimeoutMs: 120000,
  maxConcurrentDownloads: 3,
};
