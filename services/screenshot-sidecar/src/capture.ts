import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export interface CaptureResult {
  buffer: Buffer;
  width: number | null;
  height: number | null;
}

export interface ScreenCapturer {
  readonly name: string;
  capture(): Promise<CaptureResult | null>;
}

/**
 * Captures the ACTIVE WINDOW on Windows via .NET/user32 (no native deps).
 * Only the window you're working in is captured — not the other monitors —
 * which keeps the OCR clean (no cross-screen bleed), the files small, and
 * matches what people expect a work screenshot to be. Falls back to the full
 * virtual screen only if the foreground window can't be resolved.
 */
export class WindowsPowerShellCapturer implements ScreenCapturer {
  readonly name = 'windows-powershell';

  async capture(): Promise<CaptureResult | null> {
    const out = join(tmpdir(), `tt-shot-${randomUUID()}.png`);
    const ps =
      "$ErrorActionPreference='Stop';" +
      'Add-Type -AssemblyName System.Windows.Forms;' +
      'Add-Type -AssemblyName System.Drawing;' +
      // DPI awareness so the rect is in physical pixels on scaled monitors.
      "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class TTWin{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L;public int T;public int R;public int B;}}';" +
      '[TTWin]::SetProcessDPIAware()|Out-Null;' +
      '$h=[TTWin]::GetForegroundWindow();' +
      '$r=New-Object TTWin+RECT;' +
      '$ok=($h -ne [IntPtr]::Zero) -and [TTWin]::GetWindowRect($h,[ref]$r);' +
      '$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen;' +
      'if($ok){' +
      // Clamp to the virtual screen (maximized windows overhang by the border).
      '$x=[Math]::Max($r.L,$vs.X);$y=[Math]::Max($r.T,$vs.Y);' +
      '$x2=[Math]::Min($r.R,$vs.X+$vs.Width);$y2=[Math]::Min($r.B,$vs.Y+$vs.Height);' +
      '$w=$x2-$x;$hh=$y2-$y;' +
      'if($w -lt 60 -or $hh -lt 60){$x=$vs.X;$y=$vs.Y;$w=$vs.Width;$hh=$vs.Height}' +
      '}else{$x=$vs.X;$y=$vs.Y;$w=$vs.Width;$hh=$vs.Height};' +
      '$bmp=New-Object System.Drawing.Bitmap($w,$hh);' +
      '$g=[System.Drawing.Graphics]::FromImage($bmp);' +
      '$g.CopyFromScreen($x,$y,0,0,$bmp.Size);' +
      `$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png);` +
      '$g.Dispose();$bmp.Dispose();' +
      "Write-Output ('{0}x{1}' -f $w,$hh)";
    try {
      const { stdout } = await pExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        timeout: 20_000,
      });
      const buffer = await readFile(out);
      await unlink(out).catch(() => undefined);
      const m = /(\d+)x(\d+)/.exec(stdout.trim());
      return { buffer, width: m ? Number(m[1]) : null, height: m ? Number(m[2]) : null };
    } catch (err) {
      await unlink(out).catch(() => undefined);
      throw err;
    }
  }
}

/** Used on non-Windows platforms / when capture should be skipped. */
export class NoopCapturer implements ScreenCapturer {
  readonly name = 'noop';
  async capture(): Promise<CaptureResult | null> {
    return null;
  }
}

export function createCapturer(): ScreenCapturer {
  return process.platform === 'win32' ? new WindowsPowerShellCapturer() : new NoopCapturer();
}
