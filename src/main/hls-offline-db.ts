import { existsSync, promises as fs } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import type { Database, SqlJsStatic } from 'sql.js'
import { decryptAtRest, encryptAtRest } from './hls-offline-crypto'

const MANIFEST_KEY = 'manifest'
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS package (
  key TEXT PRIMARY KEY NOT NULL,
  value BLOB NOT NULL
)`

let sqlPromise: Promise<SqlJsStatic> | null = null

function nodeRequire(): NodeRequire {
  try {
    // Lazy so vitest can mock electron before first use.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    if (typeof electron.app?.getAppPath === 'function') {
      return createRequire(join(electron.app.getAppPath(), 'package.json'))
    }
  } catch {
    // Not running under Electron yet (tests / early boot).
  }
  return createRequire(join(process.cwd(), 'package.json'))
}

/** Load sql.js asm build (no separate .wasm file to pack or locate). */
async function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const initSqlJs = nodeRequire()('sql.js/dist/sql-asm.js') as (
        config?: object
      ) => Promise<SqlJsStatic>
      return initSqlJs()
    })()
  }
  return sqlPromise
}

function openDb(SQL: SqlJsStatic, fileBytes: Uint8Array | null): Database {
  const db = fileBytes ? new SQL.Database(fileBytes) : new SQL.Database()
  db.run(TABLE_SQL)
  return db
}

/**
 * Read the on-disk sealed DB, decrypt in memory only, return SQLite bytes.
 * Never writes plaintext SQLite back to disk.
 */
async function loadDecryptedDbBytes(dbPath: string): Promise<Uint8Array | null> {
  if (!existsSync(dbPath)) {
    return null
  }
  const sealed = await fs.readFile(dbPath)
  const plaintext = await decryptAtRest(sealed)
  return new Uint8Array(plaintext)
}

/** Persist an in-memory SQLite export as an at-rest sealed blob on disk. */
async function persistEncryptedDb(dbPath: string, sqliteBytes: Buffer): Promise<void> {
  const sealed = await encryptAtRest(sqliteBytes)
  await fs.writeFile(dbPath, sealed)
}

function blobFromSqlValue(value: unknown): Buffer | null {
  if (value == null) {
    return null
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  if (Array.isArray(value)) {
    return Buffer.from(value as number[])
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'binary')
  }
  return null
}

/** Read the sealed offline-manifest blob from the encrypted UUID SQLite file. */
export async function readSealedManifestBlob(dbPath: string): Promise<Buffer | null> {
  const fileBytes = await loadDecryptedDbBytes(dbPath)
  if (!fileBytes) {
    return null
  }

  const SQL = await getSql()
  const db = openDb(SQL, fileBytes)
  try {
    const stmt = db.prepare('SELECT value FROM package WHERE key = ? LIMIT 1')
    try {
      stmt.bind([MANIFEST_KEY])
      if (!stmt.step()) {
        return null
      }
      const row = stmt.getAsObject() as { value?: unknown }
      return blobFromSqlValue(row.value)
    } finally {
      stmt.free()
    }
  } finally {
    db.close()
  }
}

/** Write / replace the sealed offline-manifest blob; DB file is encrypted at rest. */
export async function writeSealedManifestBlob(dbPath: string, sealed: Buffer): Promise<void> {
  const SQL = await getSql()
  const existing = await loadDecryptedDbBytes(dbPath)
  const db = openDb(SQL, existing)
  try {
    db.run('INSERT OR REPLACE INTO package (key, value) VALUES (?, ?)', [MANIFEST_KEY, sealed])
    await persistEncryptedDb(dbPath, Buffer.from(db.export()))
  } finally {
    db.close()
  }
}
