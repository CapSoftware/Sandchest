import { describe, expect, test } from "bun:test";
import { createMavenRepository, resolveMaven, type Managed } from "../src/advisories";
import type { Dependency } from "../src/scan/tools";

const pom = (body: string) => `<?xml version="1.0"?><project>${body}</project>`;
const dep = (group: string, artifact: string, extra = "") => `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId>${extra}</dependency>`;

/** A small Maven Central: a Boot-style parent chain with an imported BOM, and two artifacts. */
const CENTRAL: Record<string, string> = {
  "org/acme/boot-parent/3.0.0/boot-parent-3.0.0.pom": pom(
    `<parent><groupId>org.acme</groupId><artifactId>boot-dependencies</artifactId><version>3.0.0</version></parent>`,
  ),
  "org/acme/boot-dependencies/3.0.0/boot-dependencies-3.0.0.pom": pom(`
    <properties><jackson.version>2.14.0</jackson.version></properties>
    <dependencyManagement><dependencies>
      ${dep("com.fasterxml.jackson.core", "jackson-databind", "<version>${jackson.version}</version>")}
      ${dep("org.example", "web", "<version>1.0</version>")}
      ${dep("org.other", "bom", "<version>1.0</version><type>pom</type><scope>import</scope>")}
    </dependencies></dependencyManagement>`),
  "org/other/bom/1.0/bom-1.0.pom": pom(`<dependencyManagement><dependencies>${dep("org.other", "lib", "<version>2.0</version>")}</dependencies></dependencyManagement>`),
  "org/example/web/1.0/web-1.0.pom": pom(`<dependencies>
      ${dep("org.example", "core", "<version>1.1</version>")}
      ${dep("junit", "junit", "<version>4.13</version><scope>test</scope>")}
      ${dep("org.example", "extra", "<version>1.0</version><optional>true</optional>")}
    </dependencies>`),
  "org/example/core/1.1/core-1.1.pom": pom(`<dependencies>${dep("com.fasterxml.jackson.core", "jackson-databind", "<version>2.13.0</version>")}</dependencies>`),
  "org/other/lib/2.0/lib-2.0.pom": pom(""),
  "com/fasterxml/jackson/core/jackson-databind/2.15.1/jackson-databind-2.15.1.pom": pom(""),
};

function central(failing?: string) {
  const fetched: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = url.replace("https://repo1.maven.org/maven2/", "");
    fetched.push(path);
    if (failing && path.includes(failing)) return new Response("", { status: 503 });
    return CENTRAL[path] ? new Response(CENTRAL[path]) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { repository: createMavenRepository({ fetch: fetchImpl }), fetched };
}

const managed = (name: string, over: Partial<Managed> = {}): Managed => ({
  ecosystem: "Maven",
  name,
  version: "",
  manifest: "pom.xml",
  direct: true,
  dev: false,
  reachability: "unknown",
  by: ["org.acme:boot-parent:3.0.0"],
  ...over,
});

const input = {
  dependencies: [] as Dependency[],
  managed: [managed("org.example:web", { reachability: "imported", importedAt: ["src/App.java:3"] }), managed("com.fasterxml.jackson.core:jackson-databind", { properties: { "jackson.version": "2.15.1" } }), managed("org.other:lib")],
  imports: [{ package: "org.example.web.server", at: "src/App.java:3" }],
};

describe("resolveMaven", () => {
  test("versions come from the parent chain and imported BOMs, the project's properties override them, and what the artifacts pull in is added", async () => {
    const { repository } = central();
    const resolved = await resolveMaven(repository, input);
    expect(resolved.map((d) => `${d.name}@${d.version} ${d.direct ? "direct" : "transitive"} ${d.reachability}`).sort()).toEqual([
      "com.fasterxml.jackson.core:jackson-databind@2.15.1 direct unknown",
      // Pulled in by web; traced to the import of its group's package.
      "org.example:core@1.1 transitive imported",
      "org.example:web@1.0 direct imported",
      "org.other:lib@2.0 direct unknown",
    ]);
    // Test-scoped and optional dependencies are never installed; the root's version of jackson wins over core's.
    expect(resolved.find((d) => d.name === "org.example:core")!.importedAt).toEqual(["src/App.java:3"]);
  });

  test("each POM is fetched once, however many projects ask", async () => {
    const { repository, fetched } = central();
    await resolveMaven(repository, input);
    const first = fetched.length;
    await resolveMaven(repository, { ...input, managed: input.managed.map((m) => ({ ...m, manifest: "service/pom.xml" })) });
    expect(fetched.length).toBe(first);
    expect(new Set(fetched).size).toBe(fetched.length);
  });

  test("a Maven Central outage fails the read rather than dropping artifacts", async () => {
    const { repository } = central("org/example/core");
    await expect(resolveMaven(repository, input)).rejects.toThrow("503");
  });

  test("a lockfile already lists everything, so nothing is fetched for it", async () => {
    const { repository, fetched } = central();
    const locked: Dependency = { ecosystem: "Maven", name: "org.example:web", version: "1.0", manifest: "gradle.lockfile", direct: true, dev: false, reachability: "unknown" };
    expect(await resolveMaven(repository, { dependencies: [locked], managed: [], imports: [] })).toEqual([]);
    expect(fetched).toEqual([]);
  });
});
