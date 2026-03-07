import { generateFiles } from 'fumadocs-openapi';
import { spec } from '../../api/src/openapi.js';
import { generateLlmsDocuments } from '../../api/src/llms.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const appRoot = join(import.meta.dirname, '..');
const outDir = join(appRoot, 'content', 'docs', 'api-reference');
const publicDir = join(appRoot, 'public');
const generatedSpecPath = join(outDir, 'openapi.json');

mkdirSync(outDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

writeFileSync(generatedSpecPath, JSON.stringify(spec, null, 2));

for (const [filename, content] of Object.entries(generateLlmsDocuments())) {
  writeFileSync(join(publicDir, filename), content);
}

process.chdir(appRoot);

void generateFiles({
  input: ['content/docs/api-reference/openapi.json'],
  output: 'content/docs/api-reference',
  groupBy: 'tag',
});
