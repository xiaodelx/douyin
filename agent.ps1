#requires -Version 5.1
<#
  dsh-plugin-computer-use — JSON-line PC control agent for Windows.

  Started by the DSH plugin as a persistent child process:
      powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File agent.ps1

  Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
      {"id":1,"cmd":"move","args":{"x":100,"y":200}}
      {"id":1,"ok":true,"data":{...}}
      {"id":1,"ok":false,"code":"KILL_SWITCH","error":"..."}

  The agent owns every Win32 call: it never executes model-supplied code or
  shell text, so the attack surface stays the fixed command table below.
#>
param(
  [string]$Root = (Join-Path $env:TEMP 'dsh-pc-control')
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
} catch { }
$OutputEncoding = $utf8

# Own the stdio streams explicitly: [Console]::In/Out keep whatever code page the
# host started with, which mangles non-ASCII text before the encodings above apply.
$script:StdIn = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false)
$script:StdOut = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8, 8192)
$script:StdOut.AutoFlush = $true

if (-not (Test-Path -LiteralPath $Root)) {
  New-Item -ItemType Directory -Path $Root -Force | Out-Null
}
$ShotDir = Join-Path $Root 'shots'
if (-not (Test-Path -LiteralPath $ShotDir)) {
  New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$script:Stopped = $false
$script:ShotSeq = 0
$script:VkMap = $null
$script:ShiftHeld = $false
$script:AgentStart = Get-Date

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PcNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public const int INPUT_MOUSE = 0;
    public const int INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public static int InputSize()
    {
        return Marshal.SizeOf(typeof(INPUT));
    }

    public static bool EnableDpiAwareness()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; }
        catch { }
        try { return SetProcessDPIAware(); }
        catch { return false; }
    }

    public static int[] Metrics()
    {
        return new int[] {
            GetSystemMetrics(0),   // SM_CXSCREEN
            GetSystemMetrics(1),   // SM_CYSCREEN
            GetSystemMetrics(76),  // SM_XVIRTUALSCREEN
            GetSystemMetrics(77),  // SM_YVIRTUALSCREEN
            GetSystemMetrics(78),  // SM_CXVIRTUALSCREEN
            GetSystemMetrics(79),  // SM_CYVIRTUALSCREEN
            GetSystemMetrics(80)   // SM_CMONITORS
        };
    }

    public static int[] CursorPosition()
    {
        POINT p;
        GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }

    public static bool MoveCursor(int x, int y)
    {
        return SetCursorPos(x, y);
    }

    public static long ForegroundWindow()
    {
        return GetForegroundWindow().ToInt64();
    }

    public static string Title(long handle)
    {
        IntPtr h = new IntPtr(handle);
        int len = GetWindowTextLengthW(h);
        if (len <= 0) return string.Empty;
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static int[] Rect(long handle)
    {
        RECT r;
        if (!GetWindowRect(new IntPtr(handle), out r)) return new int[] { 0, 0, 0, 0 };
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static uint ProcessId(long handle)
    {
        uint pid;
        GetWindowThreadProcessId(new IntPtr(handle), out pid);
        return pid;
    }

    public static string[] ListWindows()
    {
        List<string> rows = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLengthW(h);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowTextW(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.Trim().Length == 0) return true;
            RECT r;
            GetWindowRect(h, out r);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            rows.Add(h.ToInt64().ToString() + "\t" + pid.ToString() + "\t" +
                     r.Left.ToString() + "," + r.Top.ToString() + "," +
                     (r.Right - r.Left).ToString() + "," + (r.Bottom - r.Top).ToString() + "\t" + title);
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }

    public static bool Activate(long handle)
    {
        IntPtr h = new IntPtr(handle);
        // SW_RESTORE both un-minimizes and activates; on a normal window it is a no-op restore.
        ShowWindow(h, 9);
        IntPtr fg = GetForegroundWindow();
        uint ignored = 0;
        uint fgThread = GetWindowThreadProcessId(fg, out ignored);
        uint targetThread = GetWindowThreadProcessId(h, out ignored);
        uint self = GetCurrentThreadId();
        bool attached1 = false;
        bool attached2 = false;
        if (fgThread != 0 && fgThread != self)
        {
            attached1 = AttachThreadInput(self, fgThread, true);
        }
        if (targetThread != 0 && targetThread != self && targetThread != fgThread)
        {
            attached2 = AttachThreadInput(self, targetThread, true);
        }
        bool ok = SetForegroundWindow(h);
        ok = BringWindowToTop(h) || ok;
        try { SetFocus(h); } catch { }
        if (attached1) AttachThreadInput(self, fgThread, false);
        if (attached2) AttachThreadInput(self, targetThread, false);
        return ok;
    }

    public static bool PrintWindowToHandle(long handle, IntPtr hdc)
    {
        return PrintWindow(new IntPtr(handle), hdc, 2); // PW_RENDERFULLCONTENT
    }

    public static bool KeyDown(int vk)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = (ushort)vk;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = 0;
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static bool KeyUp(int vk)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = (ushort)vk;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = KEYEVENTF_KEYUP;
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static bool UnicodeChar(char ch, bool up)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = 0;
        input.u.ki.wScan = (ushort)ch;
        input.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static bool MouseButton(uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = 0;
        input.u.mi.dy = 0;
        input.u.mi.mouseData = 0;
        input.u.mi.dwFlags = flags;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static bool MouseWheel(int delta, bool horizontal)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = 0;
        input.u.mi.dy = 0;
        input.u.mi.mouseData = unchecked((uint)delta);
        input.u.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static short KeyState(int vk)
    {
        return GetAsyncKeyState(vk);
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp | Out-Null

$script:DpiAware = [PcNative]::EnableDpiAwareness()

function Get-VkMap {
  if ($script:VkMap -ne $null) { return $script:VkMap }
  $map = @{
    'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B; 'lwin' = 0x5B; 'rwin' = 0x5C
    'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20
    'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D; 'home' = 0x24; 'end' = 0x23
    'pageup' = 0x21; 'pagedown' = 0x22; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
    'capslock' = 0x14; 'printscreen' = 0x2C; 'apps' = 0x5D; 'minus' = 0xBD; 'plus' = 0xBB
    'comma' = 0xBC; 'period' = 0xBE; 'slash' = 0xBF; 'semicolon' = 0xBA; 'quote' = 0xDE
    'backslash' = 0xDC; '[' = 0xDB; ']' = 0xDD; '`' = 0xC0
  }
  foreach ($i in 0..25) {
    $map[[string][char]([int][char]'a' + $i)] = 0x41 + $i
  }
  foreach ($i in 0..9) {
    $map[[string]([char]([int][char]'0' + $i))] = 0x30 + $i
  }
  foreach ($i in 1..24) {
    $map["f$i"] = 0x6F + $i
  }
  $script:VkMap = $map
  return $map
}

function Resolve-Vk {
  param([string]$Key)
  $k = $Key.Trim().ToLowerInvariant()
  $map = Get-VkMap
  if ($map.ContainsKey($k)) { return [int]$map[$k] }
  if ($k.Length -eq 1) {
    $c = [int][char]$k
    if ($c -ge 97 -and $c -le 122) { return $c - 32 }
    if ($c -ge 48 -and $c -le 57) { return $c }
    if ($c -eq 32) { return 0x20 }
  }
  throw "unknown key name: $Key"
}

function Test-Abort {
  if ($script:Stopped) { return $true }
  $ctrl = [PcNative]::KeyState(0x11)
  $alt = [PcNative]::KeyState(0x12)
  $shift = [PcNative]::KeyState(0x10)
  $q = [PcNative]::KeyState(0x51)
  if ((($ctrl -band 0x8000) -ne 0) -and (($alt -band 0x8000) -ne 0) -and (($shift -band 0x8000) -ne 0) -and (($q -band 0x8000) -ne 0)) {
    $script:Stopped = $true
    return $true
  }
  return $false
}

function New-Abort {
  return @{ ok = $false; code = 'KILL_SWITCH'; error = 'stopped by the kill switch (Ctrl+Alt+Shift+Q) or by a panic request' }
}

function Get-WindowRows {
  $rows = @()
  foreach ($line in [PcNative]::ListWindows()) {
    $parts = $line.Split("`t")
    if ($parts.Length -lt 4) { continue }
    $rect = $parts[2].Split(',')
    $rows += [ordered]@{
      hwnd  = [long]$parts[0]
      pid   = [int]$parts[1]
      x     = [int]$rect[0]
      y     = [int]$rect[1]
      width = [int]$rect[2]
      height= [int]$rect[3]
      title = $parts[3]
    }
  }
  return $rows
}

function Resolve-Window {
  param([string]$Spec)
  if ([string]::IsNullOrWhiteSpace($Spec)) { throw 'a window spec (hwnd or title substring) is required' }
  $rows = Get-WindowRows
  $hwnd = 0L
  if ([long]::TryParse($Spec, [ref]$hwnd)) {
    # Query the handle directly: a window that is minimized, hidden, or missing
    # from the visible enumeration still has a real rectangle.
    $rect = [PcNative]::Rect($hwnd)
    return [ordered]@{
      hwnd   = $hwnd
      pid    = [int][PcNative]::ProcessId($hwnd)
      x      = [int]$rect[0]
      y      = [int]$rect[1]
      width  = [int]$rect[2]
      height = [int]$rect[3]
      title  = [PcNative]::Title($hwnd)
    }
  }
  $needle = $Spec.Trim()
  $match = $rows | Where-Object { $_.title -like "*$needle*" } | Sort-Object { $_.width * $_.height } -Descending | Select-Object -First 1
  if ($match -eq $null) { throw "no visible window whose title contains '$needle'" }
  return $match
}

function Get-ForegroundWindowRow {
  $fg = [PcNative]::ForegroundWindow()
  $rows = Get-WindowRows
  $hit = $rows | Where-Object { $_.hwnd -eq $fg } | Select-Object -First 1
  if ($hit -ne $null) { return $hit }
  $rect = [PcNative]::Rect($fg)
  return [ordered]@{
    hwnd   = $fg
    pid    = [int][PcNative]::ProcessId($fg)
    x      = [int]$rect[0]
    y      = [int]$rect[1]
    width  = [int]$rect[2]
    height = [int]$rect[3]
    title  = [PcNative]::Title($fg)
  }
}

function Save-Bitmap {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$Path,
    [int]$MaxWidth = 0
  )
  $out = $Bitmap
  $scaled = $false
  if ($MaxWidth -gt 0 -and $Bitmap.Width -gt $MaxWidth) {
    $ratio = $MaxWidth / $Bitmap.Width
    $w = [int][Math]::Round($Bitmap.Width * $ratio)
    $h = [int][Math]::Round($Bitmap.Height * $ratio)
    $out = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($Bitmap, 0, 0, $w, $h)
    } finally {
      $g.Dispose()
    }
    $scaled = $true
  }
  try {
    $out.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    return [ordered]@{ width = $out.Width; height = $out.Height; scaled = $scaled }
  } finally {
    if ($scaled) { $out.Dispose() }
  }
}

function Invoke-CaptureScreen {
  param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Path, [int]$MaxWidth)
  if ($W -le 0 -or $H -le 0) { throw "invalid capture size ${W}x${H}" }
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
    } finally {
      $g.Dispose()
    }
    return Save-Bitmap -Bitmap $bmp -Path $Path -MaxWidth $MaxWidth
  } finally {
    $bmp.Dispose()
  }
}

function Invoke-CaptureWindow {
  param([long]$Hwnd, [string]$Path, [int]$MaxWidth)
  $rect = [PcNative]::Rect($Hwnd)
  $w = [int]$rect[2]
  $h = [int]$rect[3]
  if ($w -le 0 -or $h -le 0) { throw "window $Hwnd has no capturable area (minimized?)" }
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $printed = $false
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $hdc = $g.GetHdc()
      try {
        $printed = [PcNative]::PrintWindowToHandle($Hwnd, $hdc)
      } finally {
        $g.ReleaseHdc($hdc)
      }
    } finally {
      $g.Dispose()
    }
    if (-not $printed) {
      $bmp.Dispose()
      return Invoke-CaptureScreen -X ([int]$rect[0]) -Y ([int]$rect[1]) -W $w -H $h -Path $Path -MaxWidth $MaxWidth
    }
    return Save-Bitmap -Bitmap $bmp -Path $Path -MaxWidth $MaxWidth
  } finally {
    if ($printed) { $bmp.Dispose() }
  }
}

function New-ShotPath {
  $script:ShotSeq++
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  return (Join-Path $ShotDir ("shot-{0}-{1:d3}.png" -f $stamp, $script:ShotSeq))
}

function Invoke-MoveTo {
  param([int]$X, [int]$Y, [int]$DurationMs = 0)
  if ($DurationMs -le 0) {
    [void][PcNative]::MoveCursor($X, $Y)
    return
  }
  $start = [PcNative]::CursorPosition()
  $steps = [int][Math]::Max(4, [Math]::Min(60, $DurationMs / 16))
  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / $steps
    # ease-out so the pointer settles instead of snapping
    $e = 1 - [Math]::Pow(1 - $t, 2)
    $cx = [int][Math]::Round($start[0] + ($X - $start[0]) * $e)
    $cy = [int][Math]::Round($start[1] + ($Y - $start[1]) * $e)
    [void][PcNative]::MoveCursor($cx, $cy)
    Start-Sleep -Milliseconds ([int][Math]::Max(1, $DurationMs / $steps))
  }
  [void][PcNative]::MoveCursor($X, $Y)
}

function Get-ButtonFlags {
  param([string]$Button)
  switch ($Button.Trim().ToLowerInvariant()) {
    'left'   { return @{ down = 0x0002; up = 0x0004 } }
    'right'  { return @{ down = 0x0008; up = 0x0010 } }
    'middle' { return @{ down = 0x0020; up = 0x0040 } }
    default  { throw "unknown mouse button: $Button" }
  }
}

function Invoke-ClickOnce {
  param([string]$Button, [int]$HoldMs = 0)
  $flags = Get-ButtonFlags -Button $Button
  [void][PcNative]::MouseButton([uint32]$flags.down)
  if ($HoldMs -gt 0) { Start-Sleep -Milliseconds $HoldMs }
  [void][PcNative]::MouseButton([uint32]$flags.up)
}

function Get-ClipboardText {
  try {
    return [System.Windows.Forms.Clipboard]::GetText()
  } catch {
    return $null
  }
}

function Set-ClipboardText {
  param([string]$Text)
  $last = ''
  for ($i = 0; $i -lt 3; $i++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($Text)
      return @{ ok = $true; error = '' }
    } catch {
      $last = $_.Exception.GetType().Name + ': ' + $_.Exception.Message
      Start-Sleep -Milliseconds 100
    }
  }
  return @{ ok = $false; error = $last }
}

function Invoke-TypeText {
  param([string]$Text, [int]$IntervalMs = 0)
  foreach ($ch in $Text.ToCharArray()) {
    if (Test-Abort) { return $false }
    [void][PcNative]::UnicodeChar($ch, $false)
    [void][PcNative]::UnicodeChar($ch, $true)
    if ($IntervalMs -gt 0) { Start-Sleep -Milliseconds $IntervalMs }
  }
  return $true
}

function Invoke-ScrollWheel {
  param([int]$Delta, [int]$Times, [int]$IntervalMs = 60)
  if ($Times -lt 1) { $Times = 1 }
  for ($i = 0; $i -lt $Times; $i++) {
    if (Test-Abort) { return $false }
    [void][PcNative]::MouseWheel($Delta, $false)
    if ($IntervalMs -gt 0) { Start-Sleep -Milliseconds $IntervalMs }
  }
  return $true
}

function Invoke-Hotkey {
  param([string[]]$Keys)
  $vks = @()
  foreach ($k in $Keys) { $vks += (Resolve-Vk -Key $k) }
  $held = @()
  try {
    foreach ($vk in $vks) {
      [void][PcNative]::KeyDown($vk)
      $held += $vk
      Start-Sleep -Milliseconds 18
    }
  } finally {
    for ($i = $held.Count - 1; $i -ge 0; $i--) {
      [void][PcNative]::KeyUp($held[$i])
      Start-Sleep -Milliseconds 12
    }
  }
}

function Wait-Polled {
  param([int]$Ms)
  if ($Ms -le 0) { return @{ ok = $true } }
  $deadline = [Environment]::TickCount + $Ms
  while ([Environment]::TickCount -lt $deadline) {
    if (Test-Abort) { return (New-Abort) }
    $left = $deadline - [Environment]::TickCount
    if ($left -le 0) { break }
    Start-Sleep -Milliseconds ([int][Math]::Min(100, $left))
  }
  return @{ ok = $true }
}

function Get-ScreenInfo {
  $m = [PcNative]::Metrics()
  $row = Get-ForegroundWindowRow
  return [ordered]@{
    width      = $m[0]
    height     = $m[1]
    virtual    = [ordered]@{ x = $m[2]; y = $m[3]; width = $m[4]; height = $m[5] }
    monitors   = $m[6]
    dpiAware   = $script:DpiAware
    cursor     = [ordered]@{ x = ([PcNative]::CursorPosition())[0]; y = ([PcNative]::CursorPosition())[1] }
    foreground = $row
    agent      = [ordered]@{
      pid     = $PID
      started = $script:AgentStart.ToString('o')
      uptimeS = [int]((Get-Date) - $script:AgentStart).TotalSeconds
      os      = [Environment]::OSVersion.VersionString
    }
  }
}

function Invoke-Command {
  param([string]$Cmd, $Payload)

  # `$args` is an automatic variable, so parameters must never be bound to it:
  # doing so silently discards the request body and every command sees null.
  $a = $Payload
  if ($a -eq $null) { $a = [pscustomobject]@{} }

  switch ($Cmd) {
    'ping' {
      return @{ ok = $true; data = [ordered]@{ pong = $true; pid = $PID; dpiAware = $script:DpiAware; inputSize = [PcNative]::InputSize() } }
    }
    'screen_info' {
      return @{ ok = $true; data = (Get-ScreenInfo) }
    }
    'screenshot' {
      $mode = 'screen'
      if ($a.PSObject.Properties['mode'] -and $a.mode) { $mode = [string]$a.mode }
      $maxWidth = 1280
      if ($a.PSObject.Properties['max_width'] -and $a.max_width) { $maxWidth = [int]$a.max_width }
      $path = New-ShotPath
      if ($mode -eq 'window') {
        if (-not $a.PSObject.Properties['window'] -or -not $a.window) { $w = Get-ForegroundWindowRow } else { $w = Resolve-Window -Spec ([string]$a.window) }
        $size = Invoke-CaptureWindow -Hwnd ([long]$w.hwnd) -Path $path -MaxWidth $maxWidth
        return @{ ok = $true; data = [ordered]@{ path = $path; width = $size.width; height = $size.height; mode = 'window'; window = $w } }
      }
      $m = [PcNative]::Metrics()
      $x = $m[2]; $y = $m[3]; $wpx = $m[4]; $hpx = $m[5]
      if ($mode -eq 'region') {
        if (-not ($a.PSObject.Properties['x'] -and $a.PSObject.Properties['y'] -and $a.PSObject.Properties['width'] -and $a.PSObject.Properties['height'])) {
          throw 'region capture needs x, y, width, height'
        }
        $x = [int]$a.x; $y = [int]$a.y; $wpx = [int]$a.width; $hpx = [int]$a.height
      }
      $size = Invoke-CaptureScreen -X $x -Y $y -W $wpx -H $hpx -Path $path -MaxWidth $maxWidth
      return @{ ok = $true; data = [ordered]@{ path = $path; width = $size.width; height = $size.height; mode = $mode; region = [ordered]@{ x = $x; y = $y; width = $wpx; height = $hpx } } }
    }
    'cursor' {
      $p = [PcNative]::CursorPosition()
      return @{ ok = $true; data = [ordered]@{ x = $p[0]; y = $p[1]; foreground = (Get-ForegroundWindowRow) } }
    }
    'move' {
      if (Test-Abort) { return (New-Abort) }
      $dur = 0
      if ($a.PSObject.Properties['duration_ms']) { $dur = [int]$a.duration_ms }
      Invoke-MoveTo -X ([int]$a.x) -Y ([int]$a.y) -DurationMs $dur
      return @{ ok = $true; data = [ordered]@{ x = [int]$a.x; y = [int]$a.y; duration_ms = $dur } }
    }
    'click' {
      if (Test-Abort) { return (New-Abort) }
      if ($a.PSObject.Properties['x'] -and $a.PSObject.Properties['y']) {
        Invoke-MoveTo -X ([int]$a.x) -Y ([int]$a.y) -DurationMs 0
      }
      $button = 'left'
      if ($a.PSObject.Properties['button'] -and $a.button) { $button = [string]$a.button }
      $count = 1
      if ($a.PSObject.Properties['count'] -and $a.count) { $count = [int]$a.count }
      $interval = 90
      if ($a.PSObject.Properties['interval_ms']) { $interval = [int]$a.interval_ms }
      for ($i = 0; $i -lt $count; $i++) {
        if (Test-Abort) { return (New-Abort) }
        Invoke-ClickOnce -Button $button
        if ($i -lt ($count - 1)) { Start-Sleep -Milliseconds $interval }
      }
      $p = [PcNative]::CursorPosition()
      return @{ ok = $true; data = [ordered]@{ x = $p[0]; y = $p[1]; button = $button; count = $count; foreground = (Get-ForegroundWindowRow) } }
    }
    'drag' {
      if (Test-Abort) { return (New-Abort) }
      $flags = Get-ButtonFlags -Button $(if ($a.PSObject.Properties['button'] -and $a.button) { [string]$a.button } else { 'left' })
      $dur = 400
      if ($a.PSObject.Properties['duration_ms']) { $dur = [int]$a.duration_ms }
      Invoke-MoveTo -X ([int]$a.x1) -Y ([int]$a.y1) -DurationMs 0
      Start-Sleep -Milliseconds 60
      [void][PcNative]::MouseButton([uint32]$flags.down)
      Start-Sleep -Milliseconds 80
      Invoke-MoveTo -X ([int]$a.x2) -Y ([int]$a.y2) -DurationMs $dur
      Start-Sleep -Milliseconds 80
      [void][PcNative]::MouseButton([uint32]$flags.up)
      return @{ ok = $true; data = [ordered]@{ from = [ordered]@{ x = [int]$a.x1; y = [int]$a.y1 }; to = [ordered]@{ x = [int]$a.x2; y = [int]$a.y2 }; button = [string]$a.button; duration_ms = $dur } }
    }
    'scroll' {
      if (Test-Abort) { return (New-Abort) }
      if ($a.PSObject.Properties['x'] -and $a.PSObject.Properties['y']) {
        Invoke-MoveTo -X ([int]$a.x) -Y ([int]$a.y) -DurationMs 0
        Start-Sleep -Milliseconds 40
      }
      $delta = -120
      if ($a.PSObject.Properties['delta']) { $delta = [int]$a.delta }
      $times = 1
      if ($a.PSObject.Properties['times']) { $times = [int]$a.times }
      $interval = 60
      if ($a.PSObject.Properties['interval_ms']) { $interval = [int]$a.interval_ms }
      $okScroll = Invoke-ScrollWheel -Delta $delta -Times $times -IntervalMs $interval
      if (-not $okScroll) { return (New-Abort) }
      return @{ ok = $true; data = [ordered]@{ delta = $delta; times = $times; foreground = (Get-ForegroundWindowRow) } }
    }
    'type' {
      if (Test-Abort) { return (New-Abort) }
      $text = [string]$a.text
      if ([string]::IsNullOrEmpty($text)) { throw 'text is required' }
      $interval = 0
      if ($a.PSObject.Properties['interval_ms']) { $interval = [int]$a.interval_ms }
      $done = Invoke-TypeText -Text $text -IntervalMs $interval
      if (-not $done) { return (New-Abort) }
      return @{ ok = $true; data = [ordered]@{ chars = $text.Length } }
    }
    'key' {
      if (Test-Abort) { return (New-Abort) }
      $vk = Resolve-Vk -Key ([string]$a.key)
      $times = 1
      if ($a.PSObject.Properties['times']) { $times = [int]$a.times }
      $interval = 60
      if ($a.PSObject.Properties['interval_ms']) { $interval = [int]$a.interval_ms }
      for ($i = 0; $i -lt $times; $i++) {
        [void][PcNative]::KeyDown($vk)
        Start-Sleep -Milliseconds 35
        [void][PcNative]::KeyUp($vk)
        if ($i -lt ($times - 1)) { Start-Sleep -Milliseconds $interval }
      }
      return @{ ok = $true; data = [ordered]@{ key = [string]$a.key; vk = $vk; times = $times } }
    }
    'hotkey' {
      if (Test-Abort) { return (New-Abort) }
      $keys = @($a.keys)
      if ($keys.Count -lt 1) { throw 'keys must list at least one key name' }
      Invoke-Hotkey -Keys $keys
      return @{ ok = $true; data = [ordered]@{ keys = $keys } }
    }
    'windows' {
      $rows = Get-WindowRows
      if ($a.PSObject.Properties['filter'] -and $a.filter) {
        $needle = [string]$a.filter
        $rows = $rows | Where-Object { $_.title -like "*$needle*" }
      }
      $fg = [PcNative]::ForegroundWindow()
      foreach ($r in $rows) { $r['foreground'] = ($r.hwnd -eq $fg) }
      return @{ ok = $true; data = [ordered]@{ windows = @($rows); foreground = $fg } }
    }
    'window_info' {
      if (-not $a.PSObject.Properties['window']) { throw 'window_info needs a window handle' }
      return @{ ok = $true; data = (Resolve-Window -Spec ([string]$a.window)) }
    }
    'focus' {
      if (Test-Abort) { return (New-Abort) }
      $w = Resolve-Window -Spec ([string]$a.window)
      $okFocus = [PcNative]::Activate([long]$w.hwnd)
      Start-Sleep -Milliseconds 180
      $now = Get-ForegroundWindowRow
      return @{ ok = $true; data = [ordered]@{ requested = $w; active = $now; activated = ($now.hwnd -eq $w.hwnd); api = $okFocus } }
    }
    'launch' {
      if (Test-Abort) { return (New-Abort) }
      $target = [string]$a.target
      if ([string]::IsNullOrWhiteSpace($target)) { throw 'target is required' }
      $argList = @()
      if ($a.PSObject.Properties['args'] -and $a.args) { $argList = @($a.args) }
      if ($argList.Count -gt 0) {
        Start-Process -FilePath $target -ArgumentList $argList | Out-Null
      } else {
        Start-Process -FilePath $target | Out-Null
      }
      return @{ ok = $true; data = [ordered]@{ target = $target; args = $argList } }
    }
    'clipboard_get' {
      $text = Get-ClipboardText
      if ($text -eq $null) { throw 'clipboard is empty or inaccessible' }
      return @{ ok = $true; data = [ordered]@{ text = $text; length = $text.Length } }
    }
    'clipboard_set' {
      $text = [string]$a.text
      if ([string]::IsNullOrEmpty($text)) { throw 'text must not be empty' }
      $done = Set-ClipboardText -Text $text
      if (-not $done.ok) { throw ('clipboard write failed: ' + $done.error) }
      return @{ ok = $true; data = [ordered]@{ length = $text.Length } }
    }
    'wait' {
      $ms = [int]$a.ms
      return (Wait-Polled -Ms $ms)
    }
    'panic' {
      $script:Stopped = $true
      return @{ ok = $true; data = [ordered]@{ stopped = $true } }
    }
    'resume' {
      $script:Stopped = $false
      return @{ ok = $true; data = [ordered]@{ stopped = $false } }
    }
    default {
      throw "unknown command: $Cmd"
    }
  }
}

# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------
$script:StdOut.WriteLine('{"id":0,"ok":true,"data":{"ready":true,"pid":' + $PID + ',"dpiAware":' + $script:DpiAware.ToString().ToLowerInvariant() + ',"inputSize":' + [PcNative]::InputSize() + '}}')
$script:StdOut.Flush()

while ($true) {
  $line = $script:StdIn.ReadLine()
  if ($line -eq $null) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  $id = 0
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $cmd = [string]$request.cmd
    $result = Invoke-Command -Cmd $cmd -Payload $request.args
    if ($result -eq $null) { $result = @{ ok = $true; data = @{} } }
    if ($result.ContainsKey('ok') -and -not $result.ok) {
      $payload = [ordered]@{ id = $id; ok = $false; code = $result.code; error = $result.error }
    } else {
      $payload = [ordered]@{ id = $id; ok = $true; data = $result.data }
    }
  } catch {
    $payload = [ordered]@{ id = $id; ok = $false; code = 'ERROR'; error = $_.Exception.Message }
  }

  try {
    $json = $payload | ConvertTo-Json -Compress -Depth 10
  } catch {
    $json = '{"id":' + $id + ',"ok":false,"code":"ERROR","error":"failed to serialize result"}'
  }
  $script:StdOut.WriteLine($json)
  $script:StdOut.Flush()
}
