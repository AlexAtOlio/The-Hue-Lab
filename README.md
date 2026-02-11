# Hue Lab

A compositional color palette generator with perceptual color science, CMYK gamut awareness, and WCAG contrast validation.

## Features

### Hue Room (Left Panel)
- **Branching harmony system**: Up to 3 levels of nested color relationships
- **Harmony modes**: Equidistant, analogous, complementary, split-complementary, triadic, tetradic
- **Key color input**: HEX and RGB with full precision preservation
- **Global rotation**: Rotate entire palette around the color wheel
- **CMYK gamut overlay**: Visual boundary showing print-safe colors

### Hue Lab (Right Panel)
- **Per-color adjustments**: Saturation and lightness fine-tuning
- **Contrast locks**: Lock colors to hit specific WCAG contrast ratios (3:1, 4.5:1, 7:1)
- **Value scales**: Perceptually uniform lightness scales anchored to base color
- **Linked/unlinked workflow**: Colors can track Room changes or be edited independently
- **CMYK validation**: Always-on gamut checking with overshoot percentage

### Color Science
- **OKLab/OKLCH**: Perceptually uniform color space for accurate operations
- **Delta E**: Perceptual color difference for gamut verification
- **CMYK round-trip verification**: Dual check using chroma limits AND conversion accuracy
- **WCAG 2.1 contrast**: Relative luminance calculations per spec

## Development

```bash
npm install
npm run dev
```

## Architecture

### Contrast Lock System
Contrast locks are constraints, not values. When you lock a color to "4.5:1 on white":
- The system solves for the L value that achieves that ratio
- If the hue changes (from Room), L is recalculated to maintain the ratio
- The value scale regenerates around the new base

### Linked vs Unlinked
- **Linked (default)**: Color tracks Room changes (harmony rotation, key color)
- **Unlinked**: Color becomes independent snapshot; Room changes don't propagate

### Value Scale Anchoring
- Middle swatch = base color (at contrast-locked L if applicable)
- Scale spreads symmetrically in perceptual lightness
- Uses OKLab for perceptually uniform steps

## Export Formats
- **HEX**: Simple hex codes
- **CSS**: CSS custom properties with CMYK and contrast comments
- **JSON**: Full color data including RGB, CMYK, contrast ratios
- **Design Tokens**: W3C Design Tokens format
- **CMYK**: Print-ready CMYK values with gamut warnings

## Accuracy Notes
CMYK gamut analysis uses OKLab perceptual approximation. This catches obvious out-of-gamut colors (saturated blues, neons) but is not a replacement for ICC profile-based soft proofing in production software. The goal is "don't fall in love with a color you can't print" — final verification should happen in Photoshop/Illustrator/InDesign.
