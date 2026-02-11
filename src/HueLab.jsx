import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'

// ============================================================================
// COLOR SPACE CONVERSIONS
// ============================================================================

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r, g, b
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max - min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

function linearize(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function delinearize(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(Math.max(0, Math.min(255, v * 255)))
}

function rgbToOklab(r, g, b) {
  const lr = linearize(r), lg = linearize(g), lb = linearize(b)
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  }
}

function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  return { r: delinearize(lr), g: delinearize(lg), b: delinearize(lb) }
}

function oklabToOklch(L, a, b) {
  return {
    L,
    C: Math.sqrt(a * a + b * b),
    h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
  }
}

function oklchToOklab(L, C, h) {
  const rad = (h * Math.PI) / 180
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) }
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
}

function hexToRgb(hex) {
  hex = hex.replace('#', '')
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

// ============================================================================
// CMYK CONVERSION & GAMUT
// ============================================================================

function rgbToCmyk(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const k = 1 - Math.max(r, g, b)
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 }
  return {
    c: Math.round(((1 - r - k) / (1 - k)) * 100),
    m: Math.round(((1 - g - k) / (1 - k)) * 100),
    y: Math.round(((1 - b - k) / (1 - k)) * 100),
    k: Math.round(k * 100),
  }
}

function cmykToRgb(c, m, y, k) {
  c /= 100; m /= 100; y /= 100; k /= 100
  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k)),
  }
}

function isApproxInCmykGamut(r, g, b) {
  const cmyk = rgbToCmyk(r, g, b)
  const back = cmykToRgb(cmyk.c, cmyk.m, cmyk.y, cmyk.k)
  const dr = Math.abs(r - back.r), dg = Math.abs(g - back.g), db = Math.abs(b - back.b)
  return Math.max(dr, dg, db) <= 2
}

// ============================================================================
// CONTRAST & LUMINANCE (WCAG 2.x)
// ============================================================================

function relativeLuminance(r, g, b) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

function contrastRatio(lum1, lum2) {
  const lighter = Math.max(lum1, lum2)
  const darker = Math.min(lum1, lum2)
  return (lighter + 0.05) / (darker + 0.05)
}

function wcagLevel(ratio) {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA-Large'
  return 'Fail'
}

function wcagLevelColor(level) {
  if (level === 'AAA') return '#22c55e'
  if (level === 'AA') return '#86efac'
  if (level === 'AA-Large') return '#fbbf24'
  return '#ef4444'
}

function solveForContrast(h, s, targetRatio, bgRgb) {
  const bgLum = relativeLuminance(bgRgb.r, bgRgb.g, bgRgb.b)
  let lo = 0, hi = 100, best = 50
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    const rgb = hslToRgb(h, s, mid)
    const fgLum = relativeLuminance(rgb.r, rgb.g, rgb.b)
    const ratio = contrastRatio(fgLum, bgLum)
    if (Math.abs(ratio - targetRatio) < 0.01) return mid
    best = mid
    if (bgLum > fgLum) {
      if (ratio > targetRatio) hi = mid
      else lo = mid
    } else {
      if (ratio > targetRatio) lo = mid
      else hi = mid
    }
  }
  return best
}

// ============================================================================
// APCA CONTRAST (WCAG 3.0 draft — APCA-W3 0.1.9)
// ============================================================================

// Peceptual luminance (Y) using APCA's sRGB coefficients
function apcaLuminance(r, g, b) {
  // Piecewise sRGB linearization with APCA exponent (2.4)
  const f = (v) => { v /= 255; return v <= 0.022 ? v + Math.pow(0.022 - v, 1.414) : Math.pow(v, 2.4) }
  return 0.2126729 * f(r) + 0.7151522 * f(g) + 0.0721750 * f(b)
}

// Returns Lc (lightness contrast) value. Polarity-aware:
//   positive Lc = light text on dark background
//   negative Lc = dark text on light background
// Magnitude is what matters for thresholds.
function apcaContrast(fgRgb, bgRgb) {
  const txtY = apcaLuminance(fgRgb.r, fgRgb.g, fgRgb.b)
  const bgY = apcaLuminance(bgRgb.r, bgRgb.g, bgRgb.b)

  // Clamp to black
  const tY = txtY > 0.022 ? txtY : txtY + Math.pow(0.022 - txtY, 1.414)
  const bY = bgY > 0.022 ? bgY : bgY + Math.pow(0.022 - bgY, 1.414)

  // SAPC power-curve constants
  const normBg = 0.56, normTxt = 0.57
  const revBg = 0.65, revTxt = 0.62
  const blkThrs = 0.022, blkClmp = 1.414
  const scaleBoW = 1.14, scaleWoB = 1.14
  const loBoWoff = 0.027, loWoBoff = 0.027
  const loClip = 0.1

  let Lc = 0

  if (bY > tY) {
    // "Normal" polarity: dark text on light background
    const SAPC = (Math.pow(bY, normBg) - Math.pow(tY, normTxt)) * scaleBoW
    Lc = SAPC < loClip ? 0 : SAPC - loBoWoff
  } else {
    // "Reverse" polarity: light text on dark background
    const SAPC = (Math.pow(bY, revBg) - Math.pow(tY, revTxt)) * scaleWoB
    Lc = SAPC > -loClip ? 0 : SAPC + loWoBoff
  }

  return Lc * 100
}

// APCA "Bronze" conformance levels for body text (~16px)
function apcaLevel(lc) {
  const abs = Math.abs(lc)
  if (abs >= 90) return 'Preferred'
  if (abs >= 75) return 'Body Text'
  if (abs >= 60) return 'Large Text'
  if (abs >= 45) return 'Non-Text'
  if (abs >= 30) return 'Spot/Icon'
  return 'Fail'
}

function apcaLevelColor(level) {
  if (level === 'Preferred') return '#22c55e'
  if (level === 'Body Text') return '#86efac'
  if (level === 'Large Text') return '#60a5fa'
  if (level === 'Non-Text') return '#fbbf24'
  if (level === 'Spot/Icon') return '#fb923c'
  return '#ef4444'
}

// ============================================================================
// DELTA E (OKLab)
// ============================================================================

function deltaE(lab1, lab2) {
  const dL = lab1.L - lab2.L
  const da = lab1.a - lab2.a
  const db = lab1.b - lab2.b
  return Math.sqrt(dL * dL + da * da + db * db)
}

// ============================================================================
// HARMONY MODES
// ============================================================================

const HARMONY_MODES = {
  complementary: { label: 'Complementary', offsets: [180] },
  analogous: { label: 'Analogous', offsets: [-30, 30] },
  triadic: { label: 'Triadic', offsets: [120, 240] },
  'split-complementary': { label: 'Split Comp.', offsets: [150, 210] },
  tetradic: { label: 'Tetradic', offsets: [90, 180, 270] },
  monochromatic: { label: 'Monochromatic', offsets: [] },
}

function getHarmonyColors(h, s, l, mode) {
  const config = HARMONY_MODES[mode]
  if (!config) return []
  return config.offsets.map((offset, i) => ({
    h: (h + offset + 360) % 360,
    s,
    l,
    label: `${config.label} ${i + 1}`,
    offset,
  }))
}

// ============================================================================
// VALUE SCALE GENERATION (OKLab-based perceptual interpolation)
// ============================================================================

const SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

function generateValueScale(h, s, l) {
  const baseRgb = hslToRgb(h, s, l)
  const baseLab = rgbToOklab(baseRgb.r, baseRgb.g, baseRgb.b)
  const baseLch = oklabToOklch(baseLab.L, baseLab.a, baseLab.b)

  return SCALE_STEPS.map(step => {
    const targetL = 1 - step / 1000
    const chromaScale = step <= 500
      ? 0.3 + 0.7 * (step / 500)
      : 0.3 + 0.7 * ((1000 - step) / 500)
    const C = baseLch.C * chromaScale
    const lab = oklchToOklab(targetL, C, baseLch.h)
    let rgb = oklabToRgb(lab.L, lab.a, lab.b)
    rgb = { r: Math.max(0, Math.min(255, rgb.r)), g: Math.max(0, Math.min(255, rgb.g)), b: Math.max(0, Math.min(255, rgb.b)) }
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
    return { step, rgb, hsl, hex: rgbToHex(rgb.r, rgb.g, rgb.b), lab, lch: { L: targetL, C, h: baseLch.h } }
  })
}

// ============================================================================
// COLOR BLINDNESS SIMULATION (Brettel/Viénot matrices)
// ============================================================================

function simulateColorBlindness(r, g, b, type) {
  const lr = linearize(r), lg = linearize(g), lb = linearize(b)
  let sr, sg, sb
  switch (type) {
    case 'protanopia':
      sr = 0.152286 * lr + 1.052583 * lg - 0.204868 * lb
      sg = 0.114503 * lr + 0.786281 * lg + 0.099216 * lb
      sb = -0.003882 * lr - 0.048116 * lg + 1.051998 * lb
      break
    case 'deuteranopia':
      sr = 0.367322 * lr + 0.860646 * lg - 0.227968 * lb
      sg = 0.280085 * lr + 0.672501 * lg + 0.047413 * lb
      sb = -0.011820 * lr + 0.042940 * lg + 0.968881 * lb
      break
    case 'tritanopia':
      sr = 1.255528 * lr - 0.076749 * lg - 0.178779 * lb
      sg = -0.078411 * lr + 0.930809 * lg + 0.147602 * lb
      sb = 0.004733 * lr + 0.691367 * lg + 0.303900 * lb
      break
    default:
      return { r, g, b }
  }
  return {
    r: delinearize(Math.max(0, sr)),
    g: delinearize(Math.max(0, sg)),
    b: delinearize(Math.max(0, sb)),
  }
}

// ============================================================================
// CHEESY COLOR NAME GENERATOR
// ============================================================================

const COLOR_NAMES = {
  red:     ['Salsa Picante', 'Tomato Tango', 'Crimson Kiss', 'Ruby Slipper', 'Hot Tamale', 'Firecracker'],
  orange:  ['Sunset Boulevard', 'Tangerine Dream', 'Marmalade Sky', 'Pumpkin Spice', 'Mango Tango', 'Papaya Whip'],
  yellow:  ['Lemon Drop', 'Banana Pudding', 'Goldilocks', 'Dandelion Wine', 'Buttercup Bliss', 'Taxi Cab'],
  lime:    ['Avocado Toast', 'Pistachio Dream', 'Kermit Couture', 'Wasabi Rush', 'Chartreuse Moose', 'Lime Rickey'],
  green:   ['Jungle Boogie', 'Shamrock Shake', 'Mint Julep', 'Pickle Juice', 'Emerald City', 'Forest Bathing'],
  teal:    ['Ocean Breeze', 'Tidal Pool', 'Mermaid Tears', 'Lagoon Vibes', 'Tropical Chill', 'Sea Glass'],
  cyan:    ['Arctic Chill', 'Frozen Daiquiri', 'Ice Palace', 'Glacier Mint', 'Polar Express', 'Cool Runnings'],
  blue:    ['Midnight Jazz', 'Denim Dreams', 'Blueberry Muffin', 'Royal Decree', 'Deep Blue Sea', 'Blue Monday'],
  indigo:  ['Twilight Zone', 'Velvet Underground', 'Indigo Montoya', 'Cosmic Latte', 'Nebula Nights', 'Ink Well'],
  violet:  ['Grape Escape', 'Purple Rain', 'Plum Crazy', 'Velvet Rope', 'Amethyst Hour', 'Majestic AF'],
  magenta: ['Flamingo Dance', 'Fuchsia Fusion', 'Hot Gossip', 'Disco Inferno', 'Dragonfruit', 'Pink Panther'],
  rose:    ['Bubblegum Pop', 'Cherry Bomb', 'Candy Apple', 'Rose Parade', 'Blushing Bride', 'Cupid Arrow'],
}

const LIGHT_PREFIXES = ['Baby', 'Cotton', 'Pastel', 'Cloud', 'Whisper']
const DARK_PREFIXES = ['Deep', 'Midnight', 'Shadow', 'Dark', 'Obsidian']
const MUTED_PREFIXES = ['Dusty', 'Muted', 'Faded', 'Hazy', 'Foggy']

function generateColorName(h, s, l) {
  h = ((h % 360) + 360) % 360
  let family
  if (h < 15) family = 'red'
  else if (h < 40) family = 'orange'
  else if (h < 65) family = 'yellow'
  else if (h < 90) family = 'lime'
  else if (h < 150) family = 'green'
  else if (h < 175) family = 'teal'
  else if (h < 200) family = 'cyan'
  else if (h < 245) family = 'blue'
  else if (h < 270) family = 'indigo'
  else if (h < 300) family = 'violet'
  else if (h < 335) family = 'magenta'
  else family = 'rose'

  const names = COLOR_NAMES[family]
  const idx = Math.floor((h * 7 + s * 3 + l) % names.length)
  let name = names[idx]

  if (l > 80) {
    const pi = Math.floor((h + l) % LIGHT_PREFIXES.length)
    name = LIGHT_PREFIXES[pi] + ' ' + name.split(' ')[name.split(' ').length - 1]
  } else if (l < 25) {
    const pi = Math.floor((h + l) % DARK_PREFIXES.length)
    name = DARK_PREFIXES[pi] + ' ' + name.split(' ')[name.split(' ').length - 1]
  } else if (s < 20) {
    const pi = Math.floor((h + s) % MUTED_PREFIXES.length)
    name = MUTED_PREFIXES[pi] + ' ' + name.split(' ')[name.split(' ').length - 1]
  }

  return name
}

// ============================================================================
// STATE PERSISTENCE (URL hash)
// ============================================================================

function stateToHash(state) {
  const compact = {
    h: Math.round(state.keyColor.h),
    s: Math.round(state.keyColor.s),
    l: Math.round(state.keyColor.l),
    m: state.harmonyMode,
    cl: state.contrastLocks,
    ov: state.colorOverrides,
    ul: state.unlinkedColors,
    co: state.colorOrder,
    cn: state.colorNames,
  }
  try {
    return '#' + btoa(JSON.stringify(compact))
  } catch {
    return ''
  }
}

function hashToState(hash) {
  if (!hash || hash.length < 2) return null
  try {
    return JSON.parse(atob(hash.slice(1)))
  } catch {
    return null
  }
}

// ============================================================================
// HOOKS
// ============================================================================

function useWindowWidth() {
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

const MAX_HISTORY = 80

function useHistory(initialState) {
  const [present, setPresent] = useState(initialState)
  const pastRef = useRef([])
  const futureRef = useRef([])
  const skipRef = useRef(false)

  const set = useCallback((updater) => {
    setPresent(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (!skipRef.current) {
        pastRef.current = [...pastRef.current.slice(-(MAX_HISTORY - 1)), prev]
        futureRef.current = []
      }
      skipRef.current = false
      return next
    })
  }, [])

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return
    setPresent(prev => {
      futureRef.current = [prev, ...futureRef.current]
      const previous = pastRef.current[pastRef.current.length - 1]
      pastRef.current = pastRef.current.slice(0, -1)
      skipRef.current = true
      return previous
    })
  }, [])

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return
    setPresent(prev => {
      pastRef.current = [...pastRef.current, prev]
      const next = futureRef.current[0]
      futureRef.current = futureRef.current.slice(1)
      skipRef.current = true
      return next
    })
  }, [])

  const canUndo = pastRef.current.length > 0
  const canRedo = futureRef.current.length > 0

  return { state: present, set, undo, redo, canUndo, canRedo }
}

// ============================================================================
// RESPONSIVE STYLE HELPERS
// ============================================================================

const BP_MOBILE = 768
const BP_TABLET = 1024

function getStyles(w) {
  const mobile = w < BP_MOBILE
  const tablet = w >= BP_MOBILE && w < BP_TABLET

  return {
    app: {
      minHeight: '100vh',
      background: '#09090b',
      color: '#fafafa',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: mobile ? '12px 16px' : '16px 24px',
      borderBottom: '1px solid #27272a',
      background: '#09090b',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      gap: 8,
    },
    logo: {
      fontSize: mobile ? 17 : 20,
      fontWeight: 700,
      letterSpacing: '-0.02em',
      whiteSpace: 'nowrap',
    },
    headerActions: {
      display: 'flex',
      gap: mobile ? 4 : 8,
      alignItems: 'center',
      flexShrink: 0,
    },
    main: mobile ? {
      display: 'flex',
      flexDirection: 'column',
      minHeight: 'calc(100vh - 53px)',
    } : {
      display: 'grid',
      gridTemplateColumns: tablet ? '260px 1fr' : '300px 1fr',
      minHeight: 'calc(100vh - 57px)',
    },
    sidebar: mobile ? {
      borderBottom: '1px solid #27272a',
      padding: '16px',
    } : {
      borderRight: '1px solid #27272a',
      padding: '20px',
      overflowY: 'auto',
      maxHeight: 'calc(100vh - 57px)',
    },
    content: {
      padding: mobile ? '16px' : '24px',
      overflowY: mobile ? 'visible' : 'auto',
      maxHeight: mobile ? 'none' : 'calc(100vh - 57px)',
    },
    section: { marginBottom: mobile ? 20 : 28 },
    sectionTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: '#a1a1aa',
      marginBottom: 12,
    },
    sliderGroup: { marginBottom: 14 },
    sliderLabel: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 12,
      color: '#a1a1aa',
      marginBottom: 4,
    },
    slider: {
      width: '100%',
      height: 6,
      borderRadius: 3,
      appearance: 'none',
      outline: 'none',
      cursor: 'pointer',
      background: '#27272a',
    },
    btn: {
      padding: mobile ? '5px 10px' : '6px 12px',
      borderRadius: 6,
      border: '1px solid #3f3f46',
      background: '#18181b',
      color: '#fafafa',
      fontSize: mobile ? 11 : 12,
      cursor: 'pointer',
      transition: 'all 0.15s',
      fontFamily: 'inherit',
    },
    btnActive: {
      background: '#fafafa',
      color: '#09090b',
      borderColor: '#fafafa',
    },
    btnSmall: { padding: '4px 8px', fontSize: 11 },
    btnIcon: {
      padding: '5px 8px',
      borderRadius: 6,
      border: '1px solid #3f3f46',
      background: '#18181b',
      color: '#fafafa',
      fontSize: 14,
      cursor: 'pointer',
      transition: 'all 0.15s',
      fontFamily: 'inherit',
      lineHeight: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnIconDisabled: {
      opacity: 0.3,
      cursor: 'default',
    },
    radioGroup: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    },
    radioOption: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 8px',
      borderRadius: 6,
      cursor: 'pointer',
      fontSize: 13,
      transition: 'background 0.15s',
    },
    colorPreview: {
      width: '100%',
      height: mobile ? 60 : 80,
      borderRadius: 10,
      marginBottom: 16,
      border: '1px solid #27272a',
      position: 'relative',
      overflow: 'hidden',
    },
    scaleRow: {
      marginBottom: mobile ? 16 : 20,
      transition: 'opacity 0.2s',
    },
    scaleLabel: {
      fontSize: 13,
      fontWeight: 500,
      marginBottom: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
    },
    scaleSwatches: {
      display: 'flex',
      borderRadius: 10,
      overflow: 'hidden',
      border: '1px solid #27272a',
    },
    scaleSwatch: {
      flex: 1,
      height: mobile ? 44 : 56,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      padding: '0 0 4px',
      fontSize: mobile ? 8 : 9,
      fontWeight: 600,
      cursor: 'pointer',
      transition: 'transform 0.15s',
      position: 'relative',
    },
    contrastGrid: {
      display: 'grid',
      gridTemplateColumns: mobile
        ? 'repeat(auto-fill, minmax(120px, 1fr))'
        : 'repeat(auto-fill, minmax(140px, 1fr))',
      gap: 8,
    },
    contrastCell: {
      borderRadius: 8,
      padding: mobile ? 10 : 12,
      fontSize: 12,
      fontWeight: 600,
      minHeight: 60,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
    },
    badge: {
      display: 'inline-block',
      padding: '2px 6px',
      borderRadius: 4,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.04em',
    },
    codeBlock: {
      background: '#09090b',
      borderRadius: 6,
      padding: 12,
      fontSize: mobile ? 11 : 12,
      fontFamily: "'SF Mono', 'Fira Code', monospace",
      overflowX: 'auto',
      whiteSpace: 'pre',
      lineHeight: 1.6,
      color: '#d4d4d8',
      border: '1px solid #27272a',
      maxHeight: 300,
      overflowY: 'auto',
    },
    tabs: {
      display: 'flex',
      gap: 2,
      marginBottom: 16,
      background: '#18181b',
      borderRadius: 8,
      padding: 3,
      border: '1px solid #27272a',
    },
    tab: {
      flex: 1,
      padding: mobile ? '7px 8px' : '8px 12px',
      borderRadius: 6,
      border: 'none',
      background: 'transparent',
      color: '#a1a1aa',
      fontSize: mobile ? 11 : 12,
      fontWeight: 500,
      cursor: 'pointer',
      transition: 'all 0.15s',
      fontFamily: 'inherit',
    },
    tabActive: {
      background: '#27272a',
      color: '#fafafa',
    },
    input: {
      background: '#18181b',
      border: '1px solid #3f3f46',
      borderRadius: 6,
      padding: '6px 10px',
      color: '#fafafa',
      fontSize: 12,
      fontFamily: 'inherit',
      outline: 'none',
      width: '100%',
    },
    gamutWarning: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      background: '#422006',
      border: '1px solid #92400e',
      borderRadius: 6,
      fontSize: 11,
      color: '#fbbf24',
      marginTop: 8,
    },
    tooltip: {
      position: 'absolute',
      bottom: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#18181b',
      border: '1px solid #3f3f46',
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: 11,
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      zIndex: 50,
      marginBottom: 4,
    },
    cvdRow: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
    cvdSwatch: {
      flex: mobile ? '1 1 40%' : 1,
      height: 40,
      borderRadius: 6,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 10,
      fontWeight: 600,
    },
    dragHandle: {
      cursor: 'grab',
      padding: '0 4px',
      fontSize: 14,
      color: '#52525b',
      userSelect: 'none',
      display: 'flex',
      alignItems: 'center',
    },
    mobileToggle: {
      padding: '10px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottom: '1px solid #27272a',
      cursor: 'pointer',
      background: '#18181b',
      fontSize: 13,
      fontWeight: 500,
    },
  }
}

// ============================================================================
// SMALL COMPONENTS
// ============================================================================

function HslSlider({ label, value, min, max, onChange, gradient, S }) {
  return (
    <div style={S.sliderGroup}>
      <div style={S.sliderLabel}>
        <span>{label}</span>
        <span>{Math.round(value)}{label === 'H' ? '°' : '%'}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ ...S.slider, background: gradient || '#27272a' }}
      />
    </div>
  )
}

function HexInput({ value, onChange, S }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)

  useEffect(() => { if (!editing) setText(value) }, [value, editing])

  const handleSubmit = () => {
    setEditing(false)
    const cleaned = text.replace(/[^0-9a-fA-F#]/g, '')
    if (/^#?[0-9a-fA-F]{6}$/.test(cleaned)) {
      onChange(cleaned.startsWith('#') ? cleaned : '#' + cleaned)
    } else {
      setText(value)
    }
  }

  return (
    <input
      style={{ ...S.input, fontFamily: "'SF Mono', 'Fira Code', monospace", textTransform: 'uppercase' }}
      value={editing ? text : value}
      onFocus={() => setEditing(true)}
      onChange={e => setText(e.target.value)}
      onBlur={handleSubmit}
      onKeyDown={e => e.key === 'Enter' && handleSubmit()}
      spellCheck={false}
    />
  )
}

function EditableLabel({ value, onChange, style }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const inputRef = useRef(null)

  useEffect(() => { if (!editing) setText(value) }, [value, editing])
  useEffect(() => { if (editing && inputRef.current) inputRef.current.select() }, [editing])

  const commit = () => {
    setEditing(false)
    const trimmed = text.trim()
    if (trimmed && trimmed !== value) onChange(trimmed)
    else setText(value)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setText(value); setEditing(false) } }}
        style={{
          background: '#27272a',
          border: '1px solid #52525b',
          borderRadius: 4,
          padding: '1px 6px',
          color: '#fafafa',
          fontSize: 13,
          fontWeight: 500,
          fontFamily: 'inherit',
          outline: 'none',
          width: 140,
          ...style,
        }}
        spellCheck={false}
      />
    )
  }

  return (
    <span
      onClick={() => setEditing(true)}
      style={{ cursor: 'text', borderBottom: '1px dashed #52525b', ...style }}
      title="Click to rename"
    >
      {value}
    </span>
  )
}

// ============================================================================
// CONTRAST LOCK PANEL
// ============================================================================

function ContrastLockPanel({ colorId, colorHsl, contrastLocks, setContrastLocks, S }) {
  const lock = contrastLocks[colorId]
  const [targetInput, setTargetInput] = useState(lock?.target?.toString() || '4.5')

  const bgOptions = [
    { label: 'White', rgb: { r: 255, g: 255, b: 255 } },
    { label: 'Black', rgb: { r: 0, g: 0, b: 0 } },
  ]

  const applyLock = (target, bgLabel) => {
    const bg = bgOptions.find(o => o.label === bgLabel) || bgOptions[0]
    const solvedL = solveForContrast(colorHsl.h, colorHsl.s, target, bg.rgb)
    setContrastLocks(prev => ({
      ...prev,
      [colorId]: { target, bg: bgLabel, bgRgb: bg.rgb, solvedL },
    }))
  }

  const removeLock = () => {
    setContrastLocks(prev => {
      const next = { ...prev }
      delete next[colorId]
      return next
    })
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={S.sectionTitle}>Contrast Lock</div>
      {lock ? (
        <div>
          <div style={{ fontSize: 12, marginBottom: 4, color: '#d4d4d8' }}>
            Locked to <strong>{lock.target}:1</strong> on <strong>{lock.bg}</strong>
            {' → '}L = {Math.round(lock.solvedL)}%
          </div>
          {(() => {
            const solvedRgb = hslToRgb(colorHsl.h, colorHsl.s, lock.solvedL)
            const lc = apcaContrast(solvedRgb, lock.bgRgb)
            const lvl = apcaLevel(lc)
            return (
              <div style={{ fontSize: 11, marginBottom: 8, color: '#a1a1aa' }}>
                APCA Lc {Math.round(lc)}{' '}
                <span style={{ color: apcaLevelColor(lvl), fontWeight: 600 }}>{lvl}</span>
              </div>
            )
          })()}
          <button style={{ ...S.btn, ...S.btnSmall }} onClick={removeLock}>Remove Lock</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="number" step="0.1" min="1" max="21"
            value={targetInput}
            onChange={e => setTargetInput(e.target.value)}
            style={{ ...S.input, width: 60 }}
          />
          <span style={{ fontSize: 11, color: '#71717a' }}>:1 on</span>
          {bgOptions.map(bg => (
            <button
              key={bg.label}
              style={{ ...S.btn, ...S.btnSmall }}
              onClick={() => applyLock(parseFloat(targetInput), bg.label)}
            >{bg.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// EXPORT PANEL
// ============================================================================

function ExportPanel({ allColors, S }) {
  const [format, setFormat] = useState('css')
  const [copied, setCopied] = useState(false)

  const formats = {
    css: {
      label: 'CSS Vars',
      generate: () => {
        let out = ':root {\n'
        allColors.forEach(g => { g.scale.forEach(s => { out += `  --${g.name}-${s.step}: ${s.hex};\n` }) })
        out += '}'
        return out
      },
    },
    tailwind: {
      label: 'Tailwind',
      generate: () => {
        const config = {}
        allColors.forEach(g => { config[g.name] = {}; g.scale.forEach(s => { config[g.name][s.step] = s.hex }) })
        return `// tailwind.config.js\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: ${JSON.stringify(config, null, 8).replace(/^/gm, '      ').trim()}\n    }\n  }\n}`
      },
    },
    json: {
      label: 'JSON',
      generate: () => {
        const out = {}
        allColors.forEach(g => {
          out[g.name] = {}
          g.scale.forEach(s => {
            out[g.name][s.step] = { hex: s.hex, rgb: `rgb(${s.rgb.r}, ${s.rgb.g}, ${s.rgb.b})`, hsl: `hsl(${Math.round(s.hsl.h)}, ${Math.round(s.hsl.s)}%, ${Math.round(s.hsl.l)}%)` }
          })
        })
        return JSON.stringify(out, null, 2)
      },
    },
    scss: {
      label: 'SCSS',
      generate: () => {
        let out = ''
        allColors.forEach(g => { g.scale.forEach(s => { out += `$${g.name}-${s.step}: ${s.hex};\n` }); out += '\n' })
        return out.trim()
      },
    },
  }

  const output = formats[format].generate()
  const copy = () => { navigator.clipboard.writeText(output).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }

  return (
    <div>
      <div style={S.tabs}>
        {Object.entries(formats).map(([key, f]) => (
          <button key={key} style={{ ...S.tab, ...(format === key ? S.tabActive : {}) }} onClick={() => setFormat(key)}>{f.label}</button>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <pre style={S.codeBlock}>{output}</pre>
        <button
          onClick={copy}
          style={{ ...S.btn, ...S.btnSmall, position: 'absolute', top: 8, right: 8, background: copied ? '#22c55e' : '#18181b', color: copied ? '#09090b' : '#fafafa' }}
        >{copied ? 'Copied!' : 'Copy'}</button>
      </div>
    </div>
  )
}

// ============================================================================
// CONTRAST MATRIX
// ============================================================================

function ContrastMatrix({ colors, S }) {
  if (colors.length === 0) return null

  const entries = colors.map(c => ({
    label: c.label,
    rgb: c.rgb,
    hex: rgbToHex(c.rgb.r, c.rgb.g, c.rgb.b),
    lum: relativeLuminance(c.rgb.r, c.rgb.g, c.rgb.b),
  }))

  const all = [
    { label: 'White', rgb: { r: 255, g: 255, b: 255 }, hex: '#ffffff', lum: 1 },
    { label: 'Black', rgb: { r: 0, g: 0, b: 0 }, hex: '#000000', lum: 0 },
    ...entries,
  ]

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ padding: 6, textAlign: 'left', color: '#71717a', fontWeight: 500 }}>FG / BG</th>
            {all.map(c => (
              <th key={c.label} style={{ padding: 6, textAlign: 'center' }}>
                <div style={{ width: 20, height: 20, borderRadius: 4, background: c.hex, margin: '0 auto 2px', border: '1px solid #3f3f46' }} />
                <span style={{ color: '#a1a1aa', fontWeight: 400, fontSize: 10 }}>{c.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {all.map(fg => (
            <tr key={fg.label}>
              <td style={{ padding: 6, color: '#a1a1aa', fontWeight: 500 }}>
                <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: fg.hex, marginRight: 6, verticalAlign: 'middle', border: '1px solid #3f3f46' }} />
                {fg.label}
              </td>
              {all.map(bg => {
                const ratio = contrastRatio(fg.lum, bg.lum)
                const level = wcagLevel(ratio)
                const lc = apcaContrast(fg.rgb, bg.rgb)
                const aLvl = apcaLevel(lc)
                return (
                  <td key={bg.label} style={{ padding: 4, textAlign: 'center' }}>
                    {fg.label === bg.label ? (
                      <span style={{ color: '#3f3f46' }}>—</span>
                    ) : (
                      <div style={{
                        background: bg.hex, color: fg.hex, borderRadius: 4,
                        padding: '4px 6px', fontWeight: 700, fontSize: 10,
                        border: '1px solid #3f3f46', lineHeight: 1.4,
                      }}>
                        {ratio.toFixed(1)}<br />
                        <span style={{ color: wcagLevelColor(level), fontSize: 9 }}>{level}</span><br />
                        <span style={{ fontSize: 8, opacity: 0.85, color: apcaLevelColor(aLvl) }}>Lc {Math.round(lc)}</span>
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ============================================================================
// COLOR BLINDNESS PREVIEW
// ============================================================================

function CVDPreview({ rgb, S }) {
  const types = [
    { key: 'normal', label: 'Normal' },
    { key: 'protanopia', label: 'Protanopia' },
    { key: 'deuteranopia', label: 'Deuteranopia' },
    { key: 'tritanopia', label: 'Tritanopia' },
  ]

  return (
    <div>
      <div style={S.sectionTitle}>Color Vision Simulation</div>
      <div style={S.cvdRow}>
        {types.map(t => {
          const sim = t.key === 'normal' ? rgb : simulateColorBlindness(rgb.r, rgb.g, rgb.b, t.key)
          const hex = rgbToHex(sim.r, sim.g, sim.b)
          const lum = relativeLuminance(sim.r, sim.g, sim.b)
          return (
            <div key={t.key} style={{ ...S.cvdSwatch, background: hex, color: lum > 0.179 ? '#09090b' : '#fafafa' }}>
              {t.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function HueLab() {
  const windowWidth = useWindowWidth()
  const S = useMemo(() => getStyles(windowWidth), [windowWidth])
  const mobile = windowWidth < BP_MOBILE

  // --- Undo/redo history wrapping core palette state ---
  const saved = useMemo(() => hashToState(window.location.hash), [])
  const history = useHistory({
    keyColor: saved ? { h: saved.h, s: saved.s, l: saved.l } : { h: 230, s: 75, l: 55 },
    harmonyMode: saved?.m || 'complementary',
    contrastLocks: saved?.cl || {},
    colorOverrides: saved?.ov || {},
    unlinkedColors: saved?.ul || {},
    colorOrder: saved?.co || null,
    colorNames: saved?.cn || {},
  })

  const { keyColor, harmonyMode, contrastLocks, colorOverrides, unlinkedColors, colorOrder, colorNames } = history.state

  // Convenience updaters
  const setKeyColor = useCallback(v => history.set(s => ({ ...s, keyColor: typeof v === 'function' ? v(s.keyColor) : v })), [history])
  const setHarmonyMode = useCallback(v => history.set(s => ({ ...s, harmonyMode: v })), [history])
  const setContrastLocks = useCallback(v => history.set(s => ({ ...s, contrastLocks: typeof v === 'function' ? v(s.contrastLocks) : v })), [history])
  const setColorOverrides = useCallback(v => history.set(s => ({ ...s, colorOverrides: typeof v === 'function' ? v(s.colorOverrides) : v })), [history])
  const setUnlinkedColors = useCallback(v => history.set(s => ({ ...s, unlinkedColors: typeof v === 'function' ? v(s.unlinkedColors) : v })), [history])
  const setColorOrder = useCallback(v => history.set(s => ({ ...s, colorOrder: typeof v === 'function' ? v(s.colorOrder) : v })), [history])
  const setColorNames = useCallback(v => history.set(s => ({ ...s, colorNames: typeof v === 'function' ? v(s.colorNames) : v })), [history])

  const [activePanel, setActivePanel] = useState('palette')
  const [showCmyk, setShowCmyk] = useState(false)
  const [selectedColor, setSelectedColor] = useState(null)
  const [hoveredSwatch, setHoveredSwatch] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Drag-and-drop state
  const [dragIdx, setDragIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  // --- Keyboard shortcuts (undo/redo) ---
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) history.redo()
        else history.undo()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        e.preventDefault()
        history.redo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [history])

  // --- Derived colors ---
  const keyRgb = useMemo(() => hslToRgb(keyColor.h, keyColor.s, keyColor.l), [keyColor])
  const keyHex = useMemo(() => rgbToHex(keyRgb.r, keyRgb.g, keyRgb.b), [keyRgb])
  const keyCmyk = useMemo(() => rgbToCmyk(keyRgb.r, keyRgb.g, keyRgb.b), [keyRgb])
  const keyInGamut = useMemo(() => isApproxInCmykGamut(keyRgb.r, keyRgb.g, keyRgb.b), [keyRgb])

  const harmonyColors = useMemo(() => {
    const harmonies = getHarmonyColors(keyColor.h, keyColor.s, keyColor.l, harmonyMode)
    return harmonies.map((c, i) => {
      const id = `harmony-${i}`
      if (unlinkedColors[id]) return { ...unlinkedColors[id], id, unlinked: true }
      const override = colorOverrides[id]
      const hsl = override ? { ...c, ...override } : c
      const lock = contrastLocks[id]
      if (lock) {
        hsl.l = solveForContrast(hsl.h, hsl.s, lock.target, lock.bgRgb)
      }
      return { ...hsl, id }
    })
  }, [keyColor, harmonyMode, colorOverrides, unlinkedColors, contrastLocks])

  // All palette colors (key + harmonies) with their scales
  const allPaletteColors = useMemo(() => {
    const effectiveKeyHsl = { ...keyColor }
    const keyLock = contrastLocks['key']
    if (keyLock) {
      effectiveKeyHsl.l = solveForContrast(keyColor.h, keyColor.s, keyLock.target, keyLock.bgRgb)
    }

    const groups = [
      { name: 'primary', hsl: effectiveKeyHsl, label: 'Primary', id: 'key' },
      ...harmonyColors.map((c, i) => ({
        name: c.label?.toLowerCase().replace(/\s+/g, '-') || `harmony-${i}`,
        hsl: c,
        label: c.label || `Harmony ${i + 1}`,
        id: c.id,
      })),
    ]
    return groups.map(g => ({
      ...g,
      rgb: hslToRgb(g.hsl.h, g.hsl.s, g.hsl.l),
      hex: rgbToHex(...Object.values(hslToRgb(g.hsl.h, g.hsl.s, g.hsl.l))),
      scale: generateValueScale(g.hsl.h, g.hsl.s, g.hsl.l),
    }))
  }, [keyColor, harmonyColors, contrastLocks])

  // --- Auto-generate cheesy color names for new colors ---
  useEffect(() => {
    const updates = {}
    let needsUpdate = false
    allPaletteColors.forEach(g => {
      if (!colorNames[g.id]) {
        updates[g.id] = generateColorName(g.hsl.h, g.hsl.s, g.hsl.l)
        needsUpdate = true
      }
    })
    if (needsUpdate) {
      setColorNames(prev => ({ ...prev, ...updates }))
    }
  }, [allPaletteColors.length, harmonyMode])

  // Reorder palette based on colorOrder
  const orderedPaletteColors = useMemo(() => {
    if (!colorOrder || colorOrder.length === 0) return allPaletteColors
    const map = {}
    allPaletteColors.forEach(g => { map[g.id] = g })
    const ordered = []
    colorOrder.forEach(id => { if (map[id]) { ordered.push(map[id]); delete map[id] } })
    Object.values(map).forEach(g => ordered.push(g))
    return ordered
  }, [allPaletteColors, colorOrder])

  // --- Recalculate contrast locks when hue changes ---
  useEffect(() => {
    const newLocks = { ...contrastLocks }
    let changed = false
    for (const [id, lock] of Object.entries(newLocks)) {
      let hsl
      if (id === 'key') hsl = keyColor
      else {
        const match = harmonyColors.find(c => c.id === id)
        if (match) hsl = match; else continue
      }
      const newL = solveForContrast(hsl.h, hsl.s, lock.target, lock.bgRgb)
      if (Math.abs(newL - (lock.solvedL || 0)) > 0.5) {
        newLocks[id] = { ...lock, solvedL: newL }
        changed = true
      }
    }
    if (changed) setContrastLocks(newLocks)
  }, [keyColor.h, keyColor.s, harmonyMode])

  // --- URL persistence ---
  useEffect(() => {
    const hash = stateToHash({ keyColor, harmonyMode, contrastLocks, colorOverrides, unlinkedColors, colorOrder, colorNames })
    if (hash) window.history.replaceState(null, '', hash)
  }, [keyColor, harmonyMode, contrastLocks, colorOverrides, unlinkedColors, colorOrder, colorNames])

  // --- Callbacks ---
  const setHue = useCallback(h => setKeyColor(prev => ({ ...prev, h })), [setKeyColor])
  const setSaturation = useCallback(s => setKeyColor(prev => ({ ...prev, s })), [setKeyColor])
  const setLightness = useCallback(l => setKeyColor(prev => ({ ...prev, l })), [setKeyColor])
  const setHex = useCallback(hex => {
    const rgb = hexToRgb(hex)
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
    setKeyColor(hsl)
  }, [setKeyColor])

  const hueGradient = useMemo(() => {
    const stops = Array.from({ length: 13 }, (_, i) => {
      const h = (i / 12) * 360
      const rgb = hslToRgb(h, keyColor.s, keyColor.l)
      return rgbToHex(rgb.r, rgb.g, rgb.b)
    })
    return `linear-gradient(to right, ${stops.join(', ')})`
  }, [keyColor.s, keyColor.l])

  const satGradient = useMemo(() => {
    const lo = hslToRgb(keyColor.h, 0, keyColor.l)
    const hi = hslToRgb(keyColor.h, 100, keyColor.l)
    return `linear-gradient(to right, ${rgbToHex(lo.r, lo.g, lo.b)}, ${rgbToHex(hi.r, hi.g, hi.b)})`
  }, [keyColor.h, keyColor.l])

  const litGradient = useMemo(() => {
    const lo = hslToRgb(keyColor.h, keyColor.s, 0)
    const mid = hslToRgb(keyColor.h, keyColor.s, 50)
    const hi = hslToRgb(keyColor.h, keyColor.s, 100)
    return `linear-gradient(to right, ${rgbToHex(lo.r, lo.g, lo.b)}, ${rgbToHex(mid.r, mid.g, mid.b)}, ${rgbToHex(hi.r, hi.g, hi.b)})`
  }, [keyColor.h, keyColor.s])

  const matrixColors = useMemo(() => {
    return orderedPaletteColors.map(g => ({
      label: colorNames[g.id] || g.label,
      rgb: g.rgb,
    }))
  }, [orderedPaletteColors, colorNames])

  const selectedGroup = selectedColor
    ? allPaletteColors.find(g => g.id === selectedColor) || allPaletteColors[0]
    : allPaletteColors[0]

  // --- Drag handlers ---
  const handleDragStart = (e, idx) => {
    setDragIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (e, idx) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIdx(idx)
  }
  const handleDragEnd = () => { setDragIdx(null); setDragOverIdx(null) }
  const handleDrop = (e, dropIndex) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === dropIndex) { handleDragEnd(); return }
    const ids = orderedPaletteColors.map(g => g.id)
    const moved = ids.splice(dragIdx, 1)[0]
    ids.splice(dropIndex, 0, moved)
    setColorOrder(ids)
    handleDragEnd()
  }

  // --- Sidebar content (shared between mobile drawer and desktop sidebar) ---
  const sidebarContent = (
    <>
      {/* Color Preview */}
      <div style={{ ...S.colorPreview, background: keyHex }}>
        <div style={{
          position: 'absolute', bottom: 8, left: 10, right: 10,
          display: 'flex', justifyContent: 'space-between',
          fontSize: 11, fontWeight: 600,
          color: relativeLuminance(keyRgb.r, keyRgb.g, keyRgb.b) > 0.179 ? '#09090b' : '#fafafa',
        }}>
          <span>{keyHex.toUpperCase()}</span>
          {showCmyk && <span>C{keyCmyk.c} M{keyCmyk.m} Y{keyCmyk.y} K{keyCmyk.k}</span>}
        </div>
      </div>

      {showCmyk && !keyInGamut && (
        <div style={S.gamutWarning}>
          <span style={{ fontSize: 14 }}>!</span>
          Out of CMYK gamut — colors may shift in print
        </div>
      )}

      {/* HSL Sliders */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Key Color</div>
        <HslSlider label="H" value={keyColor.h} min={0} max={360} onChange={setHue} gradient={hueGradient} S={S} />
        <HslSlider label="S" value={keyColor.s} min={0} max={100} onChange={setSaturation} gradient={satGradient} S={S} />
        <HslSlider label="L" value={keyColor.l} min={0} max={100} onChange={setLightness} gradient={litGradient} S={S} />
        <div style={{ marginTop: 8 }}>
          <HexInput value={keyHex} onChange={setHex} S={S} />
        </div>
      </div>

      {/* Harmony Mode */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Harmony</div>
        <div style={S.radioGroup}>
          {Object.entries(HARMONY_MODES).map(([key, mode]) => (
            <div
              key={key}
              style={{ ...S.radioOption, background: harmonyMode === key ? '#27272a' : 'transparent' }}
              onClick={() => setHarmonyMode(key)}
            >
              <div style={{
                width: 14, height: 14, borderRadius: '50%',
                border: `2px solid ${harmonyMode === key ? '#fafafa' : '#52525b'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {harmonyMode === key && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fafafa' }} />}
              </div>
              <span>{mode.label}</span>
              <div style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
                {[0, ...mode.offsets].map((offset, i) => {
                  const hue = (keyColor.h + offset + 360) % 360
                  const rgb = hslToRgb(hue, keyColor.s, keyColor.l)
                  return <div key={i} style={{ width: 12, height: 12, borderRadius: 3, background: rgbToHex(rgb.r, rgb.g, rgb.b) }} />
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Color Details */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Details — {colorNames[selectedGroup.id] || selectedGroup.label}</div>
        <div style={{ fontSize: 12, color: '#d4d4d8', lineHeight: 1.8, fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
          <div>HEX: {selectedGroup.hex.toUpperCase()}</div>
          <div>RGB: {selectedGroup.rgb.r}, {selectedGroup.rgb.g}, {selectedGroup.rgb.b}</div>
          <div>HSL: {Math.round(selectedGroup.hsl.h)}°, {Math.round(selectedGroup.hsl.s)}%, {Math.round(selectedGroup.hsl.l)}%</div>
          <div>OKLab L: {rgbToOklab(selectedGroup.rgb.r, selectedGroup.rgb.g, selectedGroup.rgb.b).L.toFixed(3)}</div>
          {showCmyk && (() => {
            const cmyk = rgbToCmyk(selectedGroup.rgb.r, selectedGroup.rgb.g, selectedGroup.rgb.b)
            return <div>CMYK: {cmyk.c}%, {cmyk.m}%, {cmyk.y}%, {cmyk.k}%</div>
          })()}
        </div>
        <ContrastLockPanel
          colorId={selectedGroup.id}
          colorHsl={selectedGroup.hsl}
          contrastLocks={contrastLocks}
          setContrastLocks={setContrastLocks}
          S={S}
        />
      </div>

      <CVDPreview rgb={selectedGroup.rgb} S={S} />
    </>
  )

  // --- Render ---
  return (
    <div style={S.app}>
      {/* Header */}
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 8 : 12, overflow: 'hidden' }}>
          <span style={S.logo}>Hue Lab</span>
          {!mobile && <span style={{ fontSize: 11, color: '#71717a', fontWeight: 400 }}>Perceptual Color Palette Generator</span>}
        </div>
        <div style={S.headerActions}>
          {/* Undo / Redo */}
          <button
            style={{ ...S.btnIcon, ...(history.canUndo ? {} : S.btnIconDisabled) }}
            onClick={history.undo}
            disabled={!history.canUndo}
            title="Undo (Ctrl+Z)"
          >↩</button>
          <button
            style={{ ...S.btnIcon, ...(history.canRedo ? {} : S.btnIconDisabled) }}
            onClick={history.redo}
            disabled={!history.canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >↪</button>

          <button
            style={{ ...S.btn, ...(showCmyk ? S.btnActive : {}) }}
            onClick={() => setShowCmyk(!showCmyk)}
          >CMYK</button>
          {!mobile && (
            <button
              style={{ ...S.btn, ...(activePanel === 'export' ? S.btnActive : {}) }}
              onClick={() => setActivePanel(activePanel === 'export' ? 'palette' : 'export')}
            >Export</button>
          )}
        </div>
      </header>

      {/* Mobile: collapsible controls toggle */}
      {mobile && (
        <div style={S.mobileToggle} onClick={() => setSidebarOpen(!sidebarOpen)}>
          <span>Controls</span>
          <span style={{ fontSize: 11, color: '#71717a' }}>{sidebarOpen ? 'Hide ▲' : 'Show ▼'}</span>
        </div>
      )}

      <div style={S.main}>
        {/* Sidebar — desktop: always visible; mobile: collapsible */}
        {(!mobile || sidebarOpen) && (
          <aside style={S.sidebar}>
            {sidebarContent}
          </aside>
        )}

        {/* Main Content */}
        <main style={S.content}>
          <div style={{ ...S.tabs, maxWidth: mobile ? '100%' : 500 }}>
            {[
              { key: 'palette', label: 'Palette' },
              { key: 'contrast', label: 'Contrast' },
              { key: 'export', label: 'Export' },
            ].map(t => (
              <button
                key={t.key}
                style={{ ...S.tab, ...(activePanel === t.key ? S.tabActive : {}) }}
                onClick={() => setActivePanel(t.key)}
              >{t.label}</button>
            ))}
          </div>

          {/* Palette Panel */}
          {activePanel === 'palette' && (
            <div>
              {orderedPaletteColors.map((group, idx) => {
                const isSelected = selectedColor === group.id || (!selectedColor && group.id === 'key')
                const isDragging = dragIdx === idx
                const isDragOver = dragOverIdx === idx && dragIdx !== idx

                return (
                  <div
                    key={group.id}
                    style={{
                      ...S.scaleRow,
                      opacity: isDragging ? 0.4 : 1,
                      borderTop: isDragOver ? '2px solid #60a5fa' : '2px solid transparent',
                    }}
                    draggable
                    onDragStart={e => handleDragStart(e, idx)}
                    onDragOver={e => handleDragOver(e, idx)}
                    onDragEnd={handleDragEnd}
                    onDrop={e => handleDrop(e, idx)}
                  >
                    <div style={S.scaleLabel}>
                      {/* Drag handle */}
                      <span style={S.dragHandle} title="Drag to reorder">⠿</span>
                      <div style={{ width: 14, height: 14, borderRadius: 4, background: group.hex, border: '1px solid #3f3f46', flexShrink: 0 }} />
                      <EditableLabel
                        value={colorNames[group.id] || group.label}
                        onChange={name => setColorNames(prev => ({ ...prev, [group.id]: name }))}
                        style={{ color: isSelected ? '#fafafa' : '#a1a1aa', cursor: 'text' }}
                      />
                      {contrastLocks[group.id] && (
                        <span style={{ ...S.badge, background: '#1e3a5f', color: '#60a5fa' }}>
                          {contrastLocks[group.id].target}:1
                        </span>
                      )}
                      {showCmyk && !isApproxInCmykGamut(group.rgb.r, group.rgb.g, group.rgb.b) && (
                        <span style={{ ...S.badge, background: '#422006', color: '#fbbf24' }}>Out of gamut</span>
                      )}
                      <span
                        style={{ marginLeft: 'auto', fontSize: 10, color: '#52525b', cursor: 'pointer', flexShrink: 0 }}
                        onClick={() => setSelectedColor(group.id)}
                        title="Select for details"
                      >details →</span>
                    </div>
                    <div style={S.scaleSwatches}>
                      {group.scale.map(swatch => {
                        const lum = relativeLuminance(swatch.rgb.r, swatch.rgb.g, swatch.rgb.b)
                        const textCol = lum > 0.179 ? '#09090b' : '#fafafa'
                        const isHovered = hoveredSwatch === `${group.id}-${swatch.step}`

                        return (
                          <div
                            key={swatch.step}
                            style={{
                              ...S.scaleSwatch,
                              background: swatch.hex,
                              color: textCol,
                              transform: isHovered ? 'scaleY(1.15)' : 'none',
                              zIndex: isHovered ? 10 : 1,
                            }}
                            onMouseEnter={() => setHoveredSwatch(`${group.id}-${swatch.step}`)}
                            onMouseLeave={() => setHoveredSwatch(null)}
                            onClick={() => navigator.clipboard.writeText(swatch.hex)}
                            title={`${swatch.hex}\nClick to copy`}
                          >
                            {swatch.step}
                            {isHovered && (
                              <div style={S.tooltip}>
                                {swatch.hex.toUpperCase()}
                                {showCmyk && (() => {
                                  const cmyk = rgbToCmyk(swatch.rgb.r, swatch.rgb.g, swatch.rgb.b)
                                  return ` · C${cmyk.c} M${cmyk.m} Y${cmyk.y} K${cmyk.k}`
                                })()}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Contrast Panel */}
          {activePanel === 'contrast' && (
            <div>
              <div style={{ ...S.sectionTitle, marginBottom: 16 }}>Contrast Ratio Matrix</div>
              <ContrastMatrix colors={matrixColors} S={S} />
              <div style={{ marginTop: 28 }}>
                <div style={S.sectionTitle}>Quick Check</div>
                <div style={S.contrastGrid}>
                  {orderedPaletteColors.map(group => {
                    const fgLum = relativeLuminance(group.rgb.r, group.rgb.g, group.rgb.b)
                    const onWhite = contrastRatio(fgLum, 1)
                    const onBlack = contrastRatio(fgLum, 0)
                    const whiteLevel = wcagLevel(onWhite)
                    const blackLevel = wcagLevel(onBlack)
                    const lcOnWhite = apcaContrast(group.rgb, { r: 255, g: 255, b: 255 })
                    const lcOnBlack = apcaContrast(group.rgb, { r: 0, g: 0, b: 0 })
                    const aLvlWhite = apcaLevel(lcOnWhite)
                    const aLvlBlack = apcaLevel(lcOnBlack)
                    const displayName = colorNames[group.id] || group.label
                    return (
                      <React.Fragment key={group.id}>
                        <div style={{ ...S.contrastCell, background: '#ffffff', color: group.hex }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{displayName}</div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ ...S.badge, background: wcagLevelColor(whiteLevel), color: '#09090b' }}>{whiteLevel}</span>
                            <span style={{ color: '#71717a', fontSize: 11 }}>{onWhite.toFixed(1)}:1</span>
                          </div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                            <span style={{ ...S.badge, background: apcaLevelColor(aLvlWhite), color: '#09090b' }}>APCA</span>
                            <span style={{ color: '#71717a', fontSize: 11 }}>Lc {Math.round(lcOnWhite)}</span>
                          </div>
                        </div>
                        <div style={{ ...S.contrastCell, background: '#09090b', color: group.hex, border: '1px solid #27272a' }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{displayName}</div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ ...S.badge, background: wcagLevelColor(blackLevel), color: '#09090b' }}>{blackLevel}</span>
                            <span style={{ color: '#71717a', fontSize: 11 }}>{onBlack.toFixed(1)}:1</span>
                          </div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                            <span style={{ ...S.badge, background: apcaLevelColor(aLvlBlack), color: '#09090b' }}>APCA</span>
                            <span style={{ color: '#71717a', fontSize: 11 }}>Lc {Math.round(lcOnBlack)}</span>
                          </div>
                        </div>
                      </React.Fragment>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Export Panel */}
          {activePanel === 'export' && (
            <ExportPanel allColors={orderedPaletteColors} S={S} />
          )}
        </main>
      </div>
    </div>
  )
}
