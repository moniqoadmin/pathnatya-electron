import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** Copy sql.js asm into dist so packaged apps do not resolve it via app.getAppPath(). */
function copySqlAsmPlugin(): Plugin {
  return {
    name: 'copy-sql-asm',
    closeBundle() {
      const source = resolve('node_modules/sql.js/dist/sql-asm.js')
      if (!existsSync(source)) {
        throw new Error(`copy-sql-asm: missing ${source}`)
      }

      const destDir = resolve('dist/main/vendor')
      mkdirSync(destDir, { recursive: true })
      copyFileSync(source, join(destDir, 'sql-asm.js'))
    }
  }
}

/** macOS-only native module used to show Music / Photo Library prompts from this process. */
function copyMacPermissionsPlugin(): Plugin {
  return {
    name: 'copy-mac-permissions',
    closeBundle() {
      if (process.platform !== 'darwin') {
        return
      }

      const source = resolve('node_modules/node-mac-permissions')
      if (!existsSync(source)) {
        return
      }

      const dest = resolve('dist/main/vendor/node-mac-permissions')
      mkdirSync(resolve('dist/main/vendor'), { recursive: true })
      cpSync(source, dest, { recursive: true })

      for (const extra of ['bindings', 'file-uri-to-path']) {
        const extraSrc = resolve('node_modules', extra)
        if (!existsSync(extraSrc)) {
          continue
        }
        cpSync(extraSrc, join(dest, 'node_modules', extra), { recursive: true })
      }
    }
  }
}

export default defineConfig({
  main: {
    // readdirp is ESM-only, so bundle it into the CJS main output.
    plugins: [externalizeDepsPlugin({ exclude: ['readdirp'] }), copySqlAsmPlugin(), copyMacPermissionsPlugin()],
    build: {
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: 'esbuild',
      sourcemap: false
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: undefined
        }
      }
    }
  }
})
