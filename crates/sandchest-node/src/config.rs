use serde::Serialize;

/// Resource profile for a sandbox.
#[derive(Debug, Clone, Copy)]
pub enum Profile {
    Small,
    Medium,
    Large,
}

impl Profile {
    pub fn vcpu_count(&self) -> u32 {
        match self {
            Profile::Small => 2,
            Profile::Medium => 4,
            Profile::Large => 8,
        }
    }

    pub fn mem_size_mib(&self) -> u32 {
        match self {
            Profile::Small => 4096,
            Profile::Medium => 8192,
            Profile::Large => 16384,
        }
    }

    pub fn from_resources(cpu_cores: u32, memory_mb: u32) -> Self {
        match (cpu_cores, memory_mb) {
            (c, m) if c <= 2 && m <= 4096 => Profile::Small,
            (c, m) if c <= 4 && m <= 8192 => Profile::Medium,
            _ => Profile::Large,
        }
    }
}

/// Parameters for creating a Firecracker VM.
pub struct VmConfig {
    pub sandbox_id: String,
    pub kernel_path: String,
    pub rootfs_path: String,
    pub vcpu_count: u32,
    pub mem_size_mib: u32,
    pub vsock_uds_path: String,
    pub tap_dev_name: Option<String>,
    pub guest_mac: Option<String>,
}

/// Firecracker JSON configuration structures.
#[derive(Serialize)]
pub struct FirecrackerConfig {
    #[serde(rename = "boot-source")]
    pub boot_source: BootSource,
    pub drives: Vec<Drive>,
    #[serde(rename = "machine-config")]
    pub machine_config: MachineConfig,
    pub vsock: Vsock,
    #[serde(
        rename = "network-interfaces",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub network_interfaces: Vec<NetworkInterface>,
}

#[derive(Serialize)]
pub struct BootSource {
    pub kernel_image_path: String,
    pub boot_args: String,
}

#[derive(Serialize)]
pub struct Drive {
    pub drive_id: String,
    pub path_on_host: String,
    pub is_root_device: bool,
    pub is_read_only: bool,
}

#[derive(Serialize)]
pub struct MachineConfig {
    pub vcpu_count: u32,
    pub mem_size_mib: u32,
    pub smt: bool,
}

#[derive(Serialize)]
pub struct Vsock {
    pub guest_cid: u32,
    pub uds_path: String,
}

#[derive(Serialize)]
pub struct NetworkInterface {
    pub iface_id: String,
    pub guest_mac: String,
    pub host_dev_name: String,
}

const BOOT_ARGS: &str =
    "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/overlay-init";

impl VmConfig {
    /// Build the Firecracker JSON configuration.
    pub fn to_firecracker_config(&self) -> FirecrackerConfig {
        let mut network_interfaces = Vec::new();
        if let (Some(tap), Some(mac)) = (&self.tap_dev_name, &self.guest_mac) {
            network_interfaces.push(NetworkInterface {
                iface_id: "eth0".to_string(),
                guest_mac: mac.clone(),
                host_dev_name: tap.clone(),
            });
        }

        FirecrackerConfig {
            boot_source: BootSource {
                kernel_image_path: self.kernel_path.clone(),
                boot_args: BOOT_ARGS.to_string(),
            },
            drives: vec![Drive {
                drive_id: "rootfs".to_string(),
                path_on_host: self.rootfs_path.clone(),
                is_root_device: true,
                is_read_only: false,
            }],
            machine_config: MachineConfig {
                vcpu_count: self.vcpu_count,
                mem_size_mib: self.mem_size_mib,
                smt: false,
            },
            vsock: Vsock {
                guest_cid: 3,
                uds_path: self.vsock_uds_path.clone(),
            },
            network_interfaces,
        }
    }

    /// Serialize the Firecracker configuration to a JSON string.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(&self.to_firecracker_config())
    }
}

/// S3-compatible object storage configuration for artifact uploads.
///
/// When running on EC2 with an instance profile, `access_key` and `secret_key`
/// can be omitted — the AWS SDK will use the default credential chain (IMDS).
/// Explicit keys are only needed for S3-compatible endpoints (e.g. Scaleway).
#[derive(Debug, Clone)]
pub struct S3Config {
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
}

impl S3Config {
    /// Read S3 configuration from environment variables.
    /// Returns `None` if the required `SANDCHEST_S3_BUCKET` is not set.
    pub fn from_env() -> Option<Self> {
        let bucket = std::env::var("SANDCHEST_S3_BUCKET").ok()?;
        Some(Self {
            bucket,
            region: std::env::var("SANDCHEST_S3_REGION")
                .unwrap_or_else(|_| "us-east-1".to_string()),
            endpoint: std::env::var("SANDCHEST_S3_ENDPOINT").ok(),
            access_key: std::env::var("SANDCHEST_S3_ACCESS_KEY").ok(),
            secret_key: std::env::var("SANDCHEST_S3_SECRET_KEY").ok(),
        })
    }

    /// Returns true if explicit static credentials are configured.
    pub fn has_static_credentials(&self) -> bool {
        self.access_key.is_some() && self.secret_key.is_some()
    }
}

/// mTLS configuration for the gRPC server and outbound control plane stream.
///
/// All three paths must be set for TLS to be enabled. When enabled, the gRPC
/// server requires client certificates signed by the CA and the outbound stream
/// authenticates to the control plane with the same identity.
#[derive(Debug, Clone)]
pub struct TlsConfig {
    pub cert_path: String,
    pub key_path: String,
    pub ca_cert_path: String,
}

impl TlsConfig {
    /// Read TLS configuration from environment variables.
    /// Returns `None` if any of the required variables are not set.
    pub fn from_env() -> Option<Self> {
        let cert_path = std::env::var("SANDCHEST_GRPC_CERT").ok()?;
        let key_path = std::env::var("SANDCHEST_GRPC_KEY").ok()?;
        let ca_cert_path = std::env::var("SANDCHEST_GRPC_CA").ok()?;
        Some(Self {
            cert_path,
            key_path,
            ca_cert_path,
        })
    }
}

/// Node daemon configuration.
pub struct NodeConfig {
    pub node_id: String,
    pub grpc_port: u16,
    pub data_dir: String,
    pub kernel_path: String,
    pub control_plane_url: Option<String>,
    pub jailer: JailerConfig,
    pub s3: Option<S3Config>,
    pub tls: Option<TlsConfig>,
}

impl NodeConfig {
    pub fn from_env() -> Self {
        let data_dir = std::env::var("SANDCHEST_DATA_DIR")
            .unwrap_or_else(|_| "/var/sandchest".to_string());
        Self {
            node_id: std::env::var("SANDCHEST_NODE_ID")
                .unwrap_or_else(|_| id::generate_id(id::NODE_PREFIX)),
            grpc_port: std::env::var("SANDCHEST_NODE_GRPC_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(50051),
            kernel_path: std::env::var("SANDCHEST_KERNEL_PATH")
                .unwrap_or_else(|_| "/var/sandchest/images/vmlinux-5.10".to_string()),
            control_plane_url: std::env::var("SANDCHEST_CONTROL_PLANE_URL").ok(),
            jailer: JailerConfig::from_env(&data_dir),
            s3: S3Config::from_env(),
            tls: TlsConfig::from_env(),
            data_dir,
        }
    }

    pub fn sandboxes_dir(&self) -> String {
        format!("{}/sandboxes", self.data_dir)
    }

    pub fn images_dir(&self) -> String {
        format!("{}/images", self.data_dir)
    }

    pub fn snapshots_dir(&self) -> String {
        format!("{}/snapshots", self.data_dir)
    }
}

use crate::id;
use crate::jailer::JailerConfig;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_small_resources() {
        assert_eq!(Profile::Small.vcpu_count(), 2);
        assert_eq!(Profile::Small.mem_size_mib(), 4096);
    }

    #[test]
    fn profile_medium_resources() {
        assert_eq!(Profile::Medium.vcpu_count(), 4);
        assert_eq!(Profile::Medium.mem_size_mib(), 8192);
    }

    #[test]
    fn profile_large_resources() {
        assert_eq!(Profile::Large.vcpu_count(), 8);
        assert_eq!(Profile::Large.mem_size_mib(), 16384);
    }

    #[test]
    fn from_resources_small_exact_boundary() {
        let p = Profile::from_resources(2, 4096);
        assert_eq!(p.vcpu_count(), 2);
    }

    #[test]
    fn from_resources_small_under() {
        let p = Profile::from_resources(1, 2048);
        assert_eq!(p.vcpu_count(), 2);
    }

    #[test]
    fn from_resources_medium_cpu_over_small() {
        let p = Profile::from_resources(3, 4096);
        assert_eq!(p.vcpu_count(), 4);
    }

    #[test]
    fn from_resources_medium_mem_over_small() {
        let p = Profile::from_resources(2, 5000);
        assert_eq!(p.vcpu_count(), 4);
    }

    #[test]
    fn from_resources_medium_exact_boundary() {
        let p = Profile::from_resources(4, 8192);
        assert_eq!(p.vcpu_count(), 4);
    }

    #[test]
    fn from_resources_large_high_cpu() {
        let p = Profile::from_resources(16, 4096);
        assert_eq!(p.vcpu_count(), 8);
    }

    #[test]
    fn from_resources_large_high_mem() {
        let p = Profile::from_resources(2, 32768);
        assert_eq!(p.vcpu_count(), 8);
    }

    #[test]
    fn from_resources_large_both_over() {
        let p = Profile::from_resources(8, 16384);
        assert_eq!(p.vcpu_count(), 8);
    }

    #[test]
    fn vm_config_boot_args_contain_overlay_init() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };
        let fc = config.to_firecracker_config();
        assert!(fc.boot_source.boot_args.contains("overlay-init"));
        assert!(fc.boot_source.boot_args.contains("console=ttyS0"));
    }

    #[test]
    fn vm_config_vsock_guest_cid_is_3() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/custom/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };
        let fc = config.to_firecracker_config();
        assert_eq!(fc.vsock.guest_cid, 3);
        assert_eq!(fc.vsock.uds_path, "/custom/vsock.sock");
    }

    #[test]
    fn vm_config_drive_is_root_and_writable() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/my/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };
        let fc = config.to_firecracker_config();
        assert_eq!(fc.drives.len(), 1);
        assert_eq!(fc.drives[0].drive_id, "rootfs");
        assert!(fc.drives[0].is_root_device);
        assert!(!fc.drives[0].is_read_only);
        assert_eq!(fc.drives[0].path_on_host, "/my/rootfs.ext4");
    }

    #[test]
    fn vm_config_smt_always_disabled() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: 4,
            mem_size_mib: 8192,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };
        let fc = config.to_firecracker_config();
        assert!(!fc.machine_config.smt);
        assert_eq!(fc.machine_config.vcpu_count, 4);
        assert_eq!(fc.machine_config.mem_size_mib, 8192);
    }

    #[test]
    fn vm_config_no_network_when_only_tap() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: Some("tap0".to_string()),
            guest_mac: None,
        };
        let fc = config.to_firecracker_config();
        assert!(fc.network_interfaces.is_empty());
    }

    #[test]
    fn vm_config_no_network_when_only_mac() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: Some("AA:BB:CC:DD:EE:FF".to_string()),
        };
        let fc = config.to_firecracker_config();
        assert!(fc.network_interfaces.is_empty());
    }

    #[test]
    fn vm_config_network_with_both_tap_and_mac() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: Some("tap-sb_test".to_string()),
            guest_mac: Some("AA:FC:00:00:00:01".to_string()),
        };
        let fc = config.to_firecracker_config();
        assert_eq!(fc.network_interfaces.len(), 1);
        assert_eq!(fc.network_interfaces[0].iface_id, "eth0");
        assert_eq!(fc.network_interfaces[0].host_dev_name, "tap-sb_test");
        assert_eq!(fc.network_interfaces[0].guest_mac, "AA:FC:00:00:00:01");
    }

    #[test]
    fn vm_config_to_json_is_valid() {
        let config = VmConfig {
            sandbox_id: "sb_test".to_string(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };
        let json = config.to_json().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.is_object());
        assert!(parsed.get("boot-source").is_some());
        assert!(parsed.get("drives").is_some());
        assert!(parsed.get("machine-config").is_some());
        assert!(parsed.get("vsock").is_some());
    }

    #[test]
    fn node_config_sandboxes_dir() {
        let config = NodeConfig {
            node_id: "node_test".to_string(),
            grpc_port: 50051,
            data_dir: "/var/sandchest".to_string(),
            kernel_path: "/vmlinux".to_string(),
            control_plane_url: None,
            jailer: JailerConfig::disabled(),
            s3: None,
            tls: None,
        };
        assert_eq!(config.sandboxes_dir(), "/var/sandchest/sandboxes");
    }

    #[test]
    fn node_config_images_dir() {
        let config = NodeConfig {
            node_id: "node_test".to_string(),
            grpc_port: 50051,
            data_dir: "/data".to_string(),
            kernel_path: "/vmlinux".to_string(),
            control_plane_url: None,
            jailer: JailerConfig::disabled(),
            s3: None,
            tls: None,
        };
        assert_eq!(config.images_dir(), "/data/images");
    }

    #[test]
    fn node_config_snapshots_dir() {
        let config = NodeConfig {
            node_id: "node_test".to_string(),
            grpc_port: 50051,
            data_dir: "/data".to_string(),
            kernel_path: "/vmlinux".to_string(),
            control_plane_url: None,
            jailer: JailerConfig::disabled(),
            s3: None,
            tls: None,
        };
        assert_eq!(config.snapshots_dir(), "/data/snapshots");
    }

    #[test]
    fn profile_debug_impl() {
        // Ensure Debug is derived
        let s = format!("{:?}", Profile::Small);
        assert_eq!(s, "Small");
        let m = format!("{:?}", Profile::Medium);
        assert_eq!(m, "Medium");
        let l = format!("{:?}", Profile::Large);
        assert_eq!(l, "Large");
    }

    #[test]
    fn profile_clone_and_copy() {
        let p = Profile::Small;
        let p2 = p;
        // Both should still be valid (Copy trait)
        assert_eq!(p.vcpu_count(), p2.vcpu_count());
    }

    #[test]
    fn tls_config_from_env_all_set() {
        std::env::set_var("SANDCHEST_GRPC_CERT", "/certs/server.pem");
        std::env::set_var("SANDCHEST_GRPC_KEY", "/certs/server.key");
        std::env::set_var("SANDCHEST_GRPC_CA", "/certs/ca.pem");

        let tls = TlsConfig::from_env().expect("should parse TLS config");
        assert_eq!(tls.cert_path, "/certs/server.pem");
        assert_eq!(tls.key_path, "/certs/server.key");
        assert_eq!(tls.ca_cert_path, "/certs/ca.pem");

        std::env::remove_var("SANDCHEST_GRPC_CERT");
        std::env::remove_var("SANDCHEST_GRPC_KEY");
        std::env::remove_var("SANDCHEST_GRPC_CA");
    }

    #[test]
    fn tls_config_from_env_missing_cert() {
        std::env::remove_var("SANDCHEST_GRPC_CERT");
        std::env::set_var("SANDCHEST_GRPC_KEY", "/certs/server.key");
        std::env::set_var("SANDCHEST_GRPC_CA", "/certs/ca.pem");

        assert!(TlsConfig::from_env().is_none());

        std::env::remove_var("SANDCHEST_GRPC_KEY");
        std::env::remove_var("SANDCHEST_GRPC_CA");
    }

    #[test]
    fn tls_config_from_env_missing_key() {
        std::env::set_var("SANDCHEST_GRPC_CERT", "/certs/server.pem");
        std::env::remove_var("SANDCHEST_GRPC_KEY");
        std::env::set_var("SANDCHEST_GRPC_CA", "/certs/ca.pem");

        assert!(TlsConfig::from_env().is_none());

        std::env::remove_var("SANDCHEST_GRPC_CERT");
        std::env::remove_var("SANDCHEST_GRPC_CA");
    }

    #[test]
    fn tls_config_from_env_missing_ca() {
        std::env::set_var("SANDCHEST_GRPC_CERT", "/certs/server.pem");
        std::env::set_var("SANDCHEST_GRPC_KEY", "/certs/server.key");
        std::env::remove_var("SANDCHEST_GRPC_CA");

        assert!(TlsConfig::from_env().is_none());

        std::env::remove_var("SANDCHEST_GRPC_CERT");
        std::env::remove_var("SANDCHEST_GRPC_KEY");
    }

    #[test]
    fn tls_config_clone() {
        let tls = TlsConfig {
            cert_path: "/cert.pem".to_string(),
            key_path: "/key.pem".to_string(),
            ca_cert_path: "/ca.pem".to_string(),
        };
        let tls2 = tls.clone();
        assert_eq!(tls.cert_path, tls2.cert_path);
        assert_eq!(tls.key_path, tls2.key_path);
        assert_eq!(tls.ca_cert_path, tls2.ca_cert_path);
    }
}
