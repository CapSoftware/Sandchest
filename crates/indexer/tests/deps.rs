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
fn bun_lock_is_read_and_a_binary_bun_lockb_falls_back_to_marked_ranges() {
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
    // The installed version can't be read: the range's floor is reported, marked as a guess.
    let guessed = binary.deps();
    assert_eq!(versions(&guessed, "hono"), vec!["4.0.0"]);
    assert!(guessed[0].approximate);
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

#[test]
fn a_nested_project_with_its_own_yarn_lock_keeps_its_own_versions() {
    let tree = Tree::new("yarn-nested");
    tree.write("package.json", r#"{ "dependencies": { "react": "^18.2.0" } }"#);
    tree.write("yarn.lock", "react@^18.2.0:\n  version \"18.2.0\"\n");
    tree.write("website/package.json", r#"{ "dependencies": { "react": "^18.2.0" } }"#);
    tree.write("website/yarn.lock", "react@^18.2.0:\n  version \"18.3.1\"\n");
    tree.write("src/app.js", "const React = require(\"react\");\n");
    tree.write("website/src/page.js", "const React = require(\"react\");\n");

    let deps = tree.deps();
    assert_eq!(imported_at(&deps, "react", "18.2.0"), vec!["src/app.js:1"]);
    assert_eq!(imported_at(&deps, "react", "18.3.1"), vec!["website/src/page.js:1"]);
}

/// `(name, version, imported at)` for each dependency of an ecosystem, sorted.
fn found(deps: &[Dep], ecosystem: &str) -> Vec<(String, String, Vec<String>)> {
    let mut out: Vec<_> =
        deps.iter().filter(|d| d.ecosystem == ecosystem).map(|d| (d.name.clone(), d.version.clone(), d.imported_at.clone())).collect();
    out.sort();
    out
}

fn reach(deps: &[Dep], name: &str) -> Reachability {
    deps.iter().find(|d| d.name == name).unwrap().reachability
}

#[test]
fn dotnet_lockfile_project_files_and_using_directives() {
    let tree = Tree::new("dotnet");
    tree.write(
        "src/Api/packages.lock.json",
        r#"{ "version": 1, "dependencies": { "net8.0": {
            "Newtonsoft.Json": { "type": "Direct", "requested": "[13.0.1, )", "resolved": "13.0.1" },
            "System.Text.Encodings.Web": { "type": "Transitive", "resolved": "4.7.2" },
            "Acme.Shared": { "type": "Project" } } } }"#,
    );
    tree.write("src/Api/Api.csproj", r#"<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.1" /></ItemGroup></Project>"#);
    tree.write("src/Worker/Worker.csproj", r#"<Project><ItemGroup><PackageReference Include="Serilog" Version="[2.10.0,3.0)" /><PackageReference Include="Dapper"><Version>2.1.24</Version></PackageReference></ItemGroup></Project>"#);
    tree.write("src/Api/Program.cs", "using System;\nusing Newtonsoft.Json.Linq;\n");
    tree.write("src/Worker/Job.cs", "global using Dapper;\n");
    let deps = tree.deps();
    assert_eq!(
        found(&deps, "NuGet"),
        vec![
            ("Dapper".into(), "2.1.24".into(), vec!["src/Worker/Job.cs:1".into()]),
            ("Newtonsoft.Json".into(), "13.0.1".into(), vec!["src/Api/Program.cs:2".into()]),
            ("Serilog".into(), "2.10.0".into(), vec![]),
            ("System.Text.Encodings.Web".into(), "4.7.2".into(), vec![]),
        ]
    );
    assert!(deps.iter().find(|d| d.name == "Serilog").unwrap().approximate);
    assert!(!deps.iter().find(|d| d.name == "System.Text.Encodings.Web").unwrap().direct);
}

#[test]
fn rust_crates_by_use_and_by_path() {
    let tree = Tree::new("rust");
    tree.write(
        "Cargo.toml",
        "[package]\nname = \"app\"\n[dependencies]\nserde_json = \"1\"\ntokio = \"1\"\n[dev-dependencies]\ntempfile = \"3\"\n",
    );
    tree.write(
        "Cargo.lock",
        "[[package]]\nname = \"app\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"serde_json\"\nversion = \"1.0.100\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"tokio\"\nversion = \"1.35.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"tempfile\"\nversion = \"3.8.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"mio\"\nversion = \"0.8.10\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n",
    );
    tree.write("src/main.rs", "use serde_json::Value;\n\n#[tokio::main]\nasync fn main() {}\n");
    let deps = tree.deps();
    assert_eq!(
        found(&deps, "crates.io").iter().map(|(n, _, at)| (n.as_str(), at.len())).collect::<Vec<_>>(),
        vec![("mio", 0), ("serde_json", 1), ("tempfile", 0), ("tokio", 1)]
    );
    let tempfile = deps.iter().find(|d| d.name == "tempfile").unwrap();
    assert!(tempfile.direct && tempfile.dev);
    assert!(!deps.iter().any(|d| d.name == "app"));
}

#[test]
fn php_packages_by_their_autoload_namespaces() {
    let tree = Tree::new("php");
    tree.write(
        "composer.lock",
        r#"{ "packages": [
            { "name": "monolog/monolog", "version": "2.9.1", "autoload": { "psr-4": { "Monolog\\": "src/Monolog" } } },
            { "name": "guzzlehttp/guzzle", "version": "7.8.0", "autoload": { "psr-4": { "GuzzleHttp\\": "src/" } } }
        ], "packages-dev": [ { "name": "phpunit/phpunit", "version": "10.5.0", "autoload": { "classmap": ["src/"] } } ] }"#,
    );
    tree.write("app/Log.php", "<?php\nnamespace App;\nuse Monolog\\Logger;\n");
    let deps = tree.deps();
    assert_eq!(reach(&deps, "monolog/monolog"), Reachability::Imported);
    assert_eq!(reach(&deps, "guzzlehttp/guzzle"), Reachability::NotImported);
    assert!(deps.iter().find(|d| d.name == "phpunit/phpunit").unwrap().dev);
}

#[test]
fn rails_gems_are_used_where_bundler_requires_them() {
    let tree = Tree::new("rails");
    tree.write(
        "Gemfile",
        "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'nokogiri'\ngroup :development, :test do\n  gem 'rspec-rails'\nend\n",
    );
    tree.write(
        "Gemfile.lock",
        "GEM\n  specs:\n    rails (7.1.2)\n    nokogiri (1.15.4)\n    rspec-rails (6.1.0)\n    racc (1.7.3)\n\nDEPENDENCIES\n  rails\n",
    );
    tree.write("config/application.rb", "require_relative \"boot\"\nrequire \"rails/all\"\nBundler.require(*Rails.groups)\n");
    let deps = tree.deps();
    let nokogiri = deps.iter().find(|d| d.name == "nokogiri").unwrap();
    assert_eq!(nokogiri.imported_at, vec!["Gemfile:3"]);
    let rspec = deps.iter().find(|d| d.name == "rspec-rails").unwrap();
    assert!(rspec.dev && rspec.imported_at.is_empty());
    assert_eq!(reach(&deps, "racc"), Reachability::NotImported);
    assert!(deps.iter().find(|d| d.name == "rails").unwrap().imported_at.contains(&"config/application.rb:2".to_owned()));
}

#[test]
fn dart_elixir_julia_and_r() {
    let tree = Tree::new("more");
    tree.write("app/pubspec.lock", "packages:\n  http:\n    dependency: \"direct main\"\n    description:\n      name: http\n    source: hosted\n    version: \"1.1.0\"\n  flutter:\n    dependency: \"direct main\"\n    source: sdk\n    version: \"0.0.0\"\n  mockito:\n    dependency: \"direct dev\"\n    source: hosted\n    version: \"5.4.2\"\nsdks:\n  dart: \">=3.0.0\"\n");
    tree.write("app/lib/api.dart", "import 'package:http/http.dart' as http;\n");
    tree.write("web/mix.exs", "defp deps do\n  [{:phoenix, \"~> 1.7\"}, {:credo, \"~> 1.7\", only: [:dev, :test]}]\nend\n");
    tree.write("web/mix.lock", "%{\n  \"phoenix\": {:hex, :phoenix, \"1.7.10\", \"abc\", [:mix], [], \"hexpm\", \"def\"},\n  \"credo\": {:hex, :credo, \"1.7.1\", \"abc\", [:mix], [], \"hexpm\", \"def\"},\n}\n");
    tree.write("web/lib/web/router.ex", "defmodule Web.Router do\n  use Phoenix.Router\nend\n");
    tree.write("jl/Project.toml", "[deps]\nHTTP = \"cd3eb016-35fb-5094-929b-558a96fad6f3\"\n");
    tree.write(
        "jl/Manifest.toml",
        "manifest_format = \"2.0\"\n\n[[deps.HTTP]]\nuuid = \"cd3eb016\"\nversion = \"1.10.1\"\n\n[[deps.Base64]]\nuuid = \"2a0f44e3\"\n",
    );
    tree.write("jl/src/Client.jl", "module Client\nusing HTTP\nend\n");
    tree.write("r/renv.lock", r#"{ "R": { "Version": "4.3.1" }, "Packages": { "jsonlite": { "Package": "jsonlite", "Version": "1.8.7", "Source": "Repository", "Repository": "CRAN" }, "mypkg": { "Package": "mypkg", "Version": "0.1", "Source": "GitHub" } } }"#);
    tree.write("r/analysis.R", "x <- jsonlite::fromJSON(\"a.json\")\n");
    let deps = tree.deps();
    assert_eq!(
        found(&deps, "Pub").iter().map(|(n, v, at)| (n.as_str(), v.as_str(), at.len())).collect::<Vec<_>>(),
        vec![("http", "1.1.0", 1), ("mockito", "5.4.2", 0)]
    );
    assert!(deps.iter().find(|d| d.name == "mockito").unwrap().dev);
    assert_eq!(reach(&deps, "phoenix"), Reachability::Imported);
    assert!(deps.iter().find(|d| d.name == "credo").unwrap().dev);
    assert_eq!(found(&deps, "Julia"), vec![("HTTP".into(), "1.10.1".into(), vec!["jl/src/Client.jl:2".into()])]);
    assert_eq!(found(&deps, "CRAN"), vec![("jsonlite".into(), "1.8.7".into(), vec!["r/analysis.R:1".into()])]);
}

#[test]
fn swift_haskell_ocaml_are_read_but_their_imports_not_guessed() {
    let tree = Tree::new("untraced");
    tree.write("Package.resolved", r#"{ "pins": [ { "identity": "swift-nio", "kind": "remoteSourceControl", "location": "https://github.com/apple/swift-nio.git", "state": { "revision": "abc", "version": "2.40.0" } }, { "identity": "x", "location": "https://github.com/acme/x", "state": { "branch": "main", "revision": "def" } } ] }"#);
    tree.write("cabal.project.freeze", "active-repositories: hackage.haskell.org:merge\nconstraints: any.aeson ==2.1.2.1,\n             any.warp ==3.3.25,\n             warp +x509\n");
    tree.write("app.opam.locked", "depends: [\n  \"lwt\" {= \"5.7.0\"}\n  \"ocaml\" {= \"5.1.0\"}\n]\n");
    let deps = tree.deps();
    assert_eq!(
        found(&deps, "SwiftURL").iter().map(|(n, v, _)| (n.as_str(), v.as_str())).collect::<Vec<_>>(),
        vec![("github.com/apple/swift-nio", "2.40.0")]
    );
    assert_eq!(
        found(&deps, "Hackage").iter().map(|(n, v, _)| (n.as_str(), v.as_str())).collect::<Vec<_>>(),
        vec![("aeson", "2.1.2.1"), ("warp", "3.3.25")]
    );
    assert_eq!(found(&deps, "opam").len(), 2);
    assert!(deps.iter().all(|d| d.reachability == Reachability::Unknown));
}

#[test]
fn jvm_versions_from_parents_catalogs_and_lockfiles() {
    let tree = Tree::new("jvm");
    tree.write(
        "pom.xml",
        "<project><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version><properties><jackson.version>2.15.2</jackson.version></properties><dependencyManagement><dependencies><dependency><groupId>org.yaml</groupId><artifactId>snakeyaml</artifactId><version>1.33</version></dependency></dependencies></dependencyManagement></project>",
    );
    tree.write(
        "api/pom.xml",
        "<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent><artifactId>api</artifactId><dependencies><dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>${jackson.version}</version></dependency><dependency><groupId>org.yaml</groupId><artifactId>snakeyaml</artifactId></dependency><dependency><groupId>com.acme</groupId><artifactId>parent</artifactId><version>${project.version}</version></dependency><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies></project>",
    );
    tree.write("api/src/main/java/App.java", "import com.fasterxml.jackson.databind.ObjectMapper;\nclass App {}\n");
    tree.write("svc/gradle/libs.versions.toml", "[versions]\nokhttp = \"4.12.0\"\n[libraries]\nokhttp = { module = \"com.squareup.okhttp3:okhttp\", version.ref = \"okhttp\" }\ngson = \"com.google.code.gson:gson:2.10.1\"\n");
    tree.write("svc/gradle.lockfile", "# lockfile\ncom.squareup.okio:okio:3.6.0=compileClasspath,runtimeClasspath\norg.junit:junit-bom:5.10.0=testCompileClasspath\nempty=\n");
    tree.write("svc/src/main/kotlin/Client.kt", "import okhttp3.OkHttpClient\n");
    let deps = tree.deps();
    let maven = found(&deps, "Maven");
    let names: Vec<(&str, &str)> = maven.iter().map(|(n, v, _)| (n.as_str(), v.as_str())).collect();
    assert_eq!(
        names,
        vec![
            ("com.fasterxml.jackson.core:jackson-databind", "2.15.2"),
            ("com.google.code.gson:gson", "2.10.1"),
            ("com.squareup.okhttp3:okhttp", "4.12.0"),
            ("com.squareup.okio:okio", "3.6.0"),
            ("junit:junit", "4.13.2"),
            ("org.junit:junit-bom", "5.10.0"),
            ("org.yaml:snakeyaml", "1.33"),
        ]
    );
    assert_eq!(reach(&deps, "com.fasterxml.jackson.core:jackson-databind"), Reachability::Imported);
    // OkHttp's package is `okhttp3`, not its coordinates: no import found proves nothing, so it isn't called unused.
    assert_eq!(reach(&deps, "com.squareup.okhttp3:okhttp"), Reachability::Unknown);
    assert!(deps.iter().find(|d| d.name == "junit:junit").unwrap().dev);
    assert!(deps.iter().find(|d| d.name == "org.junit:junit-bom").unwrap().dev);
}

#[test]
fn python_pins_ranges_and_pyproject() {
    let tree = Tree::new("python");
    tree.write("requirements.txt", "flask==3.0.0\nrequests>=2.31.0\nclick\n-r other.txt\n");
    tree.write(
        "svc/pyproject.toml",
        "[project]\nname = \"svc\"\ndependencies = [\"httpx>=0.25\", \"pydantic==2.5.2\"]\n[dependency-groups]\ndev = [\"pytest>=7\"]\n",
    );
    tree.write("locked/pyproject.toml", "[project]\ndependencies = [\"django>=4\"]\n");
    tree.write("locked/uv.lock", "version = 1\n[[package]]\nname = \"django\"\nversion = \"4.2.7\"\nsource = { registry = \"https://pypi.org/simple\" }\n[[package]]\nname = \"locked\"\nversion = \"0.1.0\"\nsource = { editable = \".\" }\n");
    let deps = tree.deps();
    let pypi: Vec<(String, String, bool)> = {
        let mut v: Vec<_> =
            deps.iter().filter(|d| d.ecosystem == "PyPI").map(|d| (d.name.clone(), d.version.clone(), d.approximate)).collect();
        v.sort();
        v
    };
    assert_eq!(
        pypi,
        vec![
            ("django".into(), "4.2.7".into(), false),
            ("flask".into(), "3.0.0".into(), false),
            ("httpx".into(), "0.25".into(), true),
            ("pydantic".into(), "2.5.2".into(), false),
            ("pytest".into(), "7".into(), true),
            ("requests".into(), "2.31.0".into(), true),
        ]
    );
    assert!(deps.iter().find(|d| d.name == "pytest").unwrap().dev);
}

#[test]
fn github_actions_at_release_tags_are_used_on_their_uses_line() {
    let tree = Tree::new("actions");
    tree.write(
        ".github/workflows/ci.yml",
        "on: push\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: tj-actions/changed-files@v45.0.7\n      - name: x\n        uses: \"actions/setup-node@v4.0.2\"\n      - uses: acme/action@3f1c2a9d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a\n",
    );
    let deps = tree.deps();
    assert_eq!(
        found(&deps, "GitHub Actions"),
        vec![
            ("actions/setup-node".into(), "4.0.2".into(), vec![".github/workflows/ci.yml:8".into()]),
            ("tj-actions/changed-files".into(), "45.0.7".into(), vec![".github/workflows/ci.yml:6".into()]),
        ]
    );
}

#[test]
fn git_submodules_are_pinned_at_the_commit_the_tree_records() {
    let tree = Tree::new("submodules");
    tree.write(
        ".gitmodules",
        "[submodule \"harfbuzz\"]\n\tpath = third_party/harfbuzz\n\turl = git@github.com:harfbuzz/harfbuzz.git\n[submodule \"local\"]\n\tpath = vendor/local\n\turl = ../local.git\n",
    );
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git").arg("-C").arg(&tree.0).args(args).output().unwrap().status.success(), "git {args:?}")
    };
    git(&["init", "-q"]);
    git(&["update-index", "--add", "--cacheinfo", "160000,6879efc2c1596d11a6a6ad296f80063b558d5e0f,third_party/harfbuzz"]);
    git(&["update-index", "--add", "--cacheinfo", "160000,0123456789abcdef0123456789abcdef01234567,vendor/local"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "pin"]);
    let deps = tree.deps();
    let pinned: Vec<(String, String)> = deps.iter().filter(|d| d.ecosystem == "GIT").map(|d| (d.name.clone(), d.version.clone())).collect();
    // A relative URL names no repository OSV knows.
    assert_eq!(pinned, vec![("https://github.com/harfbuzz/harfbuzz".into(), "6879efc2c1596d11a6a6ad296f80063b558d5e0f".into())]);
}
