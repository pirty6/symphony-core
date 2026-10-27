/**
 * Vite plugin that mounts the studio API on the dev server.
 * api.ts is loaded through Vite's SSR loader so it can import the
 * TypeScript core directly (no build step).
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import type { Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../../..')

type Api = { handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean> }

export function symphonyPlugin(): Plugin {
  return {
    name: 'symphony-api',
    configureServer(server) {
      loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true })
      // src/ lives outside the Vite root: watch it, and rebuild the API when the core,
      // runtime or patterns change. Live runs are kept in a shared table.
      const src = resolve(REPO_ROOT, 'src')
      server.watcher.add(src)
      const runs = new Map()
      let api: Promise<Api> | undefined
      const reload = (file: string) => {
        if (file.startsWith(src) || file.startsWith(here)) api = undefined
      }
      server.watcher.on('change', reload)
      server.watcher.on('add', reload)
      server.watcher.on('unlink', reload)
      const load = () =>
        (api ??= server.ssrLoadModule(resolve(here, 'api.ts')).then((mod) =>
          (mod as typeof import('./api.ts')).createApi({
            repoRoot: REPO_ROOT,
            workspace: process.env.SYMPHONY_WORKSPACE ?? REPO_ROOT,
            importer: (file) => server.ssrLoadModule(file),
            scriptedDelayMs: Number(process.env.SYMPHONY_DEMO_DELAY_MS ?? 25),
            runs,
          }),
        ))
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()
        load()
          .then((a) => a.handle(req, res))
          .then((handled) => {
            if (!handled) next()
          })
          .catch(next)
      })
    },
  }
}
