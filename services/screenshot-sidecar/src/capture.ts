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

/** Captures the full virtual screen on Windows via .NET (no native deps). */
export class WindowsPowerShellCapturer implements ScreenCapturer {
  readonly name = 'windows-powershell';

  async capture(): Promise<CaptureResult | null> {
    const out = join(tmpdir(), `tt-shot-${randomUUID()}.png`);
    const ps =
      "$ErrorActionPreference='Stop';" +
      'Add-Type -AssemblyName System.Windows.Forms;' +
      'Add-Type -AssemblyName System.Drawing;' +
      '$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen;' +
      '$bmp=New-Object System.Drawing.Bitmap($vs.Width,$vs.Height);' +
      '$g=[System.Drawing.Graphics]::FromImage($bmp);' +
      '$g.CopyFromScreen($vs.X,$vs.Y,0,0,$bmp.Size);' +
      `$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png);` +
      '$g.Dispose();$bmp.Dispose();' +
      "Write-Output ('{0}x{1}' -f $vs.Width,$vs.Height)";
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
