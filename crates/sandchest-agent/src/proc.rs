use std::io;

/// Parse CPU time (utime + stime) from /proc/{pid}/stat content.
/// Returns time in clock ticks.
pub fn parse_cpu_time(stat: &str) -> io::Result<u64> {
    // Format: pid (comm) state ppid ... utime(14th) stime(15th) ...
    // comm can contain spaces/parens, so find the last ')' first.
    let after_comm = stat
        .rfind(')')
        .map(|i| &stat[i + 2..])
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed /proc/stat"))?;

    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    // After ')': state(0) ppid(1) ... utime(11) stime(12)
    if fields.len() < 13 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "too few fields in /proc/stat",
        ));
    }

    let utime: u64 = fields[11]
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let stime: u64 = fields[12]
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(utime + stime)
}

/// Read CPU time (utime + stime) from /proc/{pid}/stat.
/// Returns time in clock ticks.
pub fn read_cpu_time(pid: u32) -> io::Result<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    parse_cpu_time(&stat)
}

/// Parse peak memory (VmHWM) from /proc/{pid}/status content.
/// Returns bytes.
pub fn parse_peak_memory(status: &str) -> io::Result<u64> {
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let trimmed = rest.trim();
            let kb_str = trimmed.strip_suffix(" kB").unwrap_or(trimmed);
            let kb: u64 = kb_str
                .trim()
                .parse()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(kb * 1024);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "VmHWM not found in /proc/status",
    ))
}

/// Read peak memory (VmHWM) from /proc/{pid}/status.
/// Returns bytes.
pub fn read_peak_memory(pid: u32) -> io::Result<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
    parse_peak_memory(&status)
}

/// Get the number of clock ticks per second (typically 100 on Linux).
pub fn clock_ticks_per_sec() -> u64 {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: sysconf(_SC_CLK_TCK) is always safe to call.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if ticks > 0 {
            ticks as u64
        } else {
            100
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        100
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real /proc/stat line from a bash process
    const SAMPLE_STAT: &str =
        "12345 (bash) S 1 12345 12345 0 -1 4194304 500 0 0 0 150 30 0 0 20 0 1 0 100 1234567 200 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";

    #[test]
    fn parse_cpu_time_normal() {
        let ticks = parse_cpu_time(SAMPLE_STAT).unwrap();
        // utime=150, stime=30
        assert_eq!(ticks, 180);
    }

    #[test]
    fn parse_cpu_time_comm_with_spaces() {
        // comm field can contain spaces and parens
        let stat = "999 (Web Content) S 1 999 999 0 -1 0 0 0 0 0 42 8 0 0 20 0 1 0 100 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
        let ticks = parse_cpu_time(stat).unwrap();
        assert_eq!(ticks, 50);
    }

    #[test]
    fn parse_cpu_time_comm_with_parens() {
        let stat = "888 (my (app)) S 1 888 888 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 100 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
        let ticks = parse_cpu_time(stat).unwrap();
        assert_eq!(ticks, 15);
    }

    #[test]
    fn parse_cpu_time_zero_values() {
        let stat = "1 (init) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
        let ticks = parse_cpu_time(stat).unwrap();
        assert_eq!(ticks, 0);
    }

    #[test]
    fn parse_cpu_time_malformed_no_parens() {
        let result = parse_cpu_time("garbage data");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn parse_cpu_time_too_few_fields() {
        let stat = "1 (bash) S 0 1";
        let result = parse_cpu_time(stat);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn parse_cpu_time_non_numeric_utime() {
        // Replace utime field with garbage
        let stat = "1 (bash) S 1 1 1 0 -1 0 0 0 0 0 abc 30 0 0 20 0 1 0 100 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
        let result = parse_cpu_time(stat);
        assert!(result.is_err());
    }

    const SAMPLE_STATUS: &str = "\
Name:\tbash
Umask:\t0022
State:\tS (sleeping)
Tgid:\t12345
Pid:\t12345
VmPeak:\t 10000 kB
VmSize:\t  9000 kB
VmHWM:\t  4096 kB
VmRSS:\t  3000 kB
Threads:\t1";

    #[test]
    fn parse_peak_memory_normal() {
        let bytes = parse_peak_memory(SAMPLE_STATUS).unwrap();
        assert_eq!(bytes, 4096 * 1024);
    }

    #[test]
    fn parse_peak_memory_large_value() {
        let status = "Name:\tjava\nVmHWM:\t 2097152 kB\n";
        let bytes = parse_peak_memory(status).unwrap();
        assert_eq!(bytes, 2097152 * 1024); // 2 GB
    }

    #[test]
    fn parse_peak_memory_missing() {
        let status = "Name:\tbash\nVmPeak:\t10000 kB\nVmRSS:\t3000 kB\n";
        let result = parse_peak_memory(status);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn parse_peak_memory_invalid_value() {
        let status = "VmHWM:\t notanumber kB\n";
        let result = parse_peak_memory(status);
        assert!(result.is_err());
    }

    #[test]
    fn parse_peak_memory_no_kb_suffix() {
        // Some kernels might not have the kB suffix
        let status = "VmHWM:\t 512\n";
        let bytes = parse_peak_memory(status).unwrap();
        assert_eq!(bytes, 512 * 1024);
    }

    #[test]
    fn clock_ticks_returns_positive() {
        let ticks = clock_ticks_per_sec();
        assert!(ticks > 0);
    }
}
