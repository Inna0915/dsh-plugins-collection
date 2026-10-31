"""手工填写的监控凭据由 Windows 当前用户 DPAPI 保护。"""
import base64
import ctypes
import os
from ctypes import wintypes


def _crypt(value: bytes, decrypt: bool) -> bytes:
    if os.name != "nt":
        raise ValueError("凭据保存需要 Windows")
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ValueError("无法保存或读取当前用户的监控凭据")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel.LocalFree(target.data)


def protect(value: str) -> str:
    return base64.b64encode(_crypt(value.encode(), False)).decode() if value else ""


def reveal(value: str) -> str:
    return _crypt(base64.b64decode(value), True).decode() if value else ""
