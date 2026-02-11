# CLAUDE.md - Project Context for Claude Code

## Project Overview
Hue Lab is a compositional color palette generator built with React. It emphasizes perceptual color science (OKLab/OKLCH), CMYK print gamut awareness, and WCAG accessibility compliance.

## Key Files
- `src/HueLab.jsx` - Main component (all-in-one, ~2200 lines)
- `src/main.jsx` - React entry point
- `index.html` - HTML shell
- `vite.config.js` - Vite dev server config

## Architecture Decisions

### Single-file component
Currently monolithic by design for artifact rendering compatibility. Consider splitting into:
- `utils/color.js` - Color conversion functions (OKLab, HSL, CMYK)
- `utils/contrast.js` - WCAG contrast calculations and solver
- `utils/harmony.js` - Harmony mode calculations
- `components/` - UI components

### Color Spaces
- **Working space**: HSL (for sliders, user mental model)
- **Perceptual operations**: OKLab/OKLCH (for gamut mapping, value scales, delta E)
- **Export**: RGB, HEX, CMYK

### State Model
```
keyColor: { h, s, l }           // Room anchor
branches: []                     // Harmony structure
colorOverrides: { [id]: {...} } // Per-color adjustments
unlinkedColors: { [id]: {...} } // Independent colors
contrastLocks: { [id]: {...} }  // Contrast constraints
```

### Contrast Lock Flow
1. User sets lock: "4.5:1 on white"
2. `solveForContrast(h, s, target, bg)` finds L
3. L applied non-destructively (recalculates if H changes)
4. Value scale regenerates around new base

## Known Limitations
- CMYK gamut is approximated (no ICC profiles)
- No undo/redo
- No persistence (state lost on refresh)
- Mobile UI not optimized

## Development Commands
```bash
npm install    # Install dependencies
npm run dev    # Start dev server (localhost:3000)
npm run build  # Production build to dist/
```

## Testing Notes
Test contrast locks by:
1. Creating a saturated color
2. Applying contrast lock (4.5:1 on white)
3. Changing the hue in Room
4. Verifying L recalculates to maintain ratio

Test gamut by:
1. Selecting a saturated blue (H~240, S~100, L~50)
2. Checking for out-of-gamut warning
3. Enabling CMYK mode to see mapped color
