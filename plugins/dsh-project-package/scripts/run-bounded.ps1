param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [string[]]$CommandArgs = @(),
  [int]$TimeoutSeconds = 120,
  [string]$WorkingDirectory = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 1) { throw 'TimeoutSeconds must be positive' }
if (-not ('DshSidebarRecentsProcessJob' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class DshSidebarRecentsProcessJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title; public int x,y,xs,ys,xc,yc,fill,flags;
    public short show, reserved2; public IntPtr reservedPtr, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags; public UIntPtr min,max;
    public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ro,wo,oo,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Io io; public UIntPtr pm,jm,pp,pj; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Limits v, int s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,out Accounting a,int s,IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr p, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Quote(string value) {
    if (value.Length>0 && value.IndexOfAny(new char[]{' ','\t','\n','"'})<0) return value;
    StringBuilder b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') { b.Append('\\',slashes*2+1); b.Append(c); slashes=0; continue; }
      b.Append('\\',slashes); slashes=0; b.Append(c);
    }
    b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  public static int Run(string exe,string[] args,string cwd,int seconds) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); ProcessInfo pi=new ProcessInfo();
    if(job==IntPtr.Zero) throw new Win32Exception();
    try {
      Limits limits=new Limits(); limits.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) throw new Win32Exception();
      Startup si=new Startup(); si.cb=Marshal.SizeOf(si); si.flags=0x100;
      si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
      StringBuilder command=new StringBuilder(Quote(exe));
      foreach(string arg in args) command.Append(" ").Append(Quote(arg));
      if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi)) throw new Win32Exception();
      if(!AssignProcessToJobObject(job,pi.process)) { TerminateProcess(pi.process,1); throw new Win32Exception(); }
      ResumeThread(pi.thread);
      Console.WriteLine("Owned command PID: "+pi.pid+"; timeout: "+seconds+"s");
      uint wait=WaitForSingleObject(pi.process,(uint)seconds*1000);
      if(wait==258) { Console.Error.WriteLine("Command timed out."); return 124; }
      if(wait!=0) throw new Win32Exception();
      uint code; GetExitCodeProcess(pi.process,out code); return (int)code;
    } finally {
      TerminateJobObject(job,1);
      Accounting a=new Accounting();
      for(int i=0;i<100;i++) {
        if(!QueryInformationJobObject(job,1,out a,Marshal.SizeOf(a),IntPtr.Zero) || a.active==0) break;
        System.Threading.Thread.Sleep(20);
      }
      Console.WriteLine("Owned process tree cleanup: "+a.active+" active processes");
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      CloseHandle(job);
    }
  }
}
'@
}
$resolvedExecutable = (Get-Command $Executable -ErrorAction Stop).Source
$resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$result = [DshSidebarRecentsProcessJob]::Run($resolvedExecutable,$CommandArgs,$resolvedWorkingDirectory,$TimeoutSeconds)
exit $result
