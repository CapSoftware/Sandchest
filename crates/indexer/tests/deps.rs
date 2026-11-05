//! The dependency inventory reads installed versions from the lockfile a
//! workspace actually uses, wherever it sits, never a manifest's range.

use std::path::PathBuf;

use sandchest_indexer::deps::{Dep, Reachability};
use sandchest_indexer::files::Store;
use sandchest_indexer::index::Index;

struct Tree(PathBuf);

impl Tree {
    fn new(name: &str) -> Tree {
        let dir = std::env::temp_dir().join(format!("sandchest-deps-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Tree(dir)
    }

    fn write(&self, path: &str, contents: &str) {
        let full = self.0.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, contents).unwrap();
    }

    fn deps(&self) -> Vec<Dep> {
        Index::build(&Store::load(&self.0)).deps
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn versions(deps: &[Dep], name: &str) -> Vec<String> {
    let mut found: Vec<String> = deps.iter().filter(|d| d.name == name).map(|d| d.version.clone()).collect();
    found.sort();
    found
}

#[test]
fn a_workspace_package_takes_versions_from_the_root_lockfile() {
    let tree = Tree::new("pnpm-workspace");
    tree.write("package.json", r#"{ "name": "root", "devDependencies": { "turbo": "^2.0.0" } }"#);
    tree.write("apps/web/package.json", r#"{ "dependencies": { "next": "^15.0.0" }, "devDependencies": { "vitest": "^3.0.0" } }"#);
    tree.write(
        "pnpm-lock.yaml",
        "lockfileVersion: '9.0'\n\npackages:\n\n  next@15.5.3:\n    resolution: {integrity: sha512-x}\n\n  vitest@3.2.1:\n    resolution: {integrity: sha512-y}\n\n  turbo@2.5.0:\n    resolution: {integrity: sha512-z}\n\n  react@19.1.0:\n    resolution: {integrity: sha512-r}\n",
    );
    tree.write("apps/web/app/page.tsx", "import Link from \"next/link\";\nexport default function Page() { return null }\n");

    let deps = tree.deps();
    // Not 15.0.0, the floor of the workspace manifest's range.
    assert_eq!(versions(&deps, "next"), vec!["15.5.3"]);
    let next = deps.iter().find(|d| d.name == "next").unwrap();
    assert!(next.direct && !next.dev);
    assert_eq!(next.reachability, Reachability::Imported);
    assert_eq!(next.manifest, "pnpm-lock.yaml");
    // Declared only as a dev dependency anywhere in the workspace.
    assert!(deps.iter().find(|d| d.name == "vitest").unwrap().dev);
    assert!(deps.iter().find(|d| d.name == "turbo").unwrap().dev);
    // Pulled in by another package: neither direct nor dev.
    let react = deps.iter().find(|d| d.name == "react").unwrap();
    assert!(!react.direct && !react.dev);
}

fn imported_at(deps: &[Dep], name: &str, version: &str) -> Vec<String> {
    deps.iter().find(|d| d.name == name && d.version == version).map(|d| d.imported_at.clone()).unwrap_or_default()
}

#[test]
fn an_import_counts_for_the_version_its_workspace_resolves_in_bun_lock() {
    let tree = Tree::new("bun-versions");
    tree.write("package.json", r#"{ "name": "root", "workspaces": ["apps/*"] }"#);
    tree.write("apps/web/package.json", r#"{ "name": "@acme/web", "dependencies": { "zod": "^3.25.0" } }"#);
    tree.write("apps/desktop/package.json", r#"{ "name": "@acme/desktop", "dependencies": { "zod": "^4.1.0" } }"#);
    tree.write(
        "bun.lock",
        r#"{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "apps/web": { "name": "@acme/web", "dependencies": { "zod": "^3.25.0" } },
    "apps/desktop": { "name": "@acme/desktop", "dependencies": { "zod": "^4.1.0" } },
  },
  "packages": {
    "zod": ["zod@3.25.76", "", {}, "sha512-a"],
    "@acme/desktop/zod": ["zod@4.1.11", "", {}, "sha512-b"],
    "some-lib/zod": ["zod@3.22.3", "", {}, "sha512-c"],
  },
}"#,
    );
    tree.write("apps/web/src/form.ts", "import { z } from \"zod\";\n");
    tree.write("apps/desktop/src/auth.ts", "import { z } from \"zod\";\n");

    let deps = tree.deps();
    assert_eq!(imported_at(&deps, "zod", "3.25.76"), vec!["apps/web/src/form.ts:1"]);
    assert_eq!(imported_at(&deps, "zod", "4.1.11"), vec!["apps/desktop/src/auth.ts:1"]);
    // Another package's private copy: installed, imported by none of this code.
    let nested = deps.iter().find(|d| d.name == "zod" && d.version == "3.22.3").unwrap();
    assert_eq!(nested.reachability, Reachability::NotImported);
    assert!(!nested.direct);
}

#[test]
fn an_import_counts_for_the_version_its_pnpm_importer_resolves() {
    let tree = Tree::new("pnpm-versions");
    tree.write("package.json", r#"{ "name": "root" }"#);
    tree.write("apps/web/package.json", r#"{ "dependencies": { "uuid": "^9.0.0", "@scope/kit": "^1.0.0" } }"#);
    tree.write("apps/api/package.json", r#"{ "dependencies": { "uuid": "^8.3.0" } }"#);
    tree.write(
        "pnpm-lock.yaml",
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api:\n    dependencies:\n      uuid:\n        specifier: ^8.3.0\n        version: 8.3.2\n\n  apps/web:\n    dependencies:\n      '@scope/kit':\n        specifier: ^1.0.0\n        version: 1.2.0(react@19.0.0)\n      uuid:\n        specifier: ^9.0.0\n        version: 9.0.1\n\npackages:\n\n  uuid@8.3.2:\n    resolution: {integrity: sha512-a}\n\n  uuid@9.0.1:\n    resolution: {integrity: sha512-b}\n\n  '@scope/kit@1.2.0':\n    resolution: {integrity: sha512-c}\n",
    );
    tree.write("apps/web/lib/ids.ts", "import { v4 } from \"uuid\";\nimport kit from \"@scope/kit\";\n");
    tree.write("apps/api/src/ids.ts", "import { v4 } from \"uuid\";\n");

    let deps = tree.deps();
    assert_eq!(imported_at(&deps, "uuid", "9.0.1"), vec!["apps/web/lib/ids.ts:1"]);
    assert_eq!(imported_at(&deps, "uuid", "8.3.2"), vec!["apps/api/src/ids.ts:1"]);
    assert_eq!(imported_at(&deps, "@scope/kit", "1.2.0"), vec!["apps/web/lib/ids.ts:2"]);
}

#[test]
fn an_import_counts_for_the_version_its_package_lock_workspace_installs() {
    let tree = Tree::new("npm-versions");
    tree.write("package.json", r#"{ "name": "root", "workspaces": ["apps/*"], "dependencies": { "semver": "^7.0.0" } }"#);
    tree.write("apps/old/package.json", r#"{ "dependencies": { "semver": "^5.0.0" } }"#);
    tree.write(
        "package-lock.json",
        r#"{ "lockfileVersion": 3, "packages": {
            "": { "name": "root" },
            "node_modules/semver": { "version": "7.6.0" },
            "apps/old/node_modules/semver": { "version": "5.7.1" },
            "node_modules/tool/node_modules/semver": { "version": "6.3.0" }
        } }"#,
    );
    tree.write("src/index.js", "const semver = require(\"semver\");\n");
    tree.write("apps/old/index.js", "const semver = require(\"semver\");\n");

    let deps = tree.deps();
    assert_eq!(imported_at(&deps, "semver", "7.6.0"), vec!["src/index.js:1"]);
    assert_eq!(imported_at(&deps, "semver", "5.7.1"), vec!["apps/old/index.js:1"]);
    assert!(imported_at(&deps, "semver", "6.3.0").is_empty());
}

#[test]
fn bun_lock_is_read_and_a_binary_bun_lockb_still_hides_ranges() {
    let tree = Tree::new("bun");
    tree.write("package.json", r#"{ "workspaces": ["packages/*"], "dependencies": { "hono": "^4.0.0" } }"#);
    tree.write("packages/api/package.json", r#"{ "dependencies": { "zod": "^3.0.0" } }"#);
    tree.write(
        "bun.lock",
        "{\n  \"lockfileVersion\": 1,\n  \"workspaces\": {\n    \"\": { \"dependencies\": { \"hono\": \"^4.0.0\", }, },\n  },\n  \"packages\": {\n    \"hono\": [\"hono@4.6.1\", \"\", {}, \"sha512-a\"],\n    \"zod\": [\"zod@3.24.2\", \"\", {}, \"sha512-b\"],\n  },\n}\n",
    );
    let deps = tree.deps();
    assert_eq!(versions(&deps, "hono"), vec!["4.6.1"]);
    assert_eq!(versions(&deps, "zod"), vec!["3.24.2"]);

    let binary = Tree::new("bun-binary");
    binary.write("package.json", r#"{ "dependencies": { "hono": "^4.0.0" } }"#);
    binary.write("bun.lockb", "\0binary");
    // The installed version can't be read, so none is guessed from the range.
    assert!(versions(&binary.deps(), "hono").is_empty());
}

#[test]
fn without_any_lockfile_the_range_floor_is_the_best_guess() {
    let tree = Tree::new("no-lock");
    tree.write("package.json", r#"{ "dependencies": { "express": "^4.17.1" } }"#);
    let deps = tree.deps();
    assert_eq!(versions(&deps, "express"), vec!["4.17.1"]);
    assert_eq!(deps[0].manifest, "package.json");
}

#[test]
fn a_lockfile_over_two_megabytes_is_still_read() {
    let tree = Tree::new("big-lock");
    tree.write("package.json", r#"{ "dependencies": { "lodash": "^4.17.0" } }"#);
    let mut lock =
        String::from("{\n  \"lockfileVersion\": 3,\n  \"packages\": {\n    \"node_modules/lodash\": { \"version\": \"4.17.20\" },\n");
    for i in 0..40_000 {
        lock.push_str(&format!("    \"node_modules/pkg-{i}\": {{ \"version\": \"1.0.{i}\", \"resolved\": \"https://registry.example.com/pkg-{i}/-/pkg-{i}-1.0.{i}.tgz\" }},\n"));
    }
    lock.push_str("    \"node_modules/last\": { \"version\": \"1.0.0\" }\n  }\n}\n");
    assert!(lock.len() > 2 * 1024 * 1024, "the fixture must be over the normal file cap");
    tree.write("package-lock.json", &lock);
    let deps = tree.deps();
    assert_eq!(versions(&deps, "lodash"), vec!["4.17.20"]);
    assert_eq!(versions(&deps, "pkg-39999"), vec!["1.0.39999"]);
}

#[test]
fn import_sites_are_shipped_code_and_capped_at_ten() {
    let tree = Tree::new("sites");
    tree.write("package.json", r#"{ "dependencies": { "jsonwebtoken": "9.0.0" } }"#);
    tree.write("package-lock.json", r#"{ "lockfileVersion": 3, "packages": { "node_modules/jsonwebtoken": { "version": "9.0.0" } } }"#);
    tree.write("test/a.test.js", "const jwt = require(\"jsonwebtoken\");\n");
    for i in 0..12 {
        tree.write(&format!("src/auth{i:02}.js"), "const jwt = require(\"jsonwebtoken\");\n");
    }
    let deps = tree.deps();
    let jwt = deps.iter().find(|d| d.name == "jsonwebtoken").unwrap();
    assert_eq!(jwt.imported_at.len(), 10);
    assert!(jwt.imported_at.iter().all(|site| site.starts_with("src/auth")), "{:?}", jwt.imported_at);
}
