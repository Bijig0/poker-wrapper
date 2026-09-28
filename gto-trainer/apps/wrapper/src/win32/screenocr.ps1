# Windows' own OCR (Windows.Media.Ocr) WITH LINE BOXES, as a long-lived helper for the ClubGG screen reader
# (src/sites/cggOcr.ts). ocr.ps1 (the CoinPoker presses) answers text only; the screen reader needs where each line is.
# Protocol: one JSON request per stdin line, one JSON reply per stdout line.
#   {"op":"ocr","raw":"<path>","w":W,"h":H}      raw = W*H*4 bytes BGRA8, top-down (what GetDIBits gives)
#     -> {"lines":[{"text":"...","words":[[x,y,w,h,"text"],...]},...],"ms":N}
#   {"op":"decode","path":"<image>","out":"<path>"} any image System.Drawing reads (jpg/png/bmp) -> raw BGRA8 at out
#     -> {"w":W,"h":H}
# Errors answer {"error":"..."}. Kept ASCII: PowerShell 5.1 reads a BOM-less script as ANSI.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
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
    $req = ConvertFrom-Json $line
    if ($req.op -eq 'ocr') {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $bytes = [System.IO.File]::ReadAllBytes($req.raw)
      $buf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
      $bmp = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buf, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [int]$req.w, [int]$req.h)
      $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($l in $res.Lines) {
        $words = @()
        foreach ($wd in $l.Words) {
          $r = $wd.BoundingRect
          $words += , @([math]::Round($r.X, 1), [math]::Round($r.Y, 1), [math]::Round($r.Width, 1), [math]::Round($r.Height, 1), $wd.Text)
        }
        $lines += @{ text = $l.Text; words = $words }
      }
      $bmp.Dispose()
      [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 5 -InputObject @{ lines = $lines; ms = $sw.ElapsedMilliseconds }))
    } elseif ($req.op -eq 'decode') {
      $img = [System.Drawing.Bitmap]::FromFile($req.path)
      try {
        $rect = New-Object System.Drawing.Rectangle 0, 0, $img.Width, $img.Height
        $data = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $n = $img.Width * 4
        $out = New-Object byte[] ($n * $img.Height)
        for ($y = 0; $y -lt $img.Height; $y++) {
          [System.Runtime.InteropServices.Marshal]::Copy([IntPtr]($data.Scan0.ToInt64() + $y * $data.Stride), $out, $y * $n, $n)
        }
        $img.UnlockBits($data)
        [System.IO.File]::WriteAllBytes($req.out, $out)
        [Console]::Out.WriteLine('{"w":' + $img.Width + ',"h":' + $img.Height + '}')
      } finally { $img.Dispose() }
    } else {
      [Console]::Out.WriteLine('{"error":"unknown op"}')
    }
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ error = "$($_.Exception.Message)" }))
  }
  [Console]::Out.Flush()
}
