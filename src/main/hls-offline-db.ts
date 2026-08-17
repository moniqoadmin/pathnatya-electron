import { existsSync, promises as fs } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import type { Database, SqlJsStatic } from 'sql.js'
import { UNIQUE_ASAR_NAME } from '../shared/unique-asar-name'
import { decryptAtRest, encryptAtRest } from './hls-offline-crypto'

const MANIFEST_KEY = 'manifest'
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS package (
  key TEXT PRIMARY KEY NOT NULL,
  value BLOB NOT NULL
)`

let sqlPromise: Promise<SqlJsStatic> | null = null

function moduleDir(): string {
  return typeof __dirname === 'string' && __dirname ? __dirname : process.cwd()
}

/**
 * sql-asm lives next to the compiled main process, in the unique asar, or in
 * the project node_modules (tests / unpackaged). Never use app.getAppPath():
 * the integrity launcher asar does not contain sql.js.
 */
function sqlAsmCandidates(): string[] {
  const dir = moduleDir()
  const paths = [
    join(dir, 'vendor', 'sql-asm.js'),
    join(dir, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-asm.js'),
    join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-asm.js')
  ]

  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  if (resourcesPath) {
    paths.push(
      join(resourcesPath, UNIQUE_ASAR_NAME, 'dist', 'main', 'vendor', 'sql-asm.js'),
      join(resourcesPath, UNIQUE_ASAR_NAME, 'node_modules', 'sql.js', 'dist', 'sql-asm.js')
    )
  }

  return paths
}

function loadSqlAsm(): (config?: object) => Promise<SqlJsStatic> {
  for (const filePath of sqlAsmCandidates()) {
    if (!existsSync(filePath)) {
      continue
    }

    return createRequire(filePath)(filePath) as (config?: object) => Promise<SqlJsStatic>
  }

  return createRequire(join(process.cwd(), 'package.json'))('sql.js/dist/sql-asm.js') as (
    config?: object
  ) => Promise<SqlJsStatic>
}

/** Load sql.js asm build (no separate .wasm file to pack or locate). */
async function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      try {
        const initSqlJs = loadSqlAsm()
        return await initSqlJs()
      } catch (error) {
        sqlPromise = null
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`4827 : Video storage engine could not be loaded. ${detail}`.trim())
      }
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
