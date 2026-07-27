# Generates packaging\awi-resolve.ico (the AWI Resolve "Repair Loop" mark) at the
# sizes Windows uses for shortcuts, the taskbar and the tray. Redraws the mark
# with GDI+ at each size so small sizes stay crisp, then packs PNG frames into
# a single .ico (PNG-in-ICO is supported on Vista+).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$out   = Join-Path $PSScriptRoot 'awi-resolve.ico'
$sizes = 256, 64, 48, 32, 16

# Convert a bitmap to an uncompressed DIB icon frame (BITMAPINFOHEADER + BGRA
# rows bottom-up + AND mask). Used for sizes <= 64 for maximum compatibility;
# 256 stays PNG-compressed, as is conventional.
function ConvertTo-DibFrame([System.Drawing.Bitmap]$bmp) {
  $W = $bmp.Width; $H = $bmp.Height
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $maskRow = [int][Math]::Floor((($W + 31) / 32)) * 4
  $bw.Write([UInt32]40); $bw.Write([Int32]$W); $bw.Write([Int32]($H * 2))
  $bw.Write([UInt16]1);  $bw.Write([UInt16]32); $bw.Write([UInt32]0)
  $bw.Write([UInt32](($W * $H * 4) + ($maskRow * $H)))
  $bw.Write([Int32]0); $bw.Write([Int32]0); $bw.Write([UInt32]0); $bw.Write([UInt32]0)
  for ($y = $H - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $W; $x++) {
      $c = $bmp.GetPixel($x, $y)
      $bw.Write([Byte]$c.B); $bw.Write([Byte]$c.G); $bw.Write([Byte]$c.R); $bw.Write([Byte]$c.A)
    }
  }
  $bw.Write((New-Object 'Byte[]' ($maskRow * $H)), 0, ($maskRow * $H))   # AND mask (unused with alpha)
  $bw.Flush()
  return ,([byte[]]$ms.ToArray())
}

function New-MarkPng([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $k = $S / 64.0    # design is on a 64x64 grid

  # Brand gradient (blue -> magenta -> orange), corner to corner
  $rect = New-Object System.Drawing.RectangleF(0, 0, $S, $S)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect, [System.Drawing.Color]::FromArgb(0,174,239), [System.Drawing.Color]::FromArgb(244,117,33), 45.0)
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
  $blend.Colors    = @([System.Drawing.Color]::FromArgb(0,174,239),
                       [System.Drawing.Color]::FromArgb(173,32,142),
                       [System.Drawing.Color]::FromArgb(244,117,33))
  $blend.Positions = @(0.0, 0.55, 1.0)
  $brush.InterpolationColors = $blend

  # Repair loop: circle centre (32,32) r=21 -> box (11,11,42,42); 309 deg sweep
  # from -51 deg, leaving the gap at the top-right where the spark sits.
  $stroke = [Math]::Max(2.0, 6.5 * $k)
  $pen = New-Object System.Drawing.Pen($brush, $stroke)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawArc($pen, (11*$k), (11*$k), (42*$k), (42*$k), -51, 309)

  # Automation spark (brand green)
  $green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(156,203,59))
  $r = 4.2 * $k
  $g.FillEllipse($green, (50.5*$k - $r), (12*$k - $r), (2*$r), (2*$r))

  # Resolved tick (navy)
  $navyPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(21,33,59), $stroke)
  $navyPen.StartCap = 'Round'; $navyPen.EndCap = 'Round'; $navyPen.LineJoin = 'Round'
  $pts = @(
    (New-Object System.Drawing.PointF((22.5*$k), (33.2*$k))),
    (New-Object System.Drawing.PointF((29.5*$k), (40.2*$k))),
    (New-Object System.Drawing.PointF((44.0*$k), (25.5*$k)))
  )
  $g.DrawLines($navyPen, $pts)

  $g.Dispose()
  return $bmp
}

# Build the frames, then write the ICO container.
# <=64: uncompressed DIB (widest compatibility). 256: PNG (conventional).
$frames = @{}
foreach ($s in $sizes) {
  $bmp = New-MarkPng $s
  if ($s -ge 256) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames[$s] = [byte[]]$ms.ToArray()
  } else {
    $frames[$s] = ConvertTo-DibFrame $bmp
  }
  $bmp.Dispose()
}

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)   # ICONDIR
$offset = 6 + (16 * $sizes.Count)
foreach ($s in $sizes) {
  $data = $frames[$s]
  $dim = if ($s -ge 256) { 0 } else { $s }                                    # 0 means 256
  $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
  $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($s in $sizes) { $bw.Write([byte[]]$frames[$s], 0, $frames[$s].Length) }
$bw.Flush(); $fs.Close()

Write-Host ("Wrote {0} - {1} frames ({2}), {3} bytes" -f $out, $sizes.Count, ($sizes -join ', '), (Get-Item $out).Length)
