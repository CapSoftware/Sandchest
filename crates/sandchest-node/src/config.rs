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

/// Node daemon configuration.
pub struct NodeConfig {
    pub node_id: String,
    pub grpc_port: u16,
    pub data_dir: String,
    pub kernel_path: String,
}

impl NodeConfig {
    pub fn from_env() -> Self {
        Self {
            node_id: std::env::var("SANDCHEST_NODE_ID")
                .unwrap_or_else(|_| id::generate_id(id::NODE_PREFIX)),
            grpc_port: std::env::var("SANDCHEST_NODE_GRPC_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(50051),
            data_dir: std::env::var("SANDCHEST_DATA_DIR")
                .unwrap_or_else(|_| "/var/sandchest".to_string()),
            kernel_path: std::env::var("SANDCHEST_KERNEL_PATH")
                .unwrap_or_else(|_| "/var/sandchest/images/vmlinux-5.10".to_string()),
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
