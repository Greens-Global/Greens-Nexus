# ── Nexus remote-support input sink ──────────────────────────────────────────
# Spawned by the agent ONLY while an employee-accepted remote control session is
# active; killed the moment it ends. Reads a compact line protocol on stdin and
# injects it with SendInput (user session, so UAC/secure-desktop prompts are
# deliberately out of reach):
#   mv <x 0..1> <y 0..1>   absolute move on the primary display
#   mvv <x 0..1> <y 0..1>   absolute move on the whole virtual desktop (multi-screen)
#   dn <0|1|2> / up <0|1|2> mouse button down/up (left/middle/right)
#   wh <delta> / wm <delta> vertical / horizontal wheel (WHEEL_DELTA units)
#   kd <vk> <ext> / ku <vk> <ext> virtual-key down/up (ext = extended-key flag)
#   ch <codepoint>          one typed character as a unicode down+up pair
# The whole read-parse-inject loop lives in compiled C# so per-event overhead is
# native, not script-level.

$src = @"
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class InputSink {
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, LD = 0x0002, LU = 0x0004, RD = 0x0008, RU = 0x0010,
               MD = 0x0020, MU = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000,
               VDESK = 0x4000, ABS = 0x8000;
    const uint EXT = 0x0001, KEYUP = 0x0002, UNICODE = 0x0004;

    static void Mouse(uint flags, int dx, int dy, int data) {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].U.mi.dx = dx; inp[0].U.mi.dy = dy;
        inp[0].U.mi.mouseData = unchecked((uint)data); inp[0].U.mi.dwFlags = flags;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }
    static void Key(ushort vk, ushort scan, uint flags) {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].U.ki.wVk = vk; inp[0].U.ki.wScan = scan; inp[0].U.ki.dwFlags = flags;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }
    static double D(string s) { return double.Parse(s, CultureInfo.InvariantCulture); }

    public static void Run() {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            try {
                string[] p = line.Split(' ');
                switch (p[0]) {
                    case "mv": Mouse(MOVE | ABS, (int)(D(p[1]) * 65535), (int)(D(p[2]) * 65535), 0); break;
                    case "mvv": Mouse(MOVE | ABS | VDESK, (int)(D(p[1]) * 65535), (int)(D(p[2]) * 65535), 0); break;
                    case "dn": Mouse(p[1] == "2" ? RD : p[1] == "1" ? MD : LD, 0, 0, 0); break;
                    case "up": Mouse(p[1] == "2" ? RU : p[1] == "1" ? MU : LU, 0, 0, 0); break;
                    case "wh": Mouse(WHEEL, 0, 0, int.Parse(p[1])); break;
                    case "wm": Mouse(HWHEEL, 0, 0, int.Parse(p[1])); break;
                    case "kd": Key(ushort.Parse(p[1]), 0, p[2] == "1" ? EXT : 0u); break;
                    case "ku": Key(ushort.Parse(p[1]), 0, KEYUP | (p[2] == "1" ? EXT : 0u)); break;
                    case "ch": Key(0, ushort.Parse(p[1]), UNICODE); Key(0, ushort.Parse(p[1]), UNICODE | KEYUP); break;
                }
            } catch { }
        }
    }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
[InputSink]::Run()
