# 生成 PWA 图标：红底圆角 + 白色 "T"
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$outPath) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  # 圆角矩形背景（iOS 会再裁一层圆角，这里留少量圆角即可）
  $radius = [int]($size * 0.18)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $brushBg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect, [System.Drawing.Color]::FromArgb(255, 235, 66, 54),
    [System.Drawing.Color]::FromArgb(255, 200, 30, 45), 60)
  $g.FillPath($brushBg, $path)

  # 白色大 T
  $font = New-Object System.Drawing.Font('Arial', [int]($size * 0.52), [System.Drawing.FontStyle]::Bold, 'Pixel')
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $brushT = [System.Drawing.Brushes]::White
  $g.DrawString('T', $font, $brushT, (New-Object System.Drawing.RectangleF(0, ($size * -0.02), $size, $size)), $fmt)

  # 底部小字标记涨跌配色（两个小方块：红、绿）
  $sq = [int]($size * 0.07)
  $y = [int]($size * 0.78)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)), [int]($size * 0.36), $y, $sq, $sq)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 130, 230, 170))), [int]($size * 0.36) + $sq + [int]($size * 0.04), $y, $sq, $sq)

  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "saved $outPath"
}

$dir = Join-Path $PSScriptRoot '..\icons'
New-Icon 512 (Join-Path $dir 'icon-512.png')
New-Icon 180 (Join-Path $dir 'icon-180.png')
