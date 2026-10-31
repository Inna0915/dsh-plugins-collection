"""Every worker owns its descendants, including children whose parent exits first."""
import ctypes
import os
from ctypes import wintypes

_job = None


def install_owned_subprocesses():
    """Suspend -> attach Job -> resume, so even short-lived commands own children.

    A watcher closes the command's Job as soon as the root exits. This also handles
    grandchildren keeping a redirected output pipe open after that exit.
    """
    if os.name != "nt":
        return
    import subprocess
    import threading
    if getattr(subprocess.Popen, "_package_owned", False):
        return
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = ctypes.c_long
    original = subprocess.Popen

    class OwnedPopen(original):
        _package_owned = True

        def __init__(self, *args, **kwargs):
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | 4
            super().__init__(*args, **kwargs)
            job = kernel.CreateJobObjectW(None, None)
            self._tree_lock = threading.Lock()
            self._tree_job = None
            # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Win64;
            # LimitFlags is at offset 16 in its leading basic structure.
            limits = ctypes.create_string_buffer(144 if ctypes.sizeof(ctypes.c_void_p) == 8 else 112)
            ctypes.c_uint32.from_buffer(limits, 16).value = 0x2000
            wait_handle = kernel.OpenProcess(0x100000, False, self.pid)
            try:
                if not job or not wait_handle:
                    raise ctypes.WinError(ctypes.get_last_error())
                if not kernel.SetInformationJobObject(job, 9, limits, ctypes.sizeof(limits)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if not kernel.AssignProcessToJobObject(job, int(self._handle)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if ntdll.NtResumeProcess(int(self._handle)) != 0:
                    raise RuntimeError("无法启动受管理的子进程")
                self._tree_job = job
            except Exception:
                self.kill()
                self.wait(timeout=5)
                if job:
                    kernel.CloseHandle(job)
                if wait_handle:
                    kernel.CloseHandle(wait_handle)
                raise

            def reap():
                try:
                    kernel.WaitForSingleObject(wait_handle, 0xFFFFFFFF)
                finally:
                    with self._tree_lock:
                        self._tree_job = None
                        kernel.CloseHandle(job)
                    kernel.CloseHandle(wait_handle)
            threading.Thread(target=reap, daemon=True).start()

        def terminate_tree(self):
            """Terminate only this command's Job, without launching taskkill."""
            with self._tree_lock:
                return bool(self._tree_job and kernel.TerminateJobObject(self._tree_job, 1))

    subprocess.Popen = OwnedPopen


def own_process_tree():
    global _job
    if os.name != "nt":
        return
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class Basic(ctypes.Structure):
        _fields_ = [("processTime", ctypes.c_int64), ("jobTime", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("min", ctypes.c_size_t), ("max", ctypes.c_size_t),
                    ("active", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                    ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("ro", "wo", "oo", "rb", "wb", "ob")]

    class Limits(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", IO), ("pm", ctypes.c_size_t),
                    ("jm", ctypes.c_size_t), ("pp", ctypes.c_size_t), ("pj", ctypes.c_size_t)]

    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    _job = kernel.CreateJobObjectW(None, None)
    limits = Limits()
    limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE; Windows closes this handle on worker exit.
    if not _job or not kernel.SetInformationJobObject(_job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(_job, kernel.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
