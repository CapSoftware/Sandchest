/**
 * On-disk cache of classifier answers, in the eval data. Benchmarks are pinned
 * to commits, so the same code is classified the same way on every run: after
 * the first run, entry-point recovery costs nothing and no longer varies
 * between runs. A changed question, model or piece of code is a new key.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cachedClassifier, type Classifier, type ClassifierCache, type ClassifierResult } from "@sandchest/engine";
import { DATA_DIR } from "./data";

export const CLASSIFIER_CACHE_DIR = join(DATA_DIR, "cache", "classifier");

export function fileCache(dir = CLASSIFIER_CACHE_DIR): ClassifierCache {
  const path = (key: string) => join(dir, key.slice(0, 2), `${key}.json`);
  return {
    async get(key) {
      const text = await readFile(path(key), "utf8").catch(() => undefined);
      return text ? (JSON.parse(text) as ClassifierResult) : undefined;
    },
    async set(key, result) {
      await mkdir(join(dir, key.slice(0, 2)), { recursive: true });
      await writeFile(path(key), JSON.stringify(result));
    },
  };
}

/** The classifier behind the on-disk cache, or `undefined` when none is configured. */
export function evalClassifier(inner: Classifier | undefined) {
  return inner ? cachedClassifier(inner, fileCache()) : undefined;
}
