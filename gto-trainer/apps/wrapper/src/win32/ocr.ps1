# Windows' own OCR (Windows.Media.Ocr), as a long-lived helper for the Poker Wrapper (src/ocr.ts).
# Protocol: one request per stdin line, "<width> <height> <base64 RGBA8 pixels>"; one JSON reply per line,
# {"lines":["..."]} or {"error":"..."}. Kept running so a press pays for the OCR, not for starting PowerShell.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en'))
[Console]::Out.WriteLine('{"ready":' + $(if ($engine) { 'true' } else { 'false' }) + '}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $parts = $line.Split(' ')
    $w = [int]$parts[0]; $h = [int]$parts[1]
    $bytes = [Convert]::FromBase64String($parts[2])
    $buf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
    $bmp = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buf, [Windows.Graphics.Imaging.BitmapPixelFormat]::Rgba8, $w, $h)
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($res.Lines | ForEach-Object { $_.Text })
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ lines = $lines }))
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ error = "$($_.Exception.Message)" }))
  }
  [Console]::Out.Flush()
}
