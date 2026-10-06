//! Minimal GCD bridge: posts a closure to the main dispatch queue. Replaces
//! `AppHandle::run_on_main_thread` from the Tauri version.
//!
//! `dispatch_get_main_queue` is an inline in the C headers — the exported
//! symbol is the `_dispatch_main_q` global.

use std::ffi::c_void;

type Queue = *mut c_void;
type Work = extern "C" fn(*mut c_void);

unsafe extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(queue: Queue, context: *mut c_void, work: Work);
}

extern "C" fn call<F: FnOnce()>(context: *mut c_void) {
    // SAFETY: `context` is the Box<F> pointer handed to dispatch_async_f.
    let task = unsafe { Box::from_raw(context as *mut F) };
    task();
}

/// Runs `task` on the main queue. The task runs even if the caller is the
/// main thread already (it is queued, not executed inline).
pub fn on_main<F: FnOnce() + Send + 'static>(task: F) {
    let context = Box::into_raw(Box::new(task)) as *mut c_void;
    // SAFETY: &_dispatch_main_q is the main queue; dispatch_async_f takes
    // ownership of the box and calls the trampoline exactly once.
    unsafe {
        let queue = &_dispatch_main_q as *const c_void as Queue;
        dispatch_async_f(queue, context, call::<F>);
    }
}
