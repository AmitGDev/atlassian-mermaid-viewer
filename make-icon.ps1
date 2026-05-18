$asset  = "assets/icon.svg"
$outDir = "icons"

$svg     = [xml](Get-Content $asset)
$svgSize = [int]$svg.svg.GetAttribute("width")
$svgRx   = [int]$svg.svg.rect.rx
$bgColor = $svg.svg.rect.fill

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Export-Icon {
    param([string]$Src, [int]$W, [int]$H, [string]$Dest)
    $rx = [int]($svgRx * $W / $svgSize)
    magick `
        "(" $Src -background $bgColor -resize "${W}x${H}" ")" `
        "(" -size "${W}x${H}" xc:none -fill white `
            -draw "roundrectangle 0,0,$($W-1),$($H-1),$rx,$rx" ")" `
        -compose DstIn -composite `
        $Dest
}

$sizes = 16, 32, 48, 128
foreach ($s in $sizes) {
    Export-Icon -Src $asset -W $s -H $s -Dest "$outDir/icon${s}.png"
}

# Padded Chrome Web Store icon: 96x96 artwork centred in 128x128 transparent canvas.
$paddedSize = 128
$innerSize  = 96
$rx = [int]($svgRx * $innerSize / $svgSize)

magick `
    "(" $asset -background $bgColor -resize "${innerSize}x${innerSize}" `
               -background none -gravity center -extent "${paddedSize}x${paddedSize}" ")" `
    "(" -size "${innerSize}x${innerSize}" xc:none -fill white `
        -draw "roundrectangle 0,0,$($innerSize-1),$($innerSize-1),$rx,$rx" `
        -background none -gravity center -extent "${paddedSize}x${paddedSize}" ")" `
    -compose DstIn -composite `
    "$outDir/icon128-padded.png"
