//! Smoke-test kernel: proves the build, the loader and the memory helpers work end to end. No tool uses it.
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn an_alloc(bytes: usize) -> *mut u8 {
    if bytes == 0 {
        return 8 as *mut u8;
    }
    unsafe { alloc(Layout::from_size_align_unchecked(bytes, 8)) }
}

#[no_mangle]
pub unsafe extern "C" fn an_free(ptr: *mut u8, bytes: usize) {
    if bytes != 0 {
        dealloc(ptr, Layout::from_size_align_unchecked(bytes, 8));
    }
}

/// Sum of `len` f64 values at `ptr`.
#[no_mangle]
pub unsafe extern "C" fn probe_sum(ptr: *const f64, len: usize) -> f64 {
    std::slice::from_raw_parts(ptr, len).iter().sum()
}
