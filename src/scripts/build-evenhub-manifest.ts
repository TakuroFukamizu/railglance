import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { createPackagedManifest, type EvenHubManifest } from '../config/evenhub-manifest';

const projectDirectory = process.cwd();
const baseManifest = JSON.parse(
  await readFile(new URL('../../app.json', import.meta.url), 'utf8')
) as EvenHubManifest;
const environment = loadEnv('production', projectDirectory, '');
const packagedManifest = createPackagedManifest(baseManifest, environment);
const outputDirectory = new URL('../../dist/', import.meta.url);

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL('app.json', outputDirectory),
  `${JSON.stringify(packagedManifest, null, 2)}\n`,
  'utf8'
);
