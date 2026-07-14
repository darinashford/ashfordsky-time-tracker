import { execFile } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export interface OcrResult {
  text: string;
  confidence?: number;
}

export interface OcrAdapter {
  readonly name: string;
  recognize(buffer: Buffer): Promise<OcrResult | null>;
}

/**
 * On-device OCR via Windows.Media.Ocr (no deps, no cloud, private). Writes the
 * image to a temp file and recognizes it through Windows PowerShell 5.1 (WinRT
 * projection is reliable there). Returns null on no text / failure.
 */
export class WindowsOcrAdapter implements OcrAdapter {
  readonly name = 'windows-media-ocr';

  async recognize(buffer: Buffer): Promise<OcrResult | null> {
    const path = join(tmpdir(), `tt-ocr-${randomUUID()}.png`);
    await writeFile(path, buffer);
    const ps =
      "$ErrorActionPreference='Stop';" +
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null;' +
      "$at=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0];" +
      'function Await($t,$rt){$m=$at.MakeGenericMethod($rt);$n=$m.Invoke($null,@($t));$n.Wait(-1)|Out-Null;$n.Result}' +
      '$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];' +
      '$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime];' +
      '$null=[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime];' +
      "$f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('" +
      path +
      "')) ([Windows.Storage.StorageFile]);" +
      '$st=Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]);' +
      '$dc=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($st)) ([Windows.Graphics.Imaging.BitmapDecoder]);' +
      '$sb=Await ($dc.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap]);' +
      '$en=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();' +
      'if(-not $en){exit 3};' +
      '$r=Await ($en.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult]);' +
      '[Console]::Out.Write($r.Text)';
    try {
      const { stdout } = await pExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const text = (stdout ?? '').trim();
      return text ? { text } : null;
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }
}

export class NoopOcrAdapter implements OcrAdapter {
  readonly name = 'noop';
  async recognize(): Promise<OcrResult | null> {
    return null;
  }
}

export function createOcrAdapter(): OcrAdapter {
  return process.platform === 'win32' ? new WindowsOcrAdapter() : new NoopOcrAdapter();
}
