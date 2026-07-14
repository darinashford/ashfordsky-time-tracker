# OCR self-test: render a realistic inbox pane to an image, then OCR it with the
# same Windows.Media.Ocr path the sidecar uses. Verifies engine + email reading
# WITHOUT needing screen capture (which is black in headless/agent contexts).
$ErrorActionPreference = 'Stop'

# 1) draw a synthetic inbox image
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1000, 360
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$font = New-Object System.Drawing.Font('Segoe UI', 22)
$bold = New-Object System.Drawing.Font('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
$black = [System.Drawing.Brushes]::Black
$g.DrawString('Inbox  -  Ashford Sky', $font, $black, 20, 20)
$g.DrawString('From: Morgan Lee <morgan@widgetco.example>', $bold, $black, 20, 90)
$g.DrawString('Subject: Q2 bookkeeping questions', $font, $black, 20, 160)
$g.DrawString('Hi Darin, attached are the Q2 files for your review.', $font, $black, 20, 230)
$g.Flush()
$path = Join-Path $env:TEMP ('ocr-selftest-' + [guid]::NewGuid().ToString() + '.png')
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 2) OCR it (same engine path as the sidecar)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($t, $rt) { $m = $asTaskGeneric.MakeGenericMethod($rt); $n = $m.Invoke($null, @($t)); $n.Wait(-1) | Out-Null; $n.Result }
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$sb = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
Remove-Item $path -ErrorAction SilentlyContinue
$res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
Write-Output '---- OCR TEXT ----'
Write-Output $res.Text