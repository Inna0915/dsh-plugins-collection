using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace KimiDelegate
{
    // The worker waits on stdin until it has joined this job. Its descendants
    // therefore inherit the job before any Kimi command can run.
    public sealed class WindowsJob : IDisposable
    {
        private IntPtr handle;

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr value);

        public WindowsJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) { throw new Win32Exception(); }
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
            {
                int error = Marshal.GetLastWin32Error();
                Dispose();
                throw new Win32Exception(error);
            }
        }

        public void Add(Process process)
        {
            if (!AssignProcessToJobObject(handle, process.Handle)) { throw new Win32Exception(); }
        }

        public long[] ProcessIds()
        {
            int size = 4096;
            while (size <= 1048576)
            {
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    if (QueryInformationJobObject(handle, 3, buffer, (uint)size, IntPtr.Zero))
                    {
                        int count = Marshal.ReadInt32(buffer, 4);
                        long[] ids = new long[count];
                        for (int i = 0; i < count; i++)
                        {
                            ids[i] = Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
                        }
                        return ids;
                    }
                    int error = Marshal.GetLastWin32Error();
                    if (error != 234) { throw new Win32Exception(error); }
                }
                finally { Marshal.FreeHGlobal(buffer); }
                size *= 2;
            }
            throw new InvalidOperationException("Cannot enumerate job processes.");
        }

        public void Terminate()
        {
            if (!TerminateJobObject(handle, 1)) { throw new Win32Exception(); }
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
        }
    }
}


