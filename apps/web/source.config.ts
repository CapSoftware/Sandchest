/**
 * The docs and legal pages: MDX in `content/`, compiled at build time by
 * Fumadocs. Code is highlighted here too, so pages ship no highlighter.
 */
import { pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import type { Plugin } from "fumadocs-mdx";
import indexFile from "fumadocs-mdx/plugins/index-file";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Each page's Markdown, for "Copy as Markdown", /docs/<page>.md and llms-full.txt.
    postprocess: { includeProcessedMarkdown: { headingIds: false } },
  },
});

export const legal = defineCollections({
  type: "doc",
  dir: "content/legal",
  schema: pageSchema,
});

/** Code colours from the site's palette: gold in the dark. */
const sandchest = {
  name: "sandchest",
  type: "dark" as const,
  colors: { "editor.background": "#15100b", "editor.foreground": "#f3e5c8" },
  settings: [
    { settings: { foreground: "#f3e5c8" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#a69479" } },
    { scope: ["keyword", "storage", "keyword.operator.new", "keyword.control"], settings: { foreground: "#fec242" } },
    { scope: ["string", "string.quoted", "markup.inline.raw"], settings: { foreground: "#fdd363" } },
    { scope: ["constant", "constant.numeric", "constant.language", "support.constant"], settings: { foreground: "#ff9f19" } },
    { scope: ["entity.name.function", "support.function", "entity.name.tag"], settings: { foreground: "#fff3dc" } },
    { scope: ["variable.parameter", "variable.other.property", "support.type.property-name", "entity.other.attribute-name"], settings: { foreground: "#c2b293" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "#c2b293" } },
    { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: "#fea121" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#fec242" } },
    { scope: ["invalid"], settings: { foreground: "#d76839" } },
  ],
};

/**
 * Fumadocs' generated index awaits each collection at the top level. One
 * top-level await anywhere makes Turbopack ship its async-module runtime to
 * every page in the app (about 0.5 KB gzipped on the landing page and the
 * dashboard too). This emits the same index as `.source/collections.ts`,
 * exporting promises instead, which `src/lib/docs.ts` awaits inside functions.
 * next.config.ts turns the default index off.
 */
function indexWithoutTopLevelAwait(): Plugin {
  const inner = indexFile({ browser: false, dynamic: false });
  return {
    // The same name, so the dev server's "regenerate the index" still reaches it.
    name: "index-file",
    config(config) {
      return inner.config?.call(this, config);
    },
    configureServer(server) {
      return inner.configureServer?.call(this, server);
    },
    async emit() {
      const [entry] = await inner.emit!.call(this);
      const content = entry!.content.replaceAll("= await create.", "= create.");
      if (/\bawait\b/.test(content)) throw new Error("fumadocs-mdx's generated index changed shape: update indexWithoutTopLevelAwait in source.config.ts.");
      return [{ path: "collections.ts", content }];
    },
  };
}

export default defineConfig({
  plugins: [indexWithoutTopLevelAwait()],
  mdxOptions: {
    rehypeCodeOptions: {
      themes: { light: sandchest, dark: sandchest },
      defaultColor: "dark",
      icon: false,
    },
  },
});
