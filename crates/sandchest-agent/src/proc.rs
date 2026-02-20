use std::io;

/// Read CPU time (utime + stime) from /proc/{pid}/stat.
/// Returns time in clock ticks.
pub fn read_cpu_time(pid: u32) -> io::Result<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
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

/// Read peak memory (VmHWM) from /proc/{pid}/status.
/// Returns bytes.
pub fn read_peak_memory(pid: u32) -> io::Result<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
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
