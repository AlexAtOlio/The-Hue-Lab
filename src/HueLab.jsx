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

function cmykGamutDistance(r, g, b) {
  const cmyk = rgbToCmyk(r, g, b)
  const back = cmykToRgb(cmyk.c, cmyk.m, cmyk.y, cmyk.k)
  const lab1 = rgbToOklab(r, g, b)
  const lab2 = rgbToOklab(back.r, back.g, back.b)
  return deltaE(lab1, lab2)
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
// STYLES
// ============================================================================

const STYLES = {
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
    padding: '16px 24px',
    borderBottom: '1px solid #27272a',
    background: '#09090b',
    position: 'sticky',
    top: 0,
    zIndex: 100,
  },
  logo: {
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  headerActions: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  main: {
    display: 'grid',
    gridTemplateColumns: '300px 1fr',
    minHeight: 'calc(100vh - 57px)',
  },
  sidebar: {
    borderRight: '1px solid #27272a',
    padding: '20px',
    overflowY: 'auto',
    maxHeight: 'calc(100vh - 57px)',
  },
  content: {
    padding: '24px',
    overflowY: 'auto',
    maxHeight: 'calc(100vh - 57px)',
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#a1a1aa',
    marginBottom: 12,
  },
  sliderGroup: {
    marginBottom: 14,
  },
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
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #3f3f46',
    background: '#18181b',
    color: '#fafafa',
    fontSize: 12,
    cursor: 'pointer',
    transition: 'all 0.15s',
    fontFamily: 'inherit',
  },
  btnActive: {
    background: '#fafafa',
    color: '#09090b',
    borderColor: '#fafafa',
  },
  btnSmall: {
    padding: '4px 8px',
    fontSize: 11,
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
    height: 80,
    borderRadius: 10,
    marginBottom: 16,
    border: '1px solid #27272a',
    position: 'relative',
    overflow: 'hidden',
  },
  scaleRow: {
    marginBottom: 20,
  },
  scaleLabel: {
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  scaleSwatches: {
    display: 'flex',
    borderRadius: 10,
    overflow: 'hidden',
    border: '1px solid #27272a',
  },
  scaleSwatch: {
    flex: 1,
    height: 56,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: '0 0 4px',
    fontSize: 9,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'transform 0.15s',
    position: 'relative',
  },
  contrastGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 8,
  },
  contrastCell: {
    borderRadius: 8,
    padding: 12,
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
  exportBox: {
    background: '#18181b',
    borderRadius: 8,
    border: '1px solid #27272a',
    padding: 16,
    marginBottom: 12,
  },
  codeBlock: {
    background: '#09090b',
    borderRadius: 6,
    padding: 12,
    fontSize: 12,
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
    padding: '8px 12px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: '#a1a1aa',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
    fontFamily: 'inherit',
  },
  tabActive: {
    background: '#27272a',
    color: '#fafafa',
  },
  lockRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
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
  select: {
    background: '#18181b',
    border: '1px solid #3f3f46',
    borderRadius: 6,
    padding: '6px 10px',
    color: '#fafafa',
    fontSize: 12,
    fontFamily: 'inherit',
    outline: 'none',
    cursor: 'pointer',
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
  cvdRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 8,
  },
  cvdSwatch: {
    flex: 1,
    height: 40,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    fontWeight: 600,
  },
}

// ============================================================================
// SLIDER COMPONENT WITH HUE GRADIENT
// ============================================================================

function HslSlider({ label, value, min, max, onChange, gradient }) {
  return (
    <div style={STYLES.sliderGroup}>
      <div style={STYLES.sliderLabel}>
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
        style={{
          ...STYLES.slider,
          background: gradient || '#27272a',
        }}
      />
    </div>
  )
}

// ============================================================================
// HEX INPUT COMPONENT
// ============================================================================

function HexInput({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)

  useEffect(() => {
    if (!editing) setText(value)
  }, [value, editing])

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
      style={{ ...STYLES.input, fontFamily: "'SF Mono', 'Fira Code', monospace", textTransform: 'uppercase' }}
      value={editing ? text : value}
      onFocus={() => setEditing(true)}
      onChange={e => setText(e.target.value)}
      onBlur={handleSubmit}
      onKeyDown={e => e.key === 'Enter' && handleSubmit()}
      spellCheck={false}
    />
  )
}

// ============================================================================
// COLOR SWATCH COMPONENT
// ============================================================================

function ColorSwatch({ color, size = 32, label, active, onClick, showHex }) {
  const hex = rgbToHex(color.r, color.g, color.b)
  const lum = relativeLuminance(color.r, color.g, color.b)
  const textColor = lum > 0.179 ? '#09090b' : '#fafafa'

  return (
    <div
      onClick={onClick}
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: hex,
        cursor: onClick ? 'pointer' : 'default',
        border: active ? '2px solid #fafafa' : '1px solid #27272a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 600,
        color: textColor,
        transition: 'transform 0.15s',
        flexShrink: 0,
      }}
      title={`${hex}${label ? ' — ' + label : ''}`}
    >
      {showHex && hex.toUpperCase()}
    </div>
  )
}

// ============================================================================
// CONTRAST LOCK PANEL
// ============================================================================

function ContrastLockPanel({ colorId, colorHsl, contrastLocks, setContrastLocks }) {
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
      <div style={STYLES.sectionTitle}>Contrast Lock</div>
      {lock ? (
        <div>
          <div style={{ fontSize: 12, marginBottom: 8, color: '#d4d4d8' }}>
            Locked to <strong>{lock.target}:1</strong> on <strong>{lock.bg}</strong>
            {' → '}L = {Math.round(lock.solvedL)}%
          </div>
          <button style={{ ...STYLES.btn, ...STYLES.btnSmall }} onClick={removeLock}>
            Remove Lock
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="number"
            step="0.1"
            min="1"
            max="21"
            value={targetInput}
            onChange={e => setTargetInput(e.target.value)}
            style={{ ...STYLES.input, width: 60 }}
          />
          <span style={{ fontSize: 11, color: '#71717a' }}>:1 on</span>
          {bgOptions.map(bg => (
            <button
              key={bg.label}
              style={{ ...STYLES.btn, ...STYLES.btnSmall }}
              onClick={() => applyLock(parseFloat(targetInput), bg.label)}
            >
              {bg.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// EXPORT PANEL
// ============================================================================

function ExportPanel({ allColors, keyColor }) {
  const [format, setFormat] = useState('css')
  const [copied, setCopied] = useState(false)

  const formats = {
    css: {
      label: 'CSS Variables',
      generate: () => {
        let out = ':root {\n'
        allColors.forEach(group => {
          group.scale.forEach(s => {
            out += `  --${group.name}-${s.step}: ${s.hex};\n`
          })
        })
        out += '}'
        return out
      },
    },
    tailwind: {
      label: 'Tailwind',
      generate: () => {
        const config = {}
        allColors.forEach(group => {
          config[group.name] = {}
          group.scale.forEach(s => {
            config[group.name][s.step] = s.hex
          })
        })
        return `// tailwind.config.js\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: ${JSON.stringify(config, null, 8).replace(/^/gm, '      ').trim()}\n    }\n  }\n}`
      },
    },
    json: {
      label: 'JSON',
      generate: () => {
        const out = {}
        allColors.forEach(group => {
          out[group.name] = {}
          group.scale.forEach(s => {
            out[group.name][s.step] = {
              hex: s.hex,
              rgb: `rgb(${s.rgb.r}, ${s.rgb.g}, ${s.rgb.b})`,
              hsl: `hsl(${Math.round(s.hsl.h)}, ${Math.round(s.hsl.s)}%, ${Math.round(s.hsl.l)}%)`,
            }
          })
        })
        return JSON.stringify(out, null, 2)
      },
    },
    scss: {
      label: 'SCSS',
      generate: () => {
        let out = ''
        allColors.forEach(group => {
          group.scale.forEach(s => {
            out += `$${group.name}-${s.step}: ${s.hex};\n`
          })
          out += '\n'
        })
        return out.trim()
      },
    },
  }

  const output = formats[format].generate()

  const copy = () => {
    navigator.clipboard.writeText(output).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div>
      <div style={STYLES.tabs}>
        {Object.entries(formats).map(([key, f]) => (
          <button
            key={key}
            style={{ ...STYLES.tab, ...(format === key ? STYLES.tabActive : {}) }}
            onClick={() => setFormat(key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <pre style={STYLES.codeBlock}>{output}</pre>
        <button
          onClick={copy}
          style={{
            ...STYLES.btn,
            ...STYLES.btnSmall,
            position: 'absolute',
            top: 8,
            right: 8,
            background: copied ? '#22c55e' : '#18181b',
            color: copied ? '#09090b' : '#fafafa',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// CONTRAST MATRIX
// ============================================================================

function ContrastMatrix({ colors }) {
  if (colors.length === 0) return null

  const entries = colors.map(c => ({
    label: c.label,
    rgb: c.rgb,
    hex: rgbToHex(c.rgb.r, c.rgb.g, c.rgb.b),
    lum: relativeLuminance(c.rgb.r, c.rgb.g, c.rgb.b),
  }))

  // Add white and black for reference
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
                return (
                  <td key={bg.label} style={{ padding: 4, textAlign: 'center' }}>
                    {fg.label === bg.label ? (
                      <span style={{ color: '#3f3f46' }}>—</span>
                    ) : (
                      <div style={{
                        background: bg.hex,
                        color: fg.hex,
                        borderRadius: 4,
                        padding: '4px 6px',
                        fontWeight: 700,
                        fontSize: 10,
                        border: '1px solid #3f3f46',
                        lineHeight: 1.3,
                      }}>
                        {ratio.toFixed(1)}
                        <br />
                        <span style={{ color: wcagLevelColor(level), fontSize: 9 }}>{level}</span>
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

function CVDPreview({ rgb }) {
  const types = [
    { key: 'normal', label: 'Normal' },
    { key: 'protanopia', label: 'Protanopia' },
    { key: 'deuteranopia', label: 'Deuteranopia' },
    { key: 'tritanopia', label: 'Tritanopia' },
  ]

  return (
    <div>
      <div style={STYLES.sectionTitle}>Color Vision Simulation</div>
      <div style={STYLES.cvdRow}>
        {types.map(t => {
          const sim = t.key === 'normal' ? rgb : simulateColorBlindness(rgb.r, rgb.g, rgb.b, t.key)
          const hex = rgbToHex(sim.r, sim.g, sim.b)
          const lum = relativeLuminance(sim.r, sim.g, sim.b)
          return (
            <div key={t.key} style={{ ...STYLES.cvdSwatch, background: hex, color: lum > 0.179 ? '#09090b' : '#fafafa' }}>
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
  // --- State ---
  const [keyColor, setKeyColor] = useState(() => {
    const saved = hashToState(window.location.hash)
    return saved ? { h: saved.h, s: saved.s, l: saved.l } : { h: 230, s: 75, l: 55 }
  })
  const [harmonyMode, setHarmonyMode] = useState(() => {
    const saved = hashToState(window.location.hash)
    return saved?.m || 'complementary'
  })
  const [contrastLocks, setContrastLocks] = useState(() => {
    const saved = hashToState(window.location.hash)
    return saved?.cl || {}
  })
  const [colorOverrides, setColorOverrides] = useState(() => {
    const saved = hashToState(window.location.hash)
    return saved?.ov || {}
  })
  const [unlinkedColors, setUnlinkedColors] = useState(() => {
    const saved = hashToState(window.location.hash)
    return saved?.ul || {}
  })
  const [activePanel, setActivePanel] = useState('palette')
  const [showCmyk, setShowCmyk] = useState(false)
  const [selectedColor, setSelectedColor] = useState(null)
  const [hoveredSwatch, setHoveredSwatch] = useState(null)

  // --- Derived colors ---
  const keyRgb = useMemo(() => hslToRgb(keyColor.h, keyColor.s, keyColor.l), [keyColor])
  const keyHex = useMemo(() => rgbToHex(keyRgb.r, keyRgb.g, keyRgb.b), [keyRgb])
  const keyOklab = useMemo(() => rgbToOklab(keyRgb.r, keyRgb.g, keyRgb.b), [keyRgb])
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
        const solvedL = solveForContrast(hsl.h, hsl.s, lock.target, lock.bgRgb)
        hsl.l = solvedL
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

  // --- Recalculate contrast locks when hue changes ---
  useEffect(() => {
    const newLocks = { ...contrastLocks }
    let changed = false
    for (const [id, lock] of Object.entries(newLocks)) {
      let hsl
      if (id === 'key') {
        hsl = keyColor
      } else {
        const match = harmonyColors.find(c => c.id === id)
        if (match) hsl = match
        else continue
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
    const hash = stateToHash({ keyColor, harmonyMode, contrastLocks, colorOverrides, unlinkedColors })
    if (hash) window.history.replaceState(null, '', hash)
  }, [keyColor, harmonyMode, contrastLocks, colorOverrides, unlinkedColors])

  // --- Callbacks ---
  const setHue = useCallback(h => setKeyColor(prev => ({ ...prev, h })), [])
  const setSaturation = useCallback(s => setKeyColor(prev => ({ ...prev, s })), [])
  const setLightness = useCallback(l => setKeyColor(prev => ({ ...prev, l })), [])
  const setHex = useCallback(hex => {
    const rgb = hexToRgb(hex)
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
    setKeyColor(hsl)
  }, [])

  // Hue gradient for slider
  const hueGradient = useMemo(() => {
    const stops = Array.from({ length: 13 }, (_, i) => {
      const h = (i / 12) * 360
      const rgb = hslToRgb(h, keyColor.s, keyColor.l)
      return rgbToHex(rgb.r, rgb.g, rgb.b)
    })
    return `linear-gradient(to right, ${stops.join(', ')})`
  }, [keyColor.s, keyColor.l])

  // Saturation gradient
  const satGradient = useMemo(() => {
    const lo = hslToRgb(keyColor.h, 0, keyColor.l)
    const hi = hslToRgb(keyColor.h, 100, keyColor.l)
    return `linear-gradient(to right, ${rgbToHex(lo.r, lo.g, lo.b)}, ${rgbToHex(hi.r, hi.g, hi.b)})`
  }, [keyColor.h, keyColor.l])

  // Lightness gradient
  const litGradient = useMemo(() => {
    const lo = hslToRgb(keyColor.h, keyColor.s, 0)
    const mid = hslToRgb(keyColor.h, keyColor.s, 50)
    const hi = hslToRgb(keyColor.h, keyColor.s, 100)
    return `linear-gradient(to right, ${rgbToHex(lo.r, lo.g, lo.b)}, ${rgbToHex(mid.r, mid.g, mid.b)}, ${rgbToHex(hi.r, hi.g, hi.b)})`
  }, [keyColor.h, keyColor.s])

  // --- Colors for contrast matrix ---
  const matrixColors = useMemo(() => {
    return allPaletteColors.map(g => ({
      label: g.label,
      rgb: g.rgb,
    }))
  }, [allPaletteColors])

  // Selected palette group for details
  const selectedGroup = selectedColor
    ? allPaletteColors.find(g => g.id === selectedColor) || allPaletteColors[0]
    : allPaletteColors[0]

  // --- Render ---
  return (
    <div style={STYLES.app}>
      {/* Header */}
      <header style={STYLES.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={STYLES.logo}>Hue Lab</span>
          <span style={{ fontSize: 11, color: '#71717a', fontWeight: 400 }}>Perceptual Color Palette Generator</span>
        </div>
        <div style={STYLES.headerActions}>
          <button
            style={{ ...STYLES.btn, ...(showCmyk ? STYLES.btnActive : {}) }}
            onClick={() => setShowCmyk(!showCmyk)}
          >
            CMYK
          </button>
          <button
            style={{ ...STYLES.btn, ...(activePanel === 'export' ? STYLES.btnActive : {}) }}
            onClick={() => setActivePanel(activePanel === 'export' ? 'palette' : 'export')}
          >
            Export
          </button>
        </div>
      </header>

      <div style={STYLES.main}>
        {/* Sidebar */}
        <aside style={STYLES.sidebar}>
          {/* Color Preview */}
          <div style={{ ...STYLES.colorPreview, background: keyHex }}>
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

          {/* CMYK Gamut Warning */}
          {showCmyk && !keyInGamut && (
            <div style={STYLES.gamutWarning}>
              <span style={{ fontSize: 14 }}>!</span>
              Out of CMYK gamut — colors may shift in print
            </div>
          )}

          {/* HSL Sliders */}
          <div style={STYLES.section}>
            <div style={STYLES.sectionTitle}>Key Color</div>
            <HslSlider label="H" value={keyColor.h} min={0} max={360} onChange={setHue} gradient={hueGradient} />
            <HslSlider label="S" value={keyColor.s} min={0} max={100} onChange={setSaturation} gradient={satGradient} />
            <HslSlider label="L" value={keyColor.l} min={0} max={100} onChange={setLightness} gradient={litGradient} />
            <div style={{ marginTop: 8 }}>
              <HexInput value={keyHex} onChange={setHex} />
            </div>
          </div>

          {/* Harmony Mode */}
          <div style={STYLES.section}>
            <div style={STYLES.sectionTitle}>Harmony</div>
            <div style={STYLES.radioGroup}>
              {Object.entries(HARMONY_MODES).map(([key, mode]) => (
                <div
                  key={key}
                  style={{
                    ...STYLES.radioOption,
                    background: harmonyMode === key ? '#27272a' : 'transparent',
                  }}
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
          <div style={STYLES.section}>
            <div style={STYLES.sectionTitle}>Details — {selectedGroup.label}</div>
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
            />
          </div>

          {/* CVD Preview */}
          <CVDPreview rgb={selectedGroup.rgb} />
        </aside>

        {/* Main Content */}
        <main style={STYLES.content}>
          {/* Panel tabs */}
          <div style={{ ...STYLES.tabs, maxWidth: 500 }}>
            {[
              { key: 'palette', label: 'Palette' },
              { key: 'contrast', label: 'Contrast' },
              { key: 'export', label: 'Export' },
            ].map(t => (
              <button
                key={t.key}
                style={{ ...STYLES.tab, ...(activePanel === t.key ? STYLES.tabActive : {}) }}
                onClick={() => setActivePanel(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Palette Panel */}
          {activePanel === 'palette' && (
            <div>
              {allPaletteColors.map(group => {
                const isSelected = selectedColor === group.id || (!selectedColor && group.id === 'key')
                return (
                  <div key={group.id} style={STYLES.scaleRow}>
                    <div style={STYLES.scaleLabel}>
                      <div
                        style={{
                          width: 14, height: 14, borderRadius: 4,
                          background: group.hex,
                          border: '1px solid #3f3f46',
                        }}
                      />
                      <span
                        style={{ cursor: 'pointer', color: isSelected ? '#fafafa' : '#a1a1aa' }}
                        onClick={() => setSelectedColor(group.id)}
                      >
                        {group.label}
                      </span>
                      {contrastLocks[group.id] && (
                        <span style={{ ...STYLES.badge, background: '#1e3a5f', color: '#60a5fa' }}>
                          {contrastLocks[group.id].target}:1
                        </span>
                      )}
                      {showCmyk && !isApproxInCmykGamut(group.rgb.r, group.rgb.g, group.rgb.b) && (
                        <span style={{ ...STYLES.badge, background: '#422006', color: '#fbbf24' }}>
                          Out of gamut
                        </span>
                      )}
                    </div>
                    <div style={STYLES.scaleSwatches}>
                      {group.scale.map(swatch => {
                        const lum = relativeLuminance(swatch.rgb.r, swatch.rgb.g, swatch.rgb.b)
                        const textCol = lum > 0.179 ? '#09090b' : '#fafafa'
                        const isHovered = hoveredSwatch === `${group.id}-${swatch.step}`

                        return (
                          <div
                            key={swatch.step}
                            style={{
                              ...STYLES.scaleSwatch,
                              background: swatch.hex,
                              color: textCol,
                              transform: isHovered ? 'scaleY(1.15)' : 'none',
                              zIndex: isHovered ? 10 : 1,
                            }}
                            onMouseEnter={() => setHoveredSwatch(`${group.id}-${swatch.step}`)}
                            onMouseLeave={() => setHoveredSwatch(null)}
                            onClick={() => {
                              navigator.clipboard.writeText(swatch.hex)
                            }}
                            title={`${swatch.hex}\nClick to copy`}
                          >
                            {swatch.step}
                            {isHovered && (
                              <div style={STYLES.tooltip}>
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
              <div style={{ ...STYLES.sectionTitle, marginBottom: 16 }}>Contrast Ratio Matrix</div>
              <ContrastMatrix colors={matrixColors} />

              <div style={{ marginTop: 28 }}>
                <div style={STYLES.sectionTitle}>Quick Check</div>
                <div style={STYLES.contrastGrid}>
                  {allPaletteColors.map(group => {
                    const onWhite = contrastRatio(relativeLuminance(group.rgb.r, group.rgb.g, group.rgb.b), 1)
                    const onBlack = contrastRatio(relativeLuminance(group.rgb.r, group.rgb.g, group.rgb.b), 0)
                    const whiteLevel = wcagLevel(onWhite)
                    const blackLevel = wcagLevel(onBlack)
                    return (
                      <React.Fragment key={group.id}>
                        <div style={{ ...STYLES.contrastCell, background: '#ffffff', color: group.hex }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{group.label}</div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ ...STYLES.badge, background: wcagLevelColor(whiteLevel), color: '#09090b' }}>{whiteLevel}</span>
                            <span style={{ color: '#71717a', fontSize: 11 }}>{onWhite.toFixed(1)}:1</span>
                          </div>
                        </div>
                        <div style={{ ...STYLES.contrastCell, background: '#09090b', color: group.hex, border: '1px solid #27272a' }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{group.label}</div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ ...STYLES.badge, background: wcagLevelColor(blackLevel), color: '#09090b' }}>{blackLevel}</span>
                            <span style={{ color: '#71717a', fontSize: 11 }}>{onBlack.toFixed(1)}:1</span>
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
            <ExportPanel allColors={allPaletteColors} keyColor={keyColor} />
          )}
        </main>
      </div>
    </div>
  )
}
