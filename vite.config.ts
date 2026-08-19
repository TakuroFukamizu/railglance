import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'path';
import { sentryVitePlugin } from '@sentry/vite-plugin';

// The Even Hub package manifest is the version testers actually install, so the
// on-screen stamp reads from app.json rather than package.json.
const appManifest = JSON.parse(readFileSync(path.resolve(__dirname, './app.json'), 'utf8')) as {
  version?: string;
};
const buildTimeIso = new Date().toISOString();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const sentryUploadEnabled = Boolean(
    env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT && env.VITE_APP_RELEASE
  );

  return {
    plugins: sentryUploadEnabled
      ? [
          sentryVitePlugin({
            org: env.SENTRY_ORG,
            project: env.SENTRY_PROJECT,
            authToken: env.SENTRY_AUTH_TOKEN,
            release: { name: env.VITE_APP_RELEASE },
            sourcemaps: {
              assets: './dist/assets/**',
              filesToDeleteAfterUpload: './dist/**/*.map',
            },
            telemetry: false,
          }),
        ]
      : [],
    define: {
      // Empty rather than a placeholder: build-info.ts owns the user-facing fallback.
      __APP_VERSION__: JSON.stringify(appManifest.version ?? ''),
      __BUILD_TIME__: JSON.stringify(buildTimeIso),
    },
    build: {
      sourcemap: sentryUploadEnabled ? 'hidden' : false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      host: true,
      allowedHosts: true, // Allow ngrok and external hosts (Vite 6 security option)
    },
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./tests/setup.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    },
  };
});
