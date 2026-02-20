use std::collections::HashSet;
use std::sync::Mutex;

/// Maximum number of network slots (each maps to a /30 subnet).
const MAX_SLOTS: u16 = 256;

/// Manages allocation of network slots for sandbox TAP devices.
///
/// Each slot maps to a unique /30 subnet: 172.16.{slot}.0/30.
/// Slot 0 = 172.16.0.0/30, Slot 1 = 172.16.1.0/30, etc.
pub struct SlotManager {
    used: Mutex<HashSet<u16>>,
}

impl Default for SlotManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SlotManager {
    pub fn new() -> Self {
        Self {
            used: Mutex::new(HashSet::new()),
        }
    }

    /// Allocate the next available slot. Returns an error if all slots are in use.
    pub fn allocate(&self) -> Result<u16, SlotError> {
        let mut used = self.used.lock().unwrap();
        for slot in 0..MAX_SLOTS {
            if !used.contains(&slot) {
                used.insert(slot);
                return Ok(slot);
            }
        }
        Err(SlotError::Exhausted)
    }

    /// Release a previously allocated slot.
    pub fn release(&self, slot: u16) {
        let mut used = self.used.lock().unwrap();
        used.remove(&slot);
    }

    /// Number of currently allocated slots.
    pub fn active_count(&self) -> usize {
        self.used.lock().unwrap().len()
    }
}

#[derive(Debug)]
pub enum SlotError {
    Exhausted,
}

impl std::fmt::Display for SlotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlotError::Exhausted => write!(f, "all network slots exhausted (max {})", MAX_SLOTS),
        }
    }
}

impl std::error::Error for SlotError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocate_returns_sequential_slots() {
        let mgr = SlotManager::new();
        assert_eq!(mgr.allocate().unwrap(), 0);
        assert_eq!(mgr.allocate().unwrap(), 1);
        assert_eq!(mgr.allocate().unwrap(), 2);
        assert_eq!(mgr.active_count(), 3);
    }

    #[test]
    fn release_makes_slot_reusable() {
        let mgr = SlotManager::new();
        let s0 = mgr.allocate().unwrap();
        let _s1 = mgr.allocate().unwrap();
        mgr.release(s0);
        // Next allocation reuses released slot
        assert_eq!(mgr.allocate().unwrap(), s0);
    }

    #[test]
    fn exhaustion_returns_error() {
        let mgr = SlotManager::new();
        for _ in 0..256 {
            mgr.allocate().unwrap();
        }
        assert!(matches!(mgr.allocate(), Err(SlotError::Exhausted)));
        assert_eq!(mgr.active_count(), 256);
    }

    #[test]
    fn release_nonexistent_is_noop() {
        let mgr = SlotManager::new();
        mgr.release(42); // no panic
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn release_after_exhaustion_allows_new_allocation() {
        let mgr = SlotManager::new();
        for _ in 0..256 {
            mgr.allocate().unwrap();
        }
        assert!(mgr.allocate().is_err());

        mgr.release(100);
        assert_eq!(mgr.active_count(), 255);
        let slot = mgr.allocate().unwrap();
        assert_eq!(slot, 100);
        assert_eq!(mgr.active_count(), 256);
    }

    #[test]
    fn default_trait_creates_empty_manager() {
        let mgr = SlotManager::default();
        assert_eq!(mgr.active_count(), 0);
        assert_eq!(mgr.allocate().unwrap(), 0);
    }

    #[test]
    fn active_count_after_mixed_operations() {
        let mgr = SlotManager::new();
        let s0 = mgr.allocate().unwrap();
        let s1 = mgr.allocate().unwrap();
        let s2 = mgr.allocate().unwrap();
        assert_eq!(mgr.active_count(), 3);

        mgr.release(s1);
        assert_eq!(mgr.active_count(), 2);

        mgr.release(s0);
        mgr.release(s2);
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn double_release_is_noop() {
        let mgr = SlotManager::new();
        let s = mgr.allocate().unwrap();
        mgr.release(s);
        mgr.release(s); // second release should not panic
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn slot_error_display() {
        let err = SlotError::Exhausted;
        let msg = err.to_string();
        assert!(msg.contains("exhausted"));
        assert!(msg.contains("256"));
    }

    #[test]
    fn slot_error_is_std_error() {
        let err = SlotError::Exhausted;
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn allocate_fills_gaps() {
        let mgr = SlotManager::new();
        let _s0 = mgr.allocate().unwrap(); // 0
        let s1 = mgr.allocate().unwrap(); // 1
        let _s2 = mgr.allocate().unwrap(); // 2

        mgr.release(s1); // free slot 1
        let reused = mgr.allocate().unwrap();
        assert_eq!(reused, 1);
    }

    #[test]
    fn concurrent_access_from_multiple_threads() {
        use std::sync::Arc;
        use std::thread;

        let mgr = Arc::new(SlotManager::new());
        let mut handles = vec![];

        for _ in 0..10 {
            let mgr = Arc::clone(&mgr);
            handles.push(thread::spawn(move || {
                let slot = mgr.allocate().unwrap();
                // Do some work
                std::thread::sleep(std::time::Duration::from_millis(1));
                mgr.release(slot);
            }));
        }

        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(mgr.active_count(), 0);
    }
}
