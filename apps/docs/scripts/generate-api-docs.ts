import { generateFiles } from 'fumadocs-openapi';
import { spec } from '../../api/src/openapi.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(import.meta.dirname, '..', 'content', 'docs', 'api-reference');

mkdirSync(outDir, { recursive: true });

const specPath = join(outDir, 'openapi.json');
writeFileSync(specPath, JSON.stringify(spec, null, 2));

void generateFiles({
  input: [specPath],
  output: outDir,
  groupBy: 'tag',
});
