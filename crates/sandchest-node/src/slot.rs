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
}
