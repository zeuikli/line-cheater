use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;

thread_local! {
    static CURRENT_TOKEN: RefCell<Option<CancellationToken>> = const { RefCell::new(None) };
}

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub fn same_operation(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub fn run<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let _scope = CancellationScope::enter(self.clone());
        check_cancelled()?;
        let result = operation()?;
        check_cancelled()?;
        Ok(result)
    }
}

pub(crate) struct CancellationScope(Option<CancellationToken>);

impl CancellationScope {
    pub(crate) fn enter(token: CancellationToken) -> Self {
        let previous = CURRENT_TOKEN.with(|current| current.replace(Some(token)));
        Self(previous)
    }
}

impl Drop for CancellationScope {
    fn drop(&mut self) {
        let previous = self.0.take();
        CURRENT_TOKEN.with(|current| {
            current.replace(previous);
        });
    }
}

pub(crate) fn check_cancelled() -> Result<()> {
    let cancelled = CURRENT_TOKEN.with(|current| {
        current
            .borrow()
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
    });
    if cancelled {
        anyhow::bail!("operation_cancelled");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_scoped_and_shared_across_clones() {
        let token = CancellationToken::new();
        let clone = token.clone();
        {
            let _scope = CancellationScope::enter(token);
            assert!(check_cancelled().is_ok());
            clone.cancel();
            assert!(check_cancelled().is_err());
        }
        assert!(check_cancelled().is_ok());
    }
}
