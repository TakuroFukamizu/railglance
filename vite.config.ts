import { defineConfig, loadEnv } from 'vite';
import path from 'path';
import { sentryVitePlugin } from '@sentry/vite-plugin';

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
