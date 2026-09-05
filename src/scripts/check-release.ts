import { checkRelease, readReleaseFiles } from './release-check';

// CLI entrypoint for `pnpm release:check`. Deliberately has no "am I the main
// module" guard: a guard that misfires would let CI pass without checking.
const root = new URL('../../', import.meta.url).href;
const result = checkRelease(readReleaseFiles(root));
if (result.problems.length > 0) {
  for (const problem of result.problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log(`✓ ${result.release} is consistent across package.json, app.json, wrangler.toml, and .env.example`);
