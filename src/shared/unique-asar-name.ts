/**
 * Packaged app archive name (UUID). Built by scripts/rename-asar.js;
 * keep in sync with UNIQUE_ASAR_NAME there.
 */
export const UNIQUE_ASAR_NAME = '7f3a9c2e-4b1d-4e8a-9f06-2c5d8e1a0b47.asar'

/**
 * Offline video manifest SQLite DB on disk (UUID basename). Used by hls-offline
 * and the drive scanner's duplicate-copy check. Sealed blob lives inside the DB.
 */
export const UNIQUE_MANIFEST_NAME = 'c8e2b4a1-6f3d-4c9a-b715-9e0a3d7f2c48.db'

/**
 * Encrypted app-configuration blob in userData (UUID basename, no obvious name).
 * Written on login from GET /app-configurations; read whenever HLS/scan needs it.
 */
export const UNIQUE_APP_CONFIG_NAME = 'f6c2a81d-4e9b-47c0-b315-8d0a2e7f1c64'

/**
 * Marker in userData after a video tamper wipe. Presence blocks offline login
 * until the next successful online login.
 */
export const UNIQUE_TAMPER_LOCK_NAME = 'e4b7c1a9-2d8f-4a6e-9c03-7f1b5d0e8a26'
