import { copyFileSync, existsSync, mkdirSync } from 'fs'
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

export default defineConfig({
  main: {
    // readdirp is ESM-only, so bundle it into the CJS main output.
    plugins: [externalizeDepsPlugin({ exclude: ['readdirp'] }), copySqlAsmPlugin()],
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
