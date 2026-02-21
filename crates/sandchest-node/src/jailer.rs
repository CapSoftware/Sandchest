use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;
use tracing::info;

/// Configuration for the Firecracker Jailer.
///
/// When enabled, each Firecracker VM runs inside a chroot with:
/// - Filesystem isolation (chroot)
/// - UID/GID privilege drop
/// - Cgroup resource limits (CPU + memory)
/// - PID namespace isolation
/// - Seccomp syscall filtering (Firecracker built-in, or custom filter)
#[derive(Debug, Clone)]
pub struct JailerConfig {
    /// Whether jailer isolation is enabled (false for dev mode).
    pub enabled: bool,
    /// Path to the jailer binary.
    pub jailer_binary: String,
    /// Absolute path to the firecracker binary (used as --exec-file).
    pub firecracker_binary: String,
    /// Base directory for chroot jails.
    pub chroot_base_dir: String,
    /// UID to run Firecracker as inside the jail.
    pub uid: u32,
    /// GID to run Firecracker as inside the jail.
    pub gid: u32,
    /// Cgroup version (1 or 2).
    pub cgroup_version: u8,
    /// Optional path to a custom seccomp filter JSON file.
    pub seccomp_filter: Option<String>,
    /// Create a new PID namespace for the jailed process.
    pub new_pid_ns: bool,
}

impl JailerConfig {
    /// Load jailer configuration from environment variables.
    pub fn from_env(data_dir: &str) -> Self {
        Self {
            enabled: std::env::var("SANDCHEST_JAILER_ENABLED")
                .map(|v| v == "1" || v.to_lowercase() == "true")
                .unwrap_or(false),
            jailer_binary: std::env::var("SANDCHEST_JAILER_BINARY")
                .unwrap_or_else(|_| "/usr/bin/jailer".to_string()),
            firecracker_binary: std::env::var("SANDCHEST_FIRECRACKER_BINARY")
                .unwrap_or_else(|_| "/usr/bin/firecracker".to_string()),
            chroot_base_dir: std::env::var("SANDCHEST_JAILER_CHROOT_BASE_DIR")
                .unwrap_or_else(|_| format!("{}/jailer", data_dir)),
            uid: std::env::var("SANDCHEST_JAILER_UID")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10000),
            gid: std::env::var("SANDCHEST_JAILER_GID")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10000),
            cgroup_version: std::env::var("SANDCHEST_JAILER_CGROUP_VERSION")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(2),
            seccomp_filter: std::env::var("SANDCHEST_JAILER_SECCOMP_FILTER").ok(),
            new_pid_ns: std::env::var("SANDCHEST_JAILER_NEW_PID_NS")
                .map(|v| v != "0" && v.to_lowercase() != "false")
                .unwrap_or(true),
        }
    }

    /// Create a disabled jailer config (for tests and dev mode).
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            jailer_binary: String::new(),
            firecracker_binary: String::new(),
            chroot_base_dir: String::new(),
            uid: 0,
            gid: 0,
            cgroup_version: 2,
            seccomp_filter: None,
            new_pid_ns: false,
        }
    }

    /// Chroot root directory for a sandbox.
    ///
    /// Layout: `{chroot_base_dir}/firecracker/{sandbox_id}/root/`
    pub fn chroot_root(&self, sandbox_id: &str) -> PathBuf {
        Path::new(&self.chroot_base_dir)
            .join("firecracker")
            .join(sandbox_id)
            .join("root")
    }

    /// Jail directory (parent of chroot root).
    ///
    /// Layout: `{chroot_base_dir}/firecracker/{sandbox_id}/`
    pub fn jail_dir(&self, sandbox_id: &str) -> PathBuf {
        Path::new(&self.chroot_base_dir)
            .join("firecracker")
            .join(sandbox_id)
    }

    /// Host-visible API socket path for a jailed VM.
    pub fn host_api_socket_path(&self, sandbox_id: &str) -> PathBuf {
        self.chroot_root(sandbox_id).join("api.sock")
    }

    /// Host-visible vsock socket path for a jailed VM.
    pub fn host_vsock_path(&self, sandbox_id: &str) -> PathBuf {
        self.chroot_root(sandbox_id).join("vsock.sock")
    }

    /// Convert a host-absolute path to a chroot-relative path.
    ///
    /// Strips the chroot root prefix. Falls back to using the filename
    /// if the path is not under the chroot.
    pub fn to_chroot_path(&self, sandbox_id: &str, host_path: &str) -> String {
        let chroot_root = self.chroot_root(sandbox_id);
        let chroot_str = chroot_root.to_str().unwrap_or("");
        if let Some(relative) = host_path.strip_prefix(chroot_str) {
            if relative.is_empty() {
                "/".to_string()
            } else {
                relative.to_string()
            }
        } else {
            format!(
                "/{}",
                Path::new(host_path)
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or("unknown")
            )
        }
    }

    /// CPU cgroup limit for the given vCPU count.
    ///
    /// For cgroup v2: `cpu.max={quota} {period}` where quota = vcpus * period.
    /// For cgroup v1: `cpu,cpuacct.cfs_quota_us={quota}`.
    pub fn cpu_cgroup_arg(&self, vcpu_count: u32) -> String {
        let period: u64 = 100_000;
        let quota = (vcpu_count as u64) * period;
        if self.cgroup_version == 2 {
            format!("cpu.max={} {}", quota, period)
        } else {
            format!("cpu,cpuacct.cfs_quota_us={}", quota)
        }
    }

    /// Memory cgroup limit (VM memory + 256 MiB overhead for Firecracker process).
    pub fn memory_cgroup_arg(&self, mem_size_mib: u32) -> String {
        let total_bytes = ((mem_size_mib as u64) + 256) * 1024 * 1024;
        if self.cgroup_version == 2 {
            format!("memory.max={}", total_bytes)
        } else {
            format!("memory.limit_in_bytes={}", total_bytes)
        }
    }
}

/// Create the chroot directory structure for a sandbox.
pub async fn prepare_chroot(
    config: &JailerConfig,
    sandbox_id: &str,
) -> Result<PathBuf, JailerError> {
    let chroot_root = config.chroot_root(sandbox_id);

    tokio::fs::create_dir_all(&chroot_root).await.map_err(|e| {
        JailerError::Setup(format!(
            "failed to create chroot {}: {}",
            chroot_root.display(),
            e
        ))
    })?;

    info!(
        sandbox_id = %sandbox_id,
        chroot = %chroot_root.display(),
        "chroot directory prepared"
    );

    Ok(chroot_root)
}

/// Build the jailer `Command` for launching a jailed Firecracker VM.
///
/// When `with_config_file` is true, includes `--config-file config.json` for cold boot.
/// When false, snapshot mode — snapshot will be loaded via the Firecracker API.
pub fn build_jailer_command(
    config: &JailerConfig,
    sandbox_id: &str,
    with_config_file: bool,
    vcpu_count: Option<u32>,
    mem_size_mib: Option<u32>,
) -> Command {
    let mut cmd = Command::new(&config.jailer_binary);

    cmd.arg("--id")
        .arg(sandbox_id)
        .arg("--exec-file")
        .arg(&config.firecracker_binary)
        .arg("--uid")
        .arg(config.uid.to_string())
        .arg("--gid")
        .arg(config.gid.to_string())
        .arg("--chroot-base-dir")
        .arg(&config.chroot_base_dir)
        .arg("--cgroup-version")
        .arg(config.cgroup_version.to_string());

    if let Some(vcpus) = vcpu_count {
        cmd.arg("--cgroup").arg(config.cpu_cgroup_arg(vcpus));
    }
    if let Some(mem) = mem_size_mib {
        cmd.arg("--cgroup").arg(config.memory_cgroup_arg(mem));
    }

    if config.new_pid_ns {
        cmd.arg("--new-pid-ns");
    }

    // Separator between jailer args and Firecracker args
    cmd.arg("--");

    // Firecracker args (paths are chroot-relative)
    cmd.arg("--api-sock").arg("api.sock");

    if with_config_file {
        cmd.arg("--config-file").arg("config.json");
    }

    if let Some(ref filter) = config.seccomp_filter {
        cmd.arg("--seccomp-filter").arg(filter);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    cmd
}

/// Hard-link a file into the chroot. Falls back to copy if cross-device.
pub async fn hardlink_or_copy(src: &str, dst: &Path) -> Result<(), JailerError> {
    match tokio::fs::hard_link(src, dst).await {
        Ok(()) => Ok(()),
        Err(_) => {
            tokio::fs::copy(src, dst).await.map_err(|e| {
                JailerError::Setup(format!(
                    "failed to copy {} to {}: {}",
                    src,
                    dst.display(),
                    e
                ))
            })?;
            Ok(())
        }
    }
}

/// Clean up the jail directory for a sandbox.
pub async fn cleanup_jail(config: &JailerConfig, sandbox_id: &str) {
    let jail_dir = config.jail_dir(sandbox_id);
    if jail_dir.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(&jail_dir).await {
            tracing::error!(
                sandbox_id = %sandbox_id,
                dir = %jail_dir.display(),
                error = %e,
                "failed to clean up jail directory"
            );
        }
    }
}

#[derive(Debug)]
pub enum JailerError {
    Setup(String),
    Spawn(String),
}

impl std::fmt::Display for JailerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JailerError::Setup(msg) => write!(f, "jailer setup error: {}", msg),
            JailerError::Spawn(msg) => write!(f, "jailer spawn error: {}", msg),
        }
    }
}

impl std::error::Error for JailerError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_jailer_config() -> JailerConfig {
        JailerConfig {
            enabled: true,
            jailer_binary: "/usr/bin/jailer".to_string(),
            firecracker_binary: "/usr/bin/firecracker".to_string(),
            chroot_base_dir: "/var/sandchest/jailer".to_string(),
            uid: 10000,
            gid: 10000,
            cgroup_version: 2,
            seccomp_filter: None,
            new_pid_ns: true,
        }
    }

    #[test]
    fn chroot_root_path() {
        let config = test_jailer_config();
        let root = config.chroot_root("sb_test123");
        assert_eq!(
            root,
            PathBuf::from("/var/sandchest/jailer/firecracker/sb_test123/root")
        );
    }

    #[test]
    fn jail_dir_path() {
        let config = test_jailer_config();
        let dir = config.jail_dir("sb_test123");
        assert_eq!(
            dir,
            PathBuf::from("/var/sandchest/jailer/firecracker/sb_test123")
        );
    }

    #[test]
    fn host_api_socket_path() {
        let config = test_jailer_config();
        let path = config.host_api_socket_path("sb_test123");
        assert_eq!(
            path,
            PathBuf::from("/var/sandchest/jailer/firecracker/sb_test123/root/api.sock")
        );
    }

    #[test]
    fn host_vsock_path() {
        let config = test_jailer_config();
        let path = config.host_vsock_path("sb_test123");
        assert_eq!(
            path,
            PathBuf::from("/var/sandchest/jailer/firecracker/sb_test123/root/vsock.sock")
        );
    }

    #[test]
    fn to_chroot_path_strips_prefix() {
        let config = test_jailer_config();
        let path = config.to_chroot_path(
            "sb_test",
            "/var/sandchest/jailer/firecracker/sb_test/root/snapshot_file",
        );
        assert_eq!(path, "/snapshot_file");
    }

    #[test]
    fn to_chroot_path_nested() {
        let config = test_jailer_config();
        let path = config.to_chroot_path(
            "sb_test",
            "/var/sandchest/jailer/firecracker/sb_test/root/sub/dir/file",
        );
        assert_eq!(path, "/sub/dir/file");
    }

    #[test]
    fn to_chroot_path_root() {
        let config = test_jailer_config();
        let path = config.to_chroot_path(
            "sb_test",
            "/var/sandchest/jailer/firecracker/sb_test/root",
        );
        assert_eq!(path, "/");
    }

    #[test]
    fn to_chroot_path_fallback_for_external_path() {
        let config = test_jailer_config();
        let path = config.to_chroot_path("sb_test", "/some/other/path/file.ext");
        assert_eq!(path, "/file.ext");
    }

    #[test]
    fn cpu_cgroup_arg_v2_single_vcpu() {
        let config = test_jailer_config();
        assert_eq!(config.cpu_cgroup_arg(1), "cpu.max=100000 100000");
    }

    #[test]
    fn cpu_cgroup_arg_v2_multi_vcpu() {
        let config = test_jailer_config();
        assert_eq!(config.cpu_cgroup_arg(2), "cpu.max=200000 100000");
        assert_eq!(config.cpu_cgroup_arg(4), "cpu.max=400000 100000");
        assert_eq!(config.cpu_cgroup_arg(8), "cpu.max=800000 100000");
    }

    #[test]
    fn cpu_cgroup_arg_v1() {
        let mut config = test_jailer_config();
        config.cgroup_version = 1;
        assert_eq!(config.cpu_cgroup_arg(4), "cpu,cpuacct.cfs_quota_us=400000");
    }

    #[test]
    fn memory_cgroup_arg_v2() {
        let config = test_jailer_config();
        // (4096 + 256) * 1024 * 1024 = 4563402752
        assert_eq!(config.memory_cgroup_arg(4096), "memory.max=4563402752");
    }

    #[test]
    fn memory_cgroup_arg_v2_large() {
        let config = test_jailer_config();
        // (16384 + 256) * 1024 * 1024 = 17448304640
        assert_eq!(config.memory_cgroup_arg(16384), "memory.max=17448304640");
    }

    #[test]
    fn memory_cgroup_arg_v1() {
        let mut config = test_jailer_config();
        config.cgroup_version = 1;
        assert_eq!(
            config.memory_cgroup_arg(4096),
            "memory.limit_in_bytes=4563402752"
        );
    }

    #[test]
    fn build_command_cold_boot() {
        let config = test_jailer_config();
        let cmd = build_jailer_command(&config, "sb_test", true, Some(2), Some(4096));
        let prog = cmd.as_std().get_program();
        assert_eq!(prog, "/usr/bin/jailer");

        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        assert!(args.contains(&std::ffi::OsStr::new("--id")));
        assert!(args.contains(&std::ffi::OsStr::new("sb_test")));
        assert!(args.contains(&std::ffi::OsStr::new("--exec-file")));
        assert!(args.contains(&std::ffi::OsStr::new("/usr/bin/firecracker")));
        assert!(args.contains(&std::ffi::OsStr::new("--uid")));
        assert!(args.contains(&std::ffi::OsStr::new("10000")));
        assert!(args.contains(&std::ffi::OsStr::new("--gid")));
        assert!(args.contains(&std::ffi::OsStr::new("--chroot-base-dir")));
        assert!(args.contains(&std::ffi::OsStr::new("/var/sandchest/jailer")));
        assert!(args.contains(&std::ffi::OsStr::new("--cgroup-version")));
        assert!(args.contains(&std::ffi::OsStr::new("2")));
        assert!(args.contains(&std::ffi::OsStr::new("--new-pid-ns")));
        assert!(args.contains(&std::ffi::OsStr::new("--")));
        assert!(args.contains(&std::ffi::OsStr::new("--api-sock")));
        assert!(args.contains(&std::ffi::OsStr::new("api.sock")));
        assert!(args.contains(&std::ffi::OsStr::new("--config-file")));
        assert!(args.contains(&std::ffi::OsStr::new("config.json")));
    }

    #[test]
    fn build_command_snapshot_mode() {
        let config = test_jailer_config();
        let cmd = build_jailer_command(&config, "sb_snap", false, None, None);
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        assert!(args.contains(&std::ffi::OsStr::new("--api-sock")));
        assert!(!args.contains(&std::ffi::OsStr::new("--config-file")));
        // No cgroup args when vcpu/mem not provided
        assert!(!args.contains(&std::ffi::OsStr::new("--cgroup")));
    }

    #[test]
    fn build_command_with_seccomp_filter() {
        let mut config = test_jailer_config();
        config.seccomp_filter = Some("/etc/firecracker/seccomp.json".to_string());
        let cmd = build_jailer_command(&config, "sb_sec", false, None, None);
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        assert!(args.contains(&std::ffi::OsStr::new("--seccomp-filter")));
        assert!(args.contains(&std::ffi::OsStr::new("/etc/firecracker/seccomp.json")));
    }

    #[test]
    fn build_command_without_pid_ns() {
        let mut config = test_jailer_config();
        config.new_pid_ns = false;
        let cmd = build_jailer_command(&config, "sb_nopid", false, None, None);
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        assert!(!args.contains(&std::ffi::OsStr::new("--new-pid-ns")));
    }

    #[test]
    fn build_command_with_cgroup_args() {
        let config = test_jailer_config();
        let cmd = build_jailer_command(&config, "sb_cg", true, Some(4), Some(8192));
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        assert!(args.contains(&std::ffi::OsStr::new("--cgroup")));
        assert!(args.contains(&std::ffi::OsStr::new("cpu.max=400000 100000")));
        // (8192 + 256) * 1024 * 1024 = 8858370048
        assert!(args.contains(&std::ffi::OsStr::new("memory.max=8858370048")));
    }

    #[test]
    fn disabled_config() {
        let config = JailerConfig::disabled();
        assert!(!config.enabled);
        assert_eq!(config.uid, 0);
    }

    #[test]
    fn jailer_config_debug() {
        let config = test_jailer_config();
        let debug = format!("{:?}", config);
        assert!(debug.contains("enabled"));
        assert!(debug.contains("10000"));
    }

    #[test]
    fn jailer_config_clone() {
        let config = test_jailer_config();
        let cloned = config.clone();
        assert_eq!(cloned.uid, config.uid);
        assert_eq!(cloned.chroot_base_dir, config.chroot_base_dir);
        assert_eq!(cloned.enabled, config.enabled);
    }

    #[test]
    fn jailer_error_setup_display() {
        let err = JailerError::Setup("bad chroot".to_string());
        assert_eq!(err.to_string(), "jailer setup error: bad chroot");
    }

    #[test]
    fn jailer_error_spawn_display() {
        let err = JailerError::Spawn("not found".to_string());
        assert_eq!(err.to_string(), "jailer spawn error: not found");
    }

    #[test]
    fn jailer_error_is_std_error() {
        let err = JailerError::Setup("test".to_string());
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn jailer_error_debug_format() {
        let err = JailerError::Setup("debug test".to_string());
        let debug = format!("{:?}", err);
        assert!(debug.contains("Setup"));
        assert!(debug.contains("debug test"));
    }

    #[tokio::test]
    async fn prepare_chroot_creates_directory() {
        let tmp = std::env::temp_dir().join("sandchest-prepare-chroot-test");
        let _ = std::fs::remove_dir_all(&tmp);

        let config = JailerConfig {
            enabled: true,
            jailer_binary: "/usr/bin/jailer".to_string(),
            firecracker_binary: "/usr/bin/firecracker".to_string(),
            chroot_base_dir: tmp.to_str().unwrap().to_string(),
            uid: 10000,
            gid: 10000,
            cgroup_version: 2,
            seccomp_filter: None,
            new_pid_ns: true,
        };

        let root = prepare_chroot(&config, "sb_prep").await.unwrap();
        assert!(root.exists());
        assert!(root.ends_with("firecracker/sb_prep/root"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn hardlink_or_copy_works() {
        let tmp = std::env::temp_dir().join("sandchest-hardlink-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let src = tmp.join("source.txt");
        std::fs::write(&src, b"hello jailer").unwrap();

        let dst = tmp.join("dest.txt");
        hardlink_or_copy(src.to_str().unwrap(), &dst).await.unwrap();

        assert!(dst.exists());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "hello jailer");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn hardlink_or_copy_fails_for_missing_source() {
        let dst = std::env::temp_dir().join("sandchest-hl-missing-dst.txt");
        let result = hardlink_or_copy("/nonexistent/file.txt", &dst).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn cleanup_jail_removes_directory() {
        let tmp = std::env::temp_dir().join("sandchest-cleanup-jail-test");
        let _ = std::fs::remove_dir_all(&tmp);

        let config = JailerConfig {
            enabled: true,
            jailer_binary: String::new(),
            firecracker_binary: String::new(),
            chroot_base_dir: tmp.to_str().unwrap().to_string(),
            uid: 10000,
            gid: 10000,
            cgroup_version: 2,
            seccomp_filter: None,
            new_pid_ns: true,
        };

        let jail_dir = config.jail_dir("sb_cleanup");
        std::fs::create_dir_all(&jail_dir).unwrap();
        std::fs::write(jail_dir.join("test.txt"), b"test").unwrap();

        assert!(jail_dir.exists());
        cleanup_jail(&config, "sb_cleanup").await;
        assert!(!jail_dir.exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn cleanup_jail_nonexistent_is_noop() {
        let config = JailerConfig {
            enabled: true,
            jailer_binary: String::new(),
            firecracker_binary: String::new(),
            chroot_base_dir: "/tmp/sandchest-nonexistent-cleanup".to_string(),
            uid: 10000,
            gid: 10000,
            cgroup_version: 2,
            seccomp_filter: None,
            new_pid_ns: true,
        };
        // Should not panic
        cleanup_jail(&config, "sb_nonexistent").await;
    }
}
