use std::process::Stdio;

use tokio::process::Command;
use tracing::{info, warn};

/// Network configuration for a sandbox.
#[derive(Debug, Clone)]
pub struct NetworkConfig {
    pub tap_name: String,
    pub host_ip: String,
    pub guest_ip: String,
    pub gateway: String,
    pub guest_mac: String,
    pub dns: String,
    pub slot: u16,
}

/// Default outbound interface for NAT masquerade.
const DEFAULT_OUTBOUND_IFACE: &str = "eth0";

/// Default bandwidth limit per sandbox in Mbps.
const DEFAULT_BANDWIDTH_MBPS: u32 = 100;

/// Derive a TAP device name from the sandbox ID.
/// TAP names are limited to 15 chars by the kernel. We use "tap-" + first 11 chars of sandbox_id.
fn tap_name_for(sandbox_id: &str) -> String {
    let suffix: String = sandbox_id.chars().take(11).collect();
    format!("tap-{}", suffix)
}

/// Compute the guest MAC address from a slot number.
/// Format: AA:FC:00:00:{slot_hi}:{slot_lo}
fn mac_for_slot(slot: u16) -> String {
    let hi = (slot >> 8) as u8;
    let lo = (slot & 0xFF) as u8;
    format!("AA:FC:00:00:{:02X}:{:02X}", hi, lo)
}

/// Set up networking for a sandbox: TAP device, IP assignment, NAT rules.
pub async fn setup_network(sandbox_id: &str, slot: u16) -> Result<NetworkConfig, NetworkError> {
    let tap_name = tap_name_for(sandbox_id);
    let host_ip = format!("172.16.{}.1", slot);
    let guest_ip = format!("172.16.{}.2", slot);
    let subnet = format!("172.16.{}.0/30", slot);
    let host_cidr = format!("{}/30", host_ip);
    let guest_mac = mac_for_slot(slot);

    let outbound_iface =
        std::env::var("SANDCHEST_OUTBOUND_IFACE").unwrap_or_else(|_| DEFAULT_OUTBOUND_IFACE.to_string());

    info!(
        sandbox_id = %sandbox_id,
        tap = %tap_name,
        slot = slot,
        host_ip = %host_ip,
        guest_ip = %guest_ip,
        "setting up network"
    );

    // 1. Create TAP device
    run_cmd("ip", &["tuntap", "add", &tap_name, "mode", "tap"]).await?;

    // 2. Assign host IP
    run_cmd("ip", &["addr", "add", &host_cidr, "dev", &tap_name]).await?;

    // 3. Bring up interface
    run_cmd("ip", &["link", "set", &tap_name, "up"]).await?;

    // 4. NAT masquerade
    run_cmd(
        "iptables",
        &["-t", "nat", "-A", "POSTROUTING", "-o", &outbound_iface, "-s", &subnet, "-j", "MASQUERADE"],
    )
    .await?;

    // 5. Forward rules
    run_cmd(
        "iptables",
        &["-A", "FORWARD", "-i", &tap_name, "-o", &outbound_iface, "-j", "ACCEPT"],
    )
    .await?;

    run_cmd(
        "iptables",
        &[
            "-A", "FORWARD", "-i", &outbound_iface, "-o", &tap_name,
            "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT",
        ],
    )
    .await?;

    // 6. Bandwidth limiting
    let bandwidth = std::env::var("SANDCHEST_BANDWIDTH_MBPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_BANDWIDTH_MBPS);
    setup_bandwidth_limit(&tap_name, bandwidth).await?;

    info!(sandbox_id = %sandbox_id, tap = %tap_name, "network setup complete");

    Ok(NetworkConfig {
        tap_name,
        host_ip,
        guest_ip: guest_ip.clone(),
        gateway: format!("172.16.{}.1", slot),
        guest_mac,
        dns: "1.1.1.1".to_string(),
        slot,
    })
}

/// Tear down networking for a sandbox: remove iptables rules and TAP device.
pub async fn teardown_network(sandbox_id: &str, slot: u16) {
    let tap_name = tap_name_for(sandbox_id);
    let subnet = format!("172.16.{}.0/30", slot);

    let outbound_iface =
        std::env::var("SANDCHEST_OUTBOUND_IFACE").unwrap_or_else(|_| DEFAULT_OUTBOUND_IFACE.to_string());

    info!(sandbox_id = %sandbox_id, tap = %tap_name, slot = slot, "tearing down network");

    // Remove iptables rules (best-effort, ignore errors)
    if let Err(e) = run_cmd(
        "iptables",
        &[
            "-D", "FORWARD", "-i", &outbound_iface, "-o", &tap_name,
            "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT",
        ],
    )
    .await
    {
        warn!(error = %e, "failed to remove FORWARD RELATED rule");
    }

    if let Err(e) = run_cmd(
        "iptables",
        &["-D", "FORWARD", "-i", &tap_name, "-o", &outbound_iface, "-j", "ACCEPT"],
    )
    .await
    {
        warn!(error = %e, "failed to remove FORWARD rule");
    }

    if let Err(e) = run_cmd(
        "iptables",
        &["-t", "nat", "-D", "POSTROUTING", "-o", &outbound_iface, "-s", &subnet, "-j", "MASQUERADE"],
    )
    .await
    {
        warn!(error = %e, "failed to remove NAT rule");
    }

    // Delete TAP device (this also removes the tc qdisc)
    if let Err(e) = run_cmd("ip", &["link", "del", &tap_name]).await {
        warn!(error = %e, "failed to delete TAP device");
    }

    info!(sandbox_id = %sandbox_id, tap = %tap_name, "network teardown complete");
}

/// Apply bandwidth limiting on a TAP device using tc.
async fn setup_bandwidth_limit(tap_name: &str, rate_mbps: u32) -> Result<(), NetworkError> {
    let rate = format!("{}mbit", rate_mbps);
    let burst = format!("{}k", rate_mbps * 10); // burst = 10KB per Mbps

    run_cmd(
        "tc",
        &[
            "qdisc", "add", "dev", tap_name, "root", "tbf",
            "rate", &rate, "burst", &burst, "latency", "50ms",
        ],
    )
    .await
}

/// Run an external command and return an error if it fails.
async fn run_cmd(program: &str, args: &[&str]) -> Result<(), NetworkError> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| NetworkError::Command(format!("{} {}: {}", program, args.join(" "), e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(NetworkError::Command(format!(
            "{} {} failed ({}): {}",
            program,
            args.join(" "),
            output.status,
            stderr.trim()
        )));
    }

    Ok(())
}

#[derive(Debug)]
pub enum NetworkError {
    Command(String),
}

impl std::fmt::Display for NetworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetworkError::Command(msg) => write!(f, "network command failed: {}", msg),
        }
    }
}

impl std::error::Error for NetworkError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tap_name_truncated_to_15_chars() {
        // "tap-" (4) + 11 chars = 15
        let name = tap_name_for("sb_1234567890ABCDEF");
        assert_eq!(name, "tap-sb_12345678");
        assert!(name.len() <= 15);
    }

    #[test]
    fn tap_name_short_id() {
        let name = tap_name_for("sb_abc");
        assert_eq!(name, "tap-sb_abc");
    }

    #[test]
    fn mac_for_slot_zero() {
        assert_eq!(mac_for_slot(0), "AA:FC:00:00:00:00");
    }

    #[test]
    fn mac_for_slot_one() {
        assert_eq!(mac_for_slot(1), "AA:FC:00:00:00:01");
    }

    #[test]
    fn mac_for_slot_255() {
        assert_eq!(mac_for_slot(255), "AA:FC:00:00:00:FF");
    }

    #[test]
    fn mac_for_slot_256() {
        // slot_hi = 1, slot_lo = 0
        assert_eq!(mac_for_slot(256), "AA:FC:00:00:01:00");
    }
}
