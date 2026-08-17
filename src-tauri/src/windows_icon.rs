#![cfg(target_os = "windows")]

use image::{ImageFormat, RgbaImage};
use std::{ffi::c_void, io::Cursor, mem, path::Path};
use windows_sys::Win32::{
    Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC,
        GetDIBits, GetObjectW, ReleaseDC,
    },
    UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO, PrivateExtractIconsW},
};

struct ExtractedIcon(HICON);

impl Drop for ExtractedIcon {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { DestroyIcon(self.0) };
        }
    }
}

struct IconBitmaps(ICONINFO);

impl Drop for IconBitmaps {
    fn drop(&mut self) {
        unsafe {
            if !self.0.hbmColor.is_null() {
                DeleteObject(self.0.hbmColor);
            }
            if !self.0.hbmMask.is_null() {
                DeleteObject(self.0.hbmMask);
            }
        }
    }
}

pub fn extract_png(path: &Path, requested_size: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut handle = std::ptr::null_mut();
    let mut resource_id = 0u32;
    let count = unsafe {
        PrivateExtractIconsW(
            wide.as_ptr(),
            0,
            requested_size as i32,
            requested_size as i32,
            &mut handle,
            &mut resource_id,
            1,
            0,
        )
    };
    if count == 0 || count == u32::MAX || handle.is_null() {
        return Err("the executable has no extractable icon resource".into());
    }
    let handle = ExtractedIcon(handle);
    let mut info: ICONINFO = unsafe { mem::zeroed() };
    if unsafe { GetIconInfo(handle.0, &mut info) } == 0 {
        return Err("Windows could not read the extracted icon resource".into());
    }
    let info = IconBitmaps(info);
    if info.0.hbmColor.is_null() {
        return Err("the icon resource has no colour bitmap".into());
    }

    let mut bitmap: BITMAP = unsafe { mem::zeroed() };
    if unsafe {
        GetObjectW(
            info.0.hbmColor,
            mem::size_of::<BITMAP>() as i32,
            &mut bitmap as *mut _ as *mut c_void,
        )
    } == 0
    {
        return Err("Windows could not inspect the icon bitmap".into());
    }
    let width = bitmap.bmWidth.unsigned_abs();
    let height = bitmap.bmHeight.unsigned_abs();
    if width == 0 || height == 0 || width > 2048 || height > 2048 {
        return Err("the extracted icon has invalid dimensions".into());
    }

    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let mut bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..unsafe { mem::zeroed() }
        },
        ..unsafe { mem::zeroed() }
    };
    let dc = unsafe { GetDC(std::ptr::null_mut()) };
    if dc.is_null() {
        return Err("Windows could not create an icon drawing context".into());
    }
    let copied = unsafe {
        GetDIBits(
            dc,
            info.0.hbmColor,
            0,
            height,
            pixels.as_mut_ptr().cast(),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        )
    };
    unsafe { ReleaseDC(std::ptr::null_mut(), dc) };
    if copied != height as i32 {
        return Err("Windows did not return the complete icon bitmap".into());
    }

    let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        if !has_alpha {
            pixel[3] = 255;
        }
    }
    let image = RgbaImage::from_raw(width, height, pixels)
        .ok_or("the extracted icon pixel buffer is invalid")?;
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    eprintln!(
        "[IconResolver] source=windows-resource path={} resource_id={} requested={}x{} decoded={}x{} cache_format=PNG",
        path.display(),
        resource_id,
        requested_size,
        requested_size,
        width,
        height
    );
    Ok((output.into_inner(), width, height))
}

use std::os::windows::ffi::OsStrExt;
