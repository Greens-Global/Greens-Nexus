// ── Nexus Monitor Service ─────────────────────────────────────────────────────
// A disclosed, company-managed supervisor for the Nexus desktop agent on
// company-owned Windows PCs that are NOT Intune/MDM-managed.
//
// Why a service AND a session process: a Windows service runs in session 0 and
// cannot see or capture a user's desktop (Windows session isolation). So this
// service - LocalSystem, auto-start - LAUNCHES the Nexus agent into the interactive
// user session and RELAUNCHES it if it exits. Enforcement is entirely through
// NORMAL Windows service permissions: a Standard User cannot stop, reconfigure, or
// delete a service (that requires administrator rights), so an employee cannot turn
// monitoring off; an IT administrator still can, legitimately (services.msc /
// `sc stop` / `sc delete` / uninstall).
//
// This does NOT hide any process, block Task Manager, evade antivirus, or use
// malware-style persistence. Both the service and the agent are visible and named;
// the agent shows its "Nexus Monitoring Active" tray indicator. An employee may
// open Task Manager and even end the agent process - the service simply relaunches
// it, and the Nexus heartbeat flags any gap as offline. That is a legitimate
// supervisor, not a stealth implant.
//
// Build:  dotnet build -c Release   (produces NexusMonitorService.exe, net48)
// Install (IT admin): service\install.ps1     Uninstall (IT admin): service\uninstall.ps1
//
// NOTE: native Win32 session-launch code; must be built and tested on Windows.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

namespace GreensNexus
{
    public class Plugin : ServiceBase
    {
        internal const string SvcName = "Plugin";
        const int CheckIntervalMs = 12000;   // re-check the active session / respawn cadence

        Thread _worker;
        volatile bool _running;
        readonly ManualResetEvent _stop = new ManualResetEvent(false);
        readonly Dictionary<uint, int> _agentPidBySession = new Dictionary<uint, int>();
        readonly object _gate = new object();

        public Plugin()
        {
            ServiceName = SvcName;
            CanHandleSessionChangeEvent = true;   // get logon/unlock events
            CanStop = true;                       // IT admin can stop; Standard Users cannot (ACL)
            CanShutdown = true;
            AutoLog = true;
        }

        static void Main() { Run(new Plugin()); }

        protected override void OnStart(string[] args)
        {
            _running = true;
            _stop.Reset();
            _worker = new Thread(SuperviseLoop) { IsBackground = true };
            _worker.Start();
        }

        protected override void OnStop() { StopAll(); }
        protected override void OnShutdown() { StopAll(); }

        void StopAll()
        {
            _running = false;
            _stop.Set();
            // Stopping the SERVICE stops monitoring - an intentional IT-admin action.
            lock (_gate)
            {
                foreach (var pid in new List<int>(_agentPidBySession.Values)) TryKill(pid);
                _agentPidBySession.Clear();
            }
        }

        protected override void OnSessionChange(SessionChangeDescription c)
        {
            switch (c.Reason)
            {
                case SessionChangeReason.SessionLogon:
                case SessionChangeReason.ConsoleConnect:
                case SessionChangeReason.RemoteConnect:
                case SessionChangeReason.SessionUnlock:
                    EnsureAgent((uint)c.SessionId);
                    break;
                case SessionChangeReason.SessionLogoff:
                case SessionChangeReason.ConsoleDisconnect:
                    lock (_gate) _agentPidBySession.Remove((uint)c.SessionId);
                    break;
            }
        }

        void SuperviseLoop()
        {
            while (_running)
            {
                try
                {
                    uint sid = WTSGetActiveConsoleSessionId();
                    if (sid != 0xFFFFFFFF && sid != 0) EnsureAgent(sid);   // 0 = no interactive user
                }
                catch (Exception ex) { Log("supervise: " + ex.Message, EventLogEntryType.Warning); }
                _stop.WaitOne(CheckIntervalMs);
            }
        }

        // Launch the agent in `session` if it isn't already alive there (respawn on kill).
        void EnsureAgent(uint session)
        {
            lock (_gate)
            {
                int pid;
                if (_agentPidBySession.TryGetValue(session, out pid) && IsAlive(pid)) return;
                int newPid;
                if (LaunchInSession(session, out newPid)) _agentPidBySession[session] = newPid;
            }
        }

        static bool IsAlive(int pid)
        {
            try { using (var p = Process.GetProcessById(pid)) return !p.HasExited; }
            catch { return false; }
        }

        static void TryKill(int pid)
        {
            try { using (var p = Process.GetProcessById(pid)) { if (!p.HasExited) p.Kill(); } }
            catch { }
        }

        // Resolve the installed agent EXE. The MSI puts it under Program Files; the
        // service ships alongside (or one level up). Overridable via NEXUS_AGENT_EXE.
        string AgentExePath()
        {
            var dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            var parent = Directory.GetParent(dir) != null ? Directory.GetParent(dir).FullName : dir;
            var candidates = new[]
            {
                Environment.GetEnvironmentVariable("NEXUS_AGENT_EXE"),
                Path.Combine(dir, "Plugin.exe"),
                Path.Combine(parent, "Plugin.exe"),
                @"C:\Program Files\Plugin\Plugin.exe",
            };
            foreach (var c in candidates)
                if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
            return null;
        }

        bool LaunchInSession(uint session, out int pid)
        {
            pid = 0;
            var exe = AgentExePath();
            if (exe == null) { Log("agent exe not found", EventLogEntryType.Error); return false; }

            IntPtr userToken = IntPtr.Zero, dupToken = IntPtr.Zero, env = IntPtr.Zero;
            try
            {
                if (!WTSQueryUserToken(session, out userToken)) return false;   // no interactive user yet
                var sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                if (!DuplicateTokenEx(userToken, TOKEN_ALL_ACCESS, ref sa,
                        SECURITY_IMPERSONATION_LEVEL.SecurityImpersonation,
                        TOKEN_TYPE.TokenPrimary, out dupToken))
                { Log("DuplicateTokenEx failed: " + Marshal.GetLastWin32Error(), EventLogEntryType.Warning); return false; }

                CreateEnvironmentBlock(out env, dupToken, false);

                var si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = @"winsta0\default";   // the interactive desktop
                var pi = new PROCESS_INFORMATION();
                string cmd = "\"" + exe + "\" --service-managed --background";
                bool ok = CreateProcessAsUser(dupToken, null, cmd, ref sa, ref sa, false,
                        CREATE_UNICODE_ENVIRONMENT, env, Path.GetDirectoryName(exe), ref si, out pi);
                if (!ok) { Log("CreateProcessAsUser failed: " + Marshal.GetLastWin32Error(), EventLogEntryType.Warning); return false; }

                pid = (int)pi.dwProcessId;
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                Log("launched agent pid " + pid + " in session " + session, EventLogEntryType.Information);
                return true;
            }
            catch (Exception ex) { Log("launch: " + ex.Message, EventLogEntryType.Warning); return false; }
            finally
            {
                if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
                if (dupToken != IntPtr.Zero) CloseHandle(dupToken);
                if (userToken != IntPtr.Zero) CloseHandle(userToken);
            }
        }

        static void Log(string msg, EventLogEntryType t)
        {
            try { EventLog.WriteEntry(SvcName, msg, t); } catch { }
        }

        // ── Win32 interop ─────────────────────────────────────────────────────
        const uint TOKEN_ALL_ACCESS = 0xF01FF;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

        enum SECURITY_IMPERSONATION_LEVEL { SecurityAnonymous, SecurityIdentification, SecurityImpersonation, SecurityDelegation }
        enum TOKEN_TYPE { TokenPrimary = 1, TokenImpersonation }

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("wtsapi32.dll", SetLastError = true)]
        static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess,
            ref SECURITY_ATTRIBUTES lpTokenAttributes, SECURITY_IMPERSONATION_LEVEL impersonationLevel,
            TOKEN_TYPE tokenType, out IntPtr phNewToken);

        [DllImport("userenv.dll", SetLastError = true)]
        static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll", SetLastError = true)]
        static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine,
            ref SECURITY_ATTRIBUTES lpProcessAttributes, ref SECURITY_ATTRIBUTES lpThreadAttributes,
            bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr hObject);
    }
}
