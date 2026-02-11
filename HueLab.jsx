import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

// ============ CONSTANTS ============
const MAX_TOTAL_COLORS = 12;
const MAX_BRANCH_LEVEL = 3;
const BRANCH_COLORS = ['#f97316', '#22c55e', '#8b5cf6']; // Orange, Green, Purple for branch indicators

// CMYK Profile configurations - now with approximate Lab gamut boundaries
const CMYK_PROFILES = {
  'swop-v2': { 
    name: 'US Web Coated (SWOP) v2', 
    shortName: 'SWOP v2', 
    totalInkLimit: 300, 
    blackLimit: 100,
    // Approximate chroma limits at various hues (0-360) for L=50
    // Based on typical SWOP gamut measurements
    chromaLimit: 65
  },
  'fogra39': { 
    name: 'FOGRA39 (ISO Coated v2)', 
    shortName: 'FOGRA39', 
    totalInkLimit: 330, 
    blackLimit: 95,
    chromaLimit: 70 // Slightly larger gamut
  },
  'gracol': { 
    name: 'GRACoL 2013', 
    shortName: 'GRACoL', 
    totalInkLimit: 340, 
    blackLimit: 100,
    chromaLimit: 72 // Largest of the three
  }
};

// ============ COLOR.JS-STYLE PERCEPTUAL COLOR UTILITIES ============
// Using OKLab/OKLCH for perceptually uniform operations

// sRGB to Linear RGB
const srgbToLinear = (c) => {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

// Linear RGB to sRGB
const linearToSrgb = (c) => {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};

// sRGB to OKLab (perceptually uniform)
const srgbToOklab = (r, g, b) => {
  // Convert to linear sRGB
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);
  
  // Linear sRGB to LMS
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  
  // LMS to OKLab
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  };
};

// OKLab to sRGB
const oklabToSrgb = (L, a, b) => {
  // OKLab to LMS
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  
  // LMS to linear sRGB
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  
  // Linear to sRGB and clamp
  return {
    r: Math.round(Math.max(0, Math.min(255, linearToSrgb(lr) * 255))),
    g: Math.round(Math.max(0, Math.min(255, linearToSrgb(lg) * 255))),
    b: Math.round(Math.max(0, Math.min(255, linearToSrgb(lb) * 255)))
  };
};

// OKLab to OKLCH (cylindrical form - easier for hue operations)
const oklabToOklch = (L, a, b) => {
  const C = Math.sqrt(a * a + b * b);
  let h = Math.atan2(b, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
};

// OKLCH to OKLab
const oklchToOklab = (L, C, h) => {
  const hRad = h * Math.PI / 180;
  return {
    L,
    a: C * Math.cos(hRad),
    b: C * Math.sin(hRad)
  };
};

// HSL to RGB (traditional, for compatibility)
const hslToRgbRaw = (h, s, l) => {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)));
  };
  return { r: f(0), g: f(8), b: f(4) };
};

// RGB to HSL (traditional, for compatibility)
const rgbToHslRaw = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
      case g: h = ((b - r) / d + 2) * 60; break;
      case b: h = ((r - g) / d + 4) * 60; break;
    }
  }
  return { h, s: s * 100, l: l * 100 };
};

// Delta E (CIEDE2000 simplified - using OKLab Euclidean which is perceptually uniform)
const deltaEOK = (lab1, lab2) => {
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
};

// ============ CMYK GAMUT MAPPING (Perceptual) ============

// Approximate CMYK gamut check using OKLCH
// CMYK gamuts are roughly limited in chroma, especially at certain hue angles
const getCmykGamutLimit = (oklchH, oklchL, profile = 'swop-v2') => {
  const profileData = CMYK_PROFILES[profile];
  const baseChroma = profileData.chromaLimit / 100; // Normalize to 0-1 range for OKLCH
  
  // CMYK gamut is not uniform - it's tighter in certain hue regions
  // Blues and purples (h ~260-300) are particularly limited
  // Greens (h ~120-180) have moderate limits
  // Reds/Oranges (h ~0-60) are relatively good
  // Yellows (h ~80-110) are excellent
  
  let hueMultiplier = 1.0;
  if (oklchH >= 260 && oklchH <= 310) {
    // Blue-purple region - most limited
    hueMultiplier = 0.55;
  } else if (oklchH >= 170 && oklchH <= 260) {
    // Cyan-blue region
    hueMultiplier = 0.65;
  } else if (oklchH >= 120 && oklchH <= 170) {
    // Green-cyan region
    hueMultiplier = 0.75;
  } else if (oklchH >= 310 || oklchH <= 30) {
    // Magenta-red region
    hueMultiplier = 0.70;
  } else if (oklchH >= 80 && oklchH <= 110) {
    // Yellow region - best reproduction
    hueMultiplier = 0.95;
  } else {
    // Orange region
    hueMultiplier = 0.85;
  }
  
  // Lightness also affects gamut - extremes (very light/dark) have less chroma available
  const lightnessMultiplier = 1 - Math.pow(Math.abs(oklchL - 0.6) / 0.5, 2) * 0.4;
  
  return baseChroma * hueMultiplier * lightnessMultiplier;
};

// Check if color is in CMYK gamut
const isInCmykGamut = (r, g, b, profile = 'swop-v2') => {
  const oklab = srgbToOklab(r, g, b);
  const oklch = oklabToOklch(oklab.L, oklab.a, oklab.b);
  const limit = getCmykGamutLimit(oklch.h, oklch.L, profile);
  return oklch.C <= limit;
};

// Map color to CMYK gamut (perceptual - reduce chroma while preserving hue and lightness)
const mapToCmykGamut = (r, g, b, profile = 'swop-v2') => {
  const oklab = srgbToOklab(r, g, b);
  const oklch = oklabToOklch(oklab.L, oklab.a, oklab.b);
  const limit = getCmykGamutLimit(oklch.h, oklch.L, profile);
  
  if (oklch.C <= limit) {
    // Already in gamut
    return { r, g, b, wasInGamut: true };
  }
  
  // Map by reducing chroma to limit while keeping hue and lightness
  const mappedOklab = oklchToOklab(oklch.L, limit, oklch.h);
  const mappedRgb = oklabToSrgb(mappedOklab.L, mappedOklab.a, mappedOklab.b);
  
  return { ...mappedRgb, wasInGamut: false };
};

// Forward declaration note: getGamutAnalysis defined after CMYK functions

// Generate gamut boundary using OKLCH perceptual limits
// Note: This uses perceptual limits only; full round-trip verification is done in getGamutAnalysis
const generateGamutBoundary = (lightness, profile = 'swop-v2', steps = 72) => {
  const points = [];
  
  // Convert HSL lightness to approximate OKLab L
  const oklabL = lightness / 100;
  
  for (let i = 0; i < steps; i++) {
    const hue = (i / steps) * 360;
    
    // Binary search for max saturation using perceptual chroma limit
    let minSat = 0;
    let maxSat = 100;
    let safeSat = 0;
    
    for (let iter = 0; iter < 12; iter++) {
      const midSat = (minSat + maxSat) / 2;
      const testRgb = hslToRgbRaw(hue, midSat, lightness);
      
      // Check against perceptual chroma limit
      const oklab = srgbToOklab(testRgb.r, testRgb.g, testRgb.b);
      const oklch = oklabToOklch(oklab.L, oklab.a, oklab.b);
      const chromaLimit = getCmykGamutLimit(oklch.h, oklch.L, profile);
      
      if (oklch.C <= chromaLimit) {
        safeSat = midSat;
        minSat = midSat;
      } else {
        maxSat = midSat;
      }
    }
    
    points.push({ hue, maxSaturation: safeSat });
  }
  
  return points;
};

const hslToHex = (h, s, l) => {
  const rgb = hslToRgbRaw(h, s, l);
  return `#${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`;
};

const hexToHsl = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return rgbToHslRaw(r, g, b);
};

const hslToRgb = hslToRgbRaw;
const rgbToHsl = rgbToHslRaw;

// CMYK conversion (for display/export - uses simple formula, not ICC)
const rgbToCmyk = (r, g, b, profile = 'swop-v2') => {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  let c = (1 - r - k) / (1 - k);
  let m = (1 - g - k) / (1 - k);
  let y = (1 - b - k) / (1 - k);
  const profileData = CMYK_PROFILES[profile];
  const totalInk = (c + m + y + k) * 100;
  if (totalInk > profileData.totalInkLimit) {
    const scale = profileData.totalInkLimit / totalInk;
    c *= scale; m *= scale; y *= scale;
  }
  return { 
    c: Math.round(c * 100), 
    m: Math.round(m * 100), 
    y: Math.round(y * 100), 
    k: Math.round(Math.min(k * 100, profileData.blackLimit)) 
  };
};

// CMYK to RGB round-trip
const cmykToRgb = (c, m, y, k) => {
  c /= 100; m /= 100; y /= 100; k /= 100;
  return { 
    r: Math.round(255 * (1 - c) * (1 - k)), 
    g: Math.round(255 * (1 - m) * (1 - k)), 
    b: Math.round(255 * (1 - y) * (1 - k)) 
  };
};

// Perceptual delta E using OKLab (takes two RGB objects)
const deltaE = (rgb1, rgb2) => {
  const lab1 = srgbToOklab(rgb1.r, rgb1.g, rgb1.b);
  const lab2 = srgbToOklab(rgb2.r, rgb2.g, rgb2.b);
  return deltaEOK(lab1, lab2);
};

// Enhanced gamut check: combines perceptual limits AND round-trip verification
const getGamutAnalysis = (h, s, l, profile = 'swop-v2') => {
  const rgb = hslToRgbRaw(h, s, l);
  const oklab = srgbToOklab(rgb.r, rgb.g, rgb.b);
  const oklch = oklabToOklch(oklab.L, oklab.a, oklab.b);
  
  // Method 1: Check against perceptual chroma limits
  const chromaLimit = getCmykGamutLimit(oklch.h, oklch.L, profile);
  const perceptuallyInGamut = oklch.C <= chromaLimit;
  
  // Method 2: Do actual CMYK round-trip and check perceptual difference
  const cmyk = rgbToCmyk(rgb.r, rgb.g, rgb.b, profile);
  const roundTripRgb = cmykToRgb(cmyk.c, cmyk.m, cmyk.y, cmyk.k);
  const roundTripDelta = deltaE(rgb, roundTripRgb);
  
  // Color is in gamut if both checks pass
  // Delta E < 0.02 in OKLab is roughly "imperceptible"
  // Delta E < 0.05 is "barely noticeable"
  const roundTripInGamut = roundTripDelta < 0.03;
  const isInGamut = perceptuallyInGamut && roundTripInGamut;
  
  // Compute mapped color (reduce chroma to fit)
  let mappedRgb = rgb;
  let mappedHsl = { h, s, l };
  
  if (!isInGamut) {
    // Use perceptual gamut mapping (reduce chroma while preserving hue/lightness)
    const mapped = mapToCmykGamut(rgb.r, rgb.g, rgb.b, profile);
    mappedRgb = { r: mapped.r, g: mapped.g, b: mapped.b };
    mappedHsl = rgbToHslRaw(mapped.r, mapped.g, mapped.b);
  }
  
  // Compute how far out of gamut (as percentage)
  // Use the larger of chroma overshoot or round-trip delta
  const chromaOvershoot = perceptuallyInGamut ? 0 : ((oklch.C - chromaLimit) / chromaLimit) * 100;
  const deltaOvershoot = roundTripDelta * 500; // Scale delta to rough percentage
  const overshoot = Math.max(chromaOvershoot, isInGamut ? 0 : deltaOvershoot);
  
  return {
    original: { h, s, l, rgb },
    mapped: { ...mappedHsl, rgb: mappedRgb },
    isInGamut,
    overshoot: Math.round(Math.min(overshoot, 100)), // Cap at 100%
    oklch,
    gamutLimit: chromaLimit,
    roundTripDelta,
    cmyk
  };
};

// Legacy compatibility
const getGamutMappedColor = (h, s, l, profile = 'swop-v2') => {
  const analysis = getGamutAnalysis(h, s, l, profile);
  return {
    original: { h, s, l },
    mapped: analysis.mapped,
    isInGamut: analysis.isInGamut,
    cmyk: analysis.cmyk,
    deltaE: analysis.roundTripDelta
  };
};

// Value scale generation using perceptually uniform lightness (OKLab)
// Generate value scale anchored around base color
// The base color sits at the middle of the scale; values spread perceptually above/below
const generateValueScale = (h, s, l, count) => {
  const values = [];
  const rgb = hslToRgbRaw(h, s, l);
  const oklab = srgbToOklab(rgb.r, rgb.g, rgb.b);
  const oklch = oklabToOklch(oklab.L, oklab.a, oklab.b);
  
  // The base color's OKLab L
  const baseOklabL = oklch.L;
  
  // Middle index (for odd counts: 3→1, 5→2, 7→3, etc.)
  const midIndex = Math.floor(count / 2);
  
  // Define spread: how much L changes per step (in OKLab units)
  // Total range should be roughly 0.15 to 0.95, but centered on base
  const stepSize = 0.10; // Each step changes L by ~10% in perceptual space
  
  for (let i = 0; i < count; i++) {
    const stepsFromMid = i - midIndex;
    
    // Calculate target L, clamped to valid range
    let targetL = baseOklabL + (stepsFromMid * stepSize);
    targetL = Math.max(0.12, Math.min(0.95, targetL));
    
    // Reduce chroma at extremes (very light/dark colors can't hold as much saturation)
    const chromaScale = 1 - Math.pow(Math.abs(targetL - 0.55) / 0.5, 2) * 0.6;
    const targetC = oklch.C * chromaScale;
    
    // Convert back to RGB then HSL
    const stepOklab = oklchToOklab(targetL, targetC, oklch.h);
    const stepRgb = oklabToSrgb(stepOklab.L, stepOklab.a, stepOklab.b);
    
    // Clamp RGB values
    const clampedRgb = {
      r: Math.max(0, Math.min(255, stepRgb.r)),
      g: Math.max(0, Math.min(255, stepRgb.g)),
      b: Math.max(0, Math.min(255, stepRgb.b))
    };
    
    const stepHsl = rgbToHslRaw(clampedRgb.r, clampedRgb.g, clampedRgb.b);
    values.push({ 
      h: stepHsl.h, 
      s: Math.round(stepHsl.s), 
      l: Math.round(stepHsl.l),
      isBase: i === midIndex // Mark the base/anchor value
    });
  }
  return values;
};

// ============ CONTRAST RATIO CALCULATIONS (WCAG) ============
const getRelativeLuminance = (r, g, b) => {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
};

const getContrastRatio = (rgb1, rgb2) => {
  const l1 = getRelativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const l2 = getRelativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
};

const WHITE_RGB = { r: 255, g: 255, b: 255 };
const BLACK_RGB = { r: 0, g: 0, b: 0 };

const CONTRAST_PRESETS = [
  { id: 'aa-large', label: 'AA Large', ratio: 3, description: 'Large text (18pt+)' },
  { id: 'aa', label: 'AA', ratio: 4.5, description: 'Normal text' },
  { id: 'aaa', label: 'AAA', ratio: 7, description: 'Enhanced' },
  { id: 'custom', label: 'Custom', ratio: null, description: 'Set your own' }
];

// ============ CONTRAST SOLVER ============
// Find the L value that hits a target contrast ratio while preserving H and S
const solveForContrast = (h, s, targetRatio, background = 'white') => {
  const bgRgb = background === 'white' ? WHITE_RGB : BLACK_RGB;
  const bgLuminance = background === 'white' ? 1.0 : 0.0;
  
  let minL = 0;
  let maxL = 100;
  let bestL = 50;
  let bestDiff = Infinity;
  let solutionFound = false;
  
  // Binary search for the L that hits the target
  for (let i = 0; i < 20; i++) {
    const midL = (minL + maxL) / 2;
    const rgb = hslToRgb(h, s, midL);
    const contrast = getContrastRatio(rgb, bgRgb);
    const diff = Math.abs(contrast - targetRatio);
    
    if (diff < bestDiff) {
      bestDiff = diff;
      bestL = midL;
      if (diff < 0.05) solutionFound = true;
    }
    
    if (background === 'white') {
      // Against white: lower L = higher contrast
      if (contrast < targetRatio) {
        maxL = midL; // Need darker
      } else {
        minL = midL; // Can go lighter
      }
    } else {
      // Against black: higher L = higher contrast
      if (contrast < targetRatio) {
        minL = midL; // Need lighter
      } else {
        maxL = midL; // Can go darker
      }
    }
  }
  
  // Verify the solution
  const finalRgb = hslToRgb(h, s, bestL);
  const finalContrast = getContrastRatio(finalRgb, bgRgb);
  
  return {
    l: Math.round(bestL),
    achievedRatio: Math.round(finalContrast * 100) / 100,
    meetsTarget: finalContrast >= targetRatio - 0.05,
    solutionFound
  };
};

// Find valid L range that satisfies contrast requirements
const findContrastRange = (h, s, targetRatio, background = 'white') => {
  const bgRgb = background === 'white' ? WHITE_RGB : BLACK_RGB;
  const results = [];
  
  // Sample L values and find where contrast threshold is crossed
  for (let l = 0; l <= 100; l += 1) {
    const rgb = hslToRgb(h, s, l);
    const contrast = getContrastRatio(rgb, bgRgb);
    results.push({ l, contrast, passes: contrast >= targetRatio });
  }
  
  // Find crossing points
  const crossings = [];
  for (let i = 1; i < results.length; i++) {
    if (results[i].passes !== results[i-1].passes) {
      crossings.push({
        l: results[i].passes ? results[i].l : results[i-1].l,
        type: results[i].passes ? 'enters' : 'exits'
      });
    }
  }
  
  // Determine valid range
  let minValid = null;
  let maxValid = null;
  
  if (background === 'white') {
    // Against white: darker colors pass (lower L)
    const passingLs = results.filter(r => r.passes).map(r => r.l);
    if (passingLs.length > 0) {
      minValid = Math.min(...passingLs);
      maxValid = Math.max(...passingLs);
    }
  } else {
    // Against black: lighter colors pass (higher L)
    const passingLs = results.filter(r => r.passes).map(r => r.l);
    if (passingLs.length > 0) {
      minValid = Math.min(...passingLs);
      maxValid = Math.max(...passingLs);
    }
  }
  
  return {
    minL: minValid,
    maxL: maxValid,
    hasValidRange: minValid !== null,
    crossings
  };
};

// ============ HARMONY CALCULATIONS ============
const getHarmonyOffsets = (mode, numColors, analogousSpread = 10) => {
  switch (mode) {
    case 'equidistant': return Array.from({ length: numColors }, (_, i) => (360 / numColors) * i);
    case 'complementary': return [0, 180];
    case 'triadic': return [0, 120, 240];
    case 'tetradic': return [0, 90, 180, 270];
    case 'analogous': 
      // Centered spread: anchor in middle, colors spread evenly around it
      return Array.from({ length: numColors }, (_, i) => (i - Math.floor(numColors / 2)) * analogousSpread);
    case 'split-complementary': return [0, 150, 210];
    default: return [0];
  }
};

const getHarmonyColorCount = (mode, requestedCount) => {
  switch (mode) {
    case 'complementary': return 2;
    case 'triadic': return 3;
    case 'tetradic': return 4;
    case 'split-complementary': return 3;
    case 'analogous': return Math.min(requestedCount, 6); // Cap at 6
    case 'equidistant':
    default: return requestedCount;
  }
};

// ============ COLOR SENSE - HARMONY DETECTION ============
const detectNearHarmonies = (allColors) => {
  const suggestions = [];
  const threshold = 8; // Degrees threshold for "near" harmony
  
  for (let i = 0; i < allColors.length; i++) {
    for (let j = i + 1; j < allColors.length; j++) {
      const c1 = allColors[i];
      const c2 = allColors[j];
      const hueDiff = Math.abs(c1.h - c2.h);
      const normalizedDiff = Math.min(hueDiff, 360 - hueDiff);
      
      // Check for near-complementary (180°)
      if (Math.abs(normalizedDiff - 180) <= threshold && Math.abs(normalizedDiff - 180) > 0) {
        const adjustment = 180 - normalizedDiff;
        suggestions.push({
          type: 'complementary',
          colors: [c1, c2],
          message: `${c1.name} and ${c2.name} are ${Math.abs(adjustment).toFixed(0)}° from complementary`,
          adjustment
        });
      }
      
      // Check for near-triadic with a third color
      for (let k = j + 1; k < allColors.length; k++) {
        const c3 = allColors[k];
        const diff12 = Math.min(Math.abs(c1.h - c2.h), 360 - Math.abs(c1.h - c2.h));
        const diff23 = Math.min(Math.abs(c2.h - c3.h), 360 - Math.abs(c2.h - c3.h));
        const diff13 = Math.min(Math.abs(c1.h - c3.h), 360 - Math.abs(c1.h - c3.h));
        
        // Perfect triad would be 120° apart
        const triadError = Math.abs(diff12 - 120) + Math.abs(diff23 - 120) + Math.abs(diff13 - 120);
        if (triadError <= threshold * 3 && triadError > 0) {
          suggestions.push({
            type: 'triadic',
            colors: [c1, c2, c3],
            message: `${c1.name}, ${c2.name}, ${c3.name} are near-triadic (${Math.round(triadError)}° total adjustment)`,
            adjustment: triadError
          });
        }
      }
    }
  }
  
  // Sort by smallest adjustment needed
  return suggestions.sort((a, b) => Math.abs(a.adjustment) - Math.abs(b.adjustment)).slice(0, 3);
};

// ============ ICONS ============
const LockIcon = ({ locked, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    {locked ? (<><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>) 
            : (<><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>)}
  </svg>
);

const RotateIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
  </svg>
);

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);

const ExportIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
  </svg>
);

const BranchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/>
  </svg>
);

const LightbulbIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z"/>
  </svg>
);

const LinkIcon = ({ linked }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    {linked ? (
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </>
    ) : (
      <>
        <path d="M9 17H7A5 5 0 0 1 7 7h2"/>
        <path d="M15 7h2a5 5 0 1 1 0 10h-2"/>
        <line x1="8" y1="12" x2="16" y2="12" strokeDasharray="2 2"/>
      </>
    )}
  </svg>
);

// ============ MAIN COMPONENT ============
export default function HueLab() {
  // Core state
  const [keyColor, setKeyColor] = useState({ h: 58, s: 98, l: 66 }); // #FDF854
  const [globalRotation, setGlobalRotation] = useState(0);
  
  // Branch system
  const [branches, setBranches] = useState([{
    id: 'branch-1',
    level: 1,
    parentBranchId: null,
    parentColorIndex: null,
    harmonyMode: 'split-complementary',
    numColors: 3,
    localRotation: 0,
    analogousSpread: 10, // degrees between each color in analogous mode
    locked: false
  }]);
  const [activeBranchId, setActiveBranchId] = useState('branch-1');
  const [selectedColorId, setSelectedColorId] = useState(null);
  
  // Color overrides (for individual color adjustments)
  const [colorOverrides, setColorOverrides] = useState({});
  const [valueCounts, setValueCounts] = useState({});
  const [unlinkedColors, setUnlinkedColors] = useState({}); // Colors unlinked from Room
  
  // Contrast locks - non-destructive L targeting
  // Structure: { [colorId]: { target: 4.5, background: 'white'|'black', enabled: true } }
  const [contrastLocks, setContrastLocks] = useState({});
  const [solveMode, setSolveMode] = useState(null); // colorId currently in solve mode
  
  // Lab settings
  const [uniformValueCount, setUniformValueCount] = useState(true);
  const [globalValueCount, setGlobalValueCount] = useState(5);
  
  // UI state
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [activeExport, setActiveExport] = useState(null);
  const [cmykMode, setCmykMode] = useState(false);
  const [cmykProfile, setCmykProfile] = useState('swop-v2');
  const [gamutBoundary, setGamutBoundary] = useState([]);
  const [showColorSense, setShowColorSense] = useState(false);
  const [hexInput, setHexInput] = useState('#FDF854');
  const [rgbInput, setRgbInput] = useState({ r: 253, g: 248, b: 84 });
  const [preservedHex, setPreservedHex] = useState('#FDF854'); // Preserve exact user input
  
  // Contrast ratio settings
  const [contrastTarget, setContrastTarget] = useState('aa');
  const [customContrastRatio, setCustomContrastRatio] = useState(4.5);
  const [showContrastInfo, setShowContrastInfo] = useState(true);
  
  const targetContrastRatio = contrastTarget === 'custom' 
    ? customContrastRatio 
    : CONTRAST_PRESETS.find(p => p.id === contrastTarget)?.ratio || 4.5;
  
  const canvasRef = useRef(null);
  const defaultS = 80, defaultL = 50;

  // ============ COMPUTE ALL COLORS FROM BRANCHES ============
  const allColors = useMemo(() => {
    const colors = [];
    let colorIndex = 0;
    
    const processBranch = (branch, parentAnchorHue = null) => {
      // Determine this branch's anchor hue
      let anchorHue;
      if (branch.level === 1) {
        anchorHue = (keyColor.h + globalRotation) % 360;
      } else {
        // Child branch: anchor is inherited from parent color
        const parentBranch = branches.find(b => b.id === branch.parentBranchId);
        if (parentBranch && parentAnchorHue !== null) {
          const parentOffsets = getHarmonyOffsets(parentBranch.harmonyMode, getHarmonyColorCount(parentBranch.harmonyMode, parentBranch.numColors), parentBranch.analogousSpread);
          const parentColorHue = (parentAnchorHue + parentOffsets[branch.parentColorIndex] + parentBranch.localRotation) % 360;
          anchorHue = parentColorHue;
        } else {
          anchorHue = 0;
        }
      }
      
      // Generate colors for this branch
      const offsets = getHarmonyOffsets(branch.harmonyMode, getHarmonyColorCount(branch.harmonyMode, branch.numColors), branch.analogousSpread);
      const branchColors = [];
      
      offsets.forEach((offset, i) => {
        // For child branches, skip index 0 (the anchor) as it's inherited
        if (branch.level > 1 && i === 0) return;
        
        // Level 3 can only have 1 additional color
        if (branch.level === 3 && i > 1) return;
        
        const baseHue = (anchorHue + offset + branch.localRotation + 360) % 360;
        const colorId = `${branch.id}-color-${i}`;
        
        // Check if color is unlinked (independent from Room)
        const isUnlinked = unlinkedColors[colorId];
        const override = colorOverrides[colorId] || {};
        
        let h, s, l;
        
        if (isUnlinked && isUnlinked.h !== undefined) {
          // Unlinked: use stored independent values
          h = override.h !== undefined ? override.h : isUnlinked.h;
          s = override.s !== undefined ? override.s : isUnlinked.s;
          l = override.l !== undefined ? override.l : isUnlinked.l;
        } else {
          // Linked: compute from Room
          h = override.h !== undefined ? override.h : baseHue;
          s = override.s !== undefined ? override.s : keyColor.s;
          l = override.l !== undefined ? override.l : keyColor.l;
        }
        
        // Store baseline for reset (what Room would give)
        const roomBaseline = { h: baseHue, s: keyColor.s, l: keyColor.l };
        
        // Apply contrast lock if enabled (recalculate L to hit target ratio, preserve H)
        const contrastLock = contrastLocks[colorId];
        let contrastLockResult = null;
        
        if (contrastLock?.enabled) {
          // Solve for L that hits the target contrast ratio
          const solved = solveForContrast(h, s, contrastLock.target, contrastLock.background);
          contrastLockResult = {
            ...solved,
            target: contrastLock.target,
            background: contrastLock.background
          };
          
          if (solved.solutionFound) {
            l = solved.l; // Apply the solved L, preserving H
          }
        }
        
        // CMYK gamut mapping (perceptual)
        let cmyk = null;
        let isInGamut = true;
        let gamutOvershoot = 0;
        
        const rgb = hslToRgbRaw(h, s, l);
        const gamutAnalysis = getGamutAnalysis(h, s, l, cmykProfile);
        isInGamut = gamutAnalysis.isInGamut;
        gamutOvershoot = gamutAnalysis.overshoot;
        
        if (cmykMode && !gamutAnalysis.isInGamut) {
          // Apply perceptual gamut mapping
          h = gamutAnalysis.mapped.h;
          s = gamutAnalysis.mapped.s;
          l = gamutAnalysis.mapped.l;
        }
        
        // Always compute CMYK for display
        const finalRgb = hslToRgbRaw(h, s, l);
        cmyk = { 
          ...rgbToCmyk(finalRgb.r, finalRgb.g, finalRgb.b, cmykProfile), 
          isInGamut,
          overshoot: gamutOvershoot
        };
        
        // Value count: uniform or individual (odd numbers only)
        const valueCount = uniformValueCount 
          ? globalValueCount 
          : (valueCounts[colorId] || globalValueCount);
        
        branchColors.push({
          id: colorId,
          branchId: branch.id,
          branchLevel: branch.level,
          index: colorIndex++,
          colorIndexInBranch: i,
          h, s, l,
          roomBaseline, // Store for reset
          isUnlinked: !!isUnlinked,
          contrastLock: contrastLockResult, // Contrast lock status
          isAnchor: i === 0,
          locked: branch.locked || (override.locked === true),
          valueCount,
          cmyk,
          name: `Color ${colorIndex}`
        });
      });
      
      colors.push(...branchColors);
      
      // Process child branches
      branches
        .filter(b => b.parentBranchId === branch.id)
        .forEach(childBranch => processBranch(childBranch, anchorHue));
    };
    
    // Start with root branches
    branches.filter(b => b.level === 1).forEach(b => processBranch(b));
    
    return colors;
  }, [branches, keyColor, globalRotation, colorOverrides, valueCounts, unlinkedColors, contrastLocks, uniformValueCount, globalValueCount, cmykMode, cmykProfile]);

  // Total color count
  const totalColorCount = allColors.length;

  // Color sense suggestions
  const colorSenseSuggestions = useMemo(() => {
    if (!showColorSense) return [];
    return detectNearHarmonies(allColors);
  }, [allColors, showColorSense]);

  // Active branch
  const activeBranch = branches.find(b => b.id === activeBranchId);

  // ============ EFFECTS ============
  
  // Gamut boundary
  useEffect(() => {
    if (cmykMode) {
      setGamutBoundary(generateGamutBoundary(keyColor.l, cmykProfile, 72));
    } else {
      setGamutBoundary([]);
    }
  }, [cmykMode, cmykProfile, keyColor.l]);

  // Draw wheel
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const center = size / 2;
    const radius = size / 2;
    
    ctx.clearRect(0, 0, size, size);
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - center;
        const dy = y - center;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= radius) {
          let hue = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
          if (hue < 0) hue += 360;
          const saturation = (distance / radius) * 100;
          const rgb = hslToRgbRaw(hue, saturation, keyColor.l);
          const idx = (y * size + x) * 4;
          data[idx] = rgb.r; data[idx + 1] = rgb.g; data[idx + 2] = rgb.b; data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }, [keyColor.l]);

  // Sync inputs only when keyColor changes from wheel interaction
  useEffect(() => {
    // Only update if we don't have a preserved hex (meaning change came from wheel or other source)
    if (!preservedHex) {
      setHexInput(hslToHex(keyColor.h, keyColor.s, keyColor.l));
      setRgbInput(hslToRgb(keyColor.h, keyColor.s, keyColor.l));
    }
  }, [keyColor, preservedHex]);
  
  // Compute key color CMYK and gamut status (using perceptual analysis)
  const keyColorRgb = hslToRgb(keyColor.h, keyColor.s, keyColor.l);
  const keyColorGamutAnalysis = getGamutAnalysis(keyColor.h, keyColor.s, keyColor.l, cmykProfile);
  const keyColorCmyk = rgbToCmyk(keyColorRgb.r, keyColorRgb.g, keyColorRgb.b, cmykProfile);
  const keyColorInGamut = keyColorGamutAnalysis.isInGamut;
  const keyColorOvershoot = keyColorGamutAnalysis.overshoot;

  // ============ HANDLERS ============
  const handleHexChange = (hex) => {
    setHexInput(hex);
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      setPreservedHex(hex.toUpperCase()); // Store exact hex
      const hsl = hexToHsl(hex);
      setKeyColor(hsl);
      const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      setRgbInput(rgb);
    }
  };

  const handleRgbChange = (channel, value) => {
    const newRgb = { ...rgbInput, [channel]: Math.max(0, Math.min(255, parseInt(value) || 0)) };
    setRgbInput(newRgb);
    const hsl = rgbToHsl(newRgb.r, newRgb.g, newRgb.b);
    setKeyColor(hsl);
    // Clear preserved hex since we're changing via RGB
    setPreservedHex(null);
    setHexInput(hslToHex(hsl.h, hsl.s, hsl.l));
  };

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  const selectColor = (colorId) => {
    setSelectedColorId(selectedColorId === colorId ? null : colorId);
  };

  const toggleColorLock = (colorId) => {
    setColorOverrides(prev => ({
      ...prev,
      [colorId]: { ...prev[colorId], locked: !prev[colorId]?.locked }
    }));
  };

  const updateColorProperty = (colorId, prop, value) => {
    // Auto-unlink when editing S or L in the Lab
    if ((prop === 's' || prop === 'l') && !unlinkedColors[colorId]) {
      const color = allColors.find(c => c.id === colorId);
      if (color) {
        setUnlinkedColors(prev => ({
          ...prev,
          [colorId]: { h: color.h, s: color.s, l: color.l }
        }));
      }
    }
    
    setColorOverrides(prev => ({
      ...prev,
      [colorId]: { ...prev[colorId], [prop]: value }
    }));
  };

  const unlinkColor = (colorId) => {
    const color = allColors.find(c => c.id === colorId);
    if (color) {
      setUnlinkedColors(prev => ({
        ...prev,
        [colorId]: { h: color.h, s: color.s, l: color.l }
      }));
    }
  };

  const relinkColor = (colorId) => {
    // Remove from unlinked and clear overrides to return to Room baseline
    setUnlinkedColors(prev => {
      const updated = { ...prev };
      delete updated[colorId];
      return updated;
    });
    setColorOverrides(prev => {
      const updated = { ...prev };
      if (updated[colorId]) {
        delete updated[colorId].h;
        delete updated[colorId].s;
        delete updated[colorId].l;
        if (Object.keys(updated[colorId]).length === 0) {
          delete updated[colorId];
        }
      }
      return updated;
    });
    // Also clear contrast lock when relinking
    setContrastLocks(prev => {
      const updated = { ...prev };
      delete updated[colorId];
      return updated;
    });
  };

  // Contrast lock functions
  const setContrastLock = (colorId, target, background) => {
    setContrastLocks(prev => ({
      ...prev,
      [colorId]: { target, background, enabled: true }
    }));
    setSolveMode(null); // Exit solve mode after applying
  };

  const clearContrastLock = (colorId) => {
    setContrastLocks(prev => {
      const updated = { ...prev };
      delete updated[colorId];
      return updated;
    });
  };

  const toggleContrastLock = (colorId) => {
    setContrastLocks(prev => {
      if (prev[colorId]) {
        return {
          ...prev,
          [colorId]: { ...prev[colorId], enabled: !prev[colorId].enabled }
        };
      }
      return prev;
    });
  };

  const resetColorProperty = (colorId, prop) => {
    setColorOverrides(prev => {
      const updated = { ...prev };
      if (updated[colorId]) {
        delete updated[colorId][prop];
        if (Object.keys(updated[colorId]).length === 0) delete updated[colorId];
      }
      return updated;
    });
  };

  const updateValueCount = (colorId, count) => {
    // Ensure odd numbers only
    const oddCounts = [3, 5, 7, 9, 11, 13];
    const validCount = oddCounts.includes(count) ? count : 5;
    setValueCounts(prev => ({ ...prev, [colorId]: validCount }));
  };

  const updateBranchProperty = (branchId, prop, value) => {
    setBranches(prev => prev.map(b => {
      if (b.id !== branchId) return b;
      
      let updates = { [prop]: value };
      
      // Auto-clamp numColors when switching to analogous
      if (prop === 'harmonyMode' && value === 'analogous' && b.numColors > 6) {
        updates.numColors = 6;
      }
      
      return { ...b, ...updates };
    }));
  };

  const lockAllInBranch = (branchId, locked) => {
    const branchColors = allColors.filter(c => c.branchId === branchId);
    const newOverrides = { ...colorOverrides };
    branchColors.forEach(c => {
      newOverrides[c.id] = { ...newOverrides[c.id], locked };
    });
    setColorOverrides(newOverrides);
  };

  // ============ BRANCHING ============
  const canCreateBranch = () => {
    if (!selectedColorId) return false;
    const selectedColor = allColors.find(c => c.id === selectedColorId);
    if (!selectedColor) return false;
    
    const selectedBranch = branches.find(b => b.id === selectedColor.branchId);
    if (selectedBranch.level >= MAX_BRANCH_LEVEL) return false;
    
    // Check color limit
    const newBranchMinColors = selectedBranch.level === 2 ? 1 : 2; // Level 3 gets 1, level 2 gets 2
    if (totalColorCount + newBranchMinColors > MAX_TOTAL_COLORS) return false;
    
    // Check if already has a branch from this color
    const existingChild = branches.find(b => b.parentBranchId === selectedBranch.id && b.parentColorIndex === selectedColor.colorIndexInBranch);
    if (existingChild) return false;
    
    return true;
  };

  const createBranch = () => {
    if (!canCreateBranch()) return;
    
    const selectedColor = allColors.find(c => c.id === selectedColorId);
    const parentBranch = branches.find(b => b.id === selectedColor.branchId);
    
    const newBranch = {
      id: `branch-${Date.now()}`,
      level: parentBranch.level + 1,
      parentBranchId: parentBranch.id,
      parentColorIndex: selectedColor.colorIndexInBranch,
      harmonyMode: 'analogous',
      numColors: parentBranch.level === 2 ? 2 : 3, // Level 3 only gets 1 new color (2 includes anchor)
      localRotation: 0,
      analogousSpread: 10,
      locked: false
    };
    
    // Lock parent branch
    setBranches(prev => prev.map(b => 
      b.id === parentBranch.id ? { ...b, locked: true } : b
    ).concat(newBranch));
    
    setActiveBranchId(newBranch.id);
    setSelectedColorId(null);
  };

  const deleteBranch = (branchId) => {
    const branch = branches.find(b => b.id === branchId);
    if (!branch || branch.level === 1) return; // Can't delete root
    
    // Find all descendant branches
    const getDescendants = (parentId) => {
      const children = branches.filter(b => b.parentBranchId === parentId);
      return children.concat(children.flatMap(c => getDescendants(c.id)));
    };
    const toDelete = [branchId, ...getDescendants(branchId).map(b => b.id)];
    
    // Unlock parent
    setBranches(prev => prev
      .filter(b => !toDelete.includes(b.id))
      .map(b => b.id === branch.parentBranchId ? { ...b, locked: false } : b)
    );
    
    setActiveBranchId(branch.parentBranchId);
  };

  // ============ EXPORT ============
  const generateExport = (format) => {
    const colorData = allColors.map((c, i) => {
      const hex = hslToHex(c.h, c.s, c.l);
      const rgb = hslToRgb(c.h, c.s, c.l);
      const cmyk = c.cmyk || rgbToCmyk(rgb.r, rgb.g, rgb.b, cmykProfile);
      const gamutAnalysis = getGamutAnalysis(c.h, c.s, c.l, cmykProfile);
      const contrastOnWhite = getContrastRatio(rgb, WHITE_RGB);
      const contrastOnBlack = getContrastRatio(rgb, BLACK_RGB);
      
      return {
        name: `color-${i + 1}`,
        branch: c.branchId,
        hex,
        rgb,
        cmyk: {
          c: cmyk.c,
          m: cmyk.m,
          y: cmyk.y,
          k: cmyk.k,
          profile: CMYK_PROFILES[cmykProfile].shortName,
          inGamut: gamutAnalysis.isInGamut,
          overshoot: gamutAnalysis.overshoot
        },
        contrast: {
          onWhite: Math.round(contrastOnWhite * 100) / 100,
          onBlack: Math.round(contrastOnBlack * 100) / 100
        },
        values: generateValueScale(c.h, c.s, c.l, c.valueCount).map((v, vi) => {
          const vRgb = hslToRgb(v.h, v.s, v.l);
          const vGamut = getGamutAnalysis(v.h, v.s, v.l, cmykProfile);
          return {
            step: vi + 1,
            hex: hslToHex(v.h, v.s, v.l),
            rgb: vRgb,
            cmyk: {
              ...rgbToCmyk(vRgb.r, vRgb.g, vRgb.b, cmykProfile),
              inGamut: vGamut.isInGamut,
              overshoot: vGamut.overshoot
            },
            contrast: {
              onWhite: Math.round(getContrastRatio(vRgb, WHITE_RGB) * 100) / 100,
              onBlack: Math.round(getContrastRatio(vRgb, BLACK_RGB) * 100) / 100
            }
          };
        })
      };
    });

    switch (format) {
      case 'css':
        let css = `/* Hue Lab Export\n   CMYK Profile: ${CMYK_PROFILES[cmykProfile].shortName}\n   Contrast Target: ${targetContrastRatio}:1\n   Gamut analysis: OKLab perceptual (approximate)\n*/\n:root {\n`;
        colorData.forEach(c => {
          const gamutNote = c.cmyk.inGamut ? '' : ` ⚠ ${c.cmyk.overshoot}% OUT OF GAMUT`;
          css += `  /* ${c.name}: CMYK(${c.cmyk.c}, ${c.cmyk.m}, ${c.cmyk.y}, ${c.cmyk.k})${gamutNote} */\n`;
          css += `  --${c.name}: ${c.hex};\n`;
          c.values.forEach((v, i) => { 
            const passesWhite = v.contrast.onWhite >= targetContrastRatio;
            const passesBlack = v.contrast.onBlack >= targetContrastRatio;
            const contrastNote = passesWhite && passesBlack ? '✓ both' : passesWhite ? '✓ white' : passesBlack ? '✓ black' : '✗';
            const vGamutNote = v.cmyk.inGamut ? '' : ` ⚠${v.cmyk.overshoot}%`;
            css += `  --${c.name}-${(i + 1) * 100}: ${v.hex}; /* ${v.contrast.onWhite}:1 white, ${v.contrast.onBlack}:1 black ${contrastNote}${vGamutNote} */\n`; 
          });
        });
        return css + '}';
      case 'json': return JSON.stringify(colorData, null, 2);
      case 'tokens':
        const tokens = { 
          $schema: "https://design-tokens.org/schema.json",
          meta: { 
            cmykProfile: CMYK_PROFILES[cmykProfile].shortName,
            contrastTarget: targetContrastRatio,
            gamutMethod: 'OKLab perceptual (approximate)'
          },
          color: {} 
        };
        colorData.forEach(c => {
          tokens.color[c.name] = { 
            $value: c.hex, 
            $type: 'color', 
            cmyk: c.cmyk, 
            contrast: c.contrast,
            scales: {} 
          };
          c.values.forEach((v, i) => { 
            tokens.color[c.name].scales[(i + 1) * 100] = { 
              $value: v.hex, 
              $type: 'color',
              cmyk: v.cmyk,
              contrast: v.contrast 
            }; 
          });
        });
        return JSON.stringify(tokens, null, 2);
      case 'hex': return colorData.map(c => c.hex).join('\n');
      case 'cmyk': 
        let cmykExport = `/* CMYK Values - ${CMYK_PROFILES[cmykProfile].shortName}\n   Gamut: OKLab perceptual (verify in production software) */\n`;
        colorData.forEach(c => {
          const gamutNote = c.cmyk.inGamut ? '' : ` ⚠ ${c.cmyk.overshoot}% OUT`;
          cmykExport += `${c.name}: C${c.cmyk.c} M${c.cmyk.m} Y${c.cmyk.y} K${c.cmyk.k}${gamutNote}\n`;
        });
        return cmykExport;
      default: return '';
    }
  };

  // Wheel config
  const wheelSize = 320;
  const wheelCenter = wheelSize / 2;
  const wheelRadius = wheelSize / 2;
  const colorPointRadius = 18;
  const pointInset = 30;

  const getPointPosition = (hue, saturation = 100) => {
    const angle = (hue - 90) * (Math.PI / 180);
    const radius = (saturation / 100) * (wheelRadius - pointInset);
    return { x: wheelCenter + radius * Math.cos(angle), y: wheelCenter + radius * Math.sin(angle) };
  };

  const harmonyModes = [
    { id: 'equidistant', label: 'Equidistant', icon: '⬡' },
    { id: 'analogous', label: 'Analogous', icon: '⌓' },
    { id: 'complementary', label: 'Complementary', icon: '◑' },
    { id: 'split-complementary', label: 'Split Comp.', icon: 'Y' },
    { id: 'triadic', label: 'Triadic', icon: '△' },
    { id: 'tetradic', label: 'Tetradic', icon: '◇' },
  ];
  
  const harmonyModeIndex = harmonyModes.findIndex(m => m.id === activeBranch?.harmonyMode) || 0;
  const contrastPresetIndex = CONTRAST_PRESETS.findIndex(p => p.id === contrastTarget);
  const cmykProfileIndex = Object.keys(CMYK_PROFILES).indexOf(cmykProfile);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#0a0a0b', color: '#e4e4e7', fontFamily: "'JetBrains Mono', 'SF Mono', monospace", padding: '24px', boxSizing: 'border-box' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        .radial-btn { width: 40px; height: 40px; min-width: 40px; min-height: 40px; border-radius: 50%; border: 1px solid #27272a; background: #18181b; color: #a1a1aa; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s ease; font-size: 16px; flex-shrink: 0; aspect-ratio: 1; }
        .radial-btn:hover { border-color: #3f3f46; background: #27272a; color: #e4e4e7; }
        .radial-btn.active { border-color: #f97316; background: rgba(249, 115, 22, 0.15); color: #f97316; }
        .radial-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .input-field { background: #18181b; border: 1px solid #27272a; border-radius: 6px; padding: 8px 10px; color: #e4e4e7; font-family: inherit; font-size: 12px; outline: none; transition: border-color 0.2s; width: 100%; }
        .input-field:focus { border-color: #f97316; }
        select.input-field { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; padding-right: 28px; }
        select.input-field option { background: #18181b; color: #e4e4e7; }
        input[type="range"] { -webkit-appearance: none; width: 100%; height: 6px; background: #27272a; border-radius: 3px; cursor: pointer; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #e4e4e7; border: 2px solid #0a0a0b; cursor: grab; }
        .value-swatch { height: 36px; flex: 1; min-width: 24px; border-radius: 4px; cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease; position: relative; }
        .value-swatch:hover { transform: scaleY(1.15); z-index: 1; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
        .control-panel { background: #0d0d0e; border: 1px solid #1a1a1d; border-radius: 12px; padding: 16px; }
        .section-label { font-size: 10px; color: #52525b; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 10px; }
        .branch-indicator { width: 4px; border-radius: 2px; margin-right: 8px; }
        .color-sense-card { background: #1a1a1d; border: 1px solid #27272a; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
        .dashboard-container { background: #111113; border: 1px solid #1f1f23; border-radius: 20px; padding: 24px; max-width: 1400px; margin: 0 auto; }
        @media (max-width: 1100px) { .dashboard-layout { flex-direction: column !important; } }
      `}</style>

      {/* Header */}
      <div style={{ maxWidth: '1400px', margin: '0 auto 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: '24px', fontWeight: 600, margin: 0, letterSpacing: '-0.5px' }}>Hue Lab</h1>
          <p style={{ color: '#52525b', margin: '6px 0 0', fontSize: '12px' }}>Branching color system builder • {totalColorCount}/{MAX_TOTAL_COLORS} colors</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {cmykMode && <div style={{ background: 'rgba(249,115,22,0.15)', border: '1px solid #f97316', borderRadius: '4px', padding: '4px 8px', fontSize: '10px', color: '#f97316' }}>CMYK: {CMYK_PROFILES[cmykProfile].shortName}</div>}
        </div>
      </div>

      {/* Main Dashboard */}
      <div className="dashboard-container">
        <div className="dashboard-layout" style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
          
          {/* Left Controls - Hue Room */}
          <div style={{ flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            
            <div style={{ marginBottom: '4px' }}>
              <div className="section-label" style={{ margin: 0, fontSize: '12px', letterSpacing: '2px', color: '#f97316' }}>Hue Room</div>
              <div style={{ fontSize: '9px', color: '#52525b', marginTop: '2px' }}>Develop harmonies & structure</div>
            </div>
            
            {/* Key Color */}
            <div className="control-panel">
              <div className="section-label">Key Color (Anchor)</div>
              <div style={{ width: '100%', height: '40px', borderRadius: '8px', background: preservedHex || hslToHex(keyColor.h, keyColor.s, keyColor.l), marginBottom: '12px', border: '1px solid rgba(255,255,255,0.1)', position: 'relative' }}>
                {!keyColorInGamut && (
                  <div style={{ 
                    position: 'absolute', 
                    top: '-6px', 
                    right: '-6px', 
                    background: '#ef4444', 
                    color: '#fff', 
                    fontSize: '8px', 
                    padding: '2px 5px', 
                    borderRadius: '4px',
                    fontWeight: 600
                  }}>
                    {keyColorOvershoot}% OUT
                  </div>
                )}
              </div>
              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '9px', color: '#52525b', display: 'block', marginBottom: '3px' }}>HEX</label>
                <input type="text" value={preservedHex || hexInput} onChange={(e) => handleHexChange(e.target.value)} className="input-field" style={{ textTransform: 'uppercase' }} />
              </div>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                {['r', 'g', 'b'].map(ch => (
                  <div key={ch} style={{ flex: 1 }}>
                    <label style={{ fontSize: '9px', color: '#52525b', display: 'block', marginBottom: '3px' }}>{ch.toUpperCase()}</label>
                    <input type="number" value={rgbInput[ch]} onChange={(e) => handleRgbChange(ch, e.target.value)} className="input-field" min="0" max="255" />
                  </div>
                ))}
              </div>
              
              {/* CMYK Display */}
              <div style={{ background: '#0a0a0b', borderRadius: '6px', padding: '8px', marginTop: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '9px', color: '#52525b' }}>CMYK ({CMYK_PROFILES[cmykProfile].shortName}) • OKLab gamut</span>
                  {keyColorInGamut ? (
                    <span style={{ fontSize: '8px', color: '#22c55e' }}>✓ In Gamut</span>
                  ) : (
                    <span style={{ fontSize: '8px', color: '#ef4444' }}>⚠ Out of Gamut</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {['c', 'm', 'y', 'k'].map(ch => (
                    <div key={ch} style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: '12px', color: keyColorInGamut ? '#e4e4e7' : '#f97316', fontWeight: 500 }}>
                        {keyColorCmyk[ch]}
                      </div>
                      <div style={{ fontSize: '8px', color: '#52525b' }}>{ch.toUpperCase()}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Branch Tree */}
            <div className="control-panel">
              <div className="section-label">Branches</div>
              {branches.map((branch, bi) => {
                const branchColors = allColors.filter(c => c.branchId === branch.id);
                const isActive = branch.id === activeBranchId;
                return (
                  <div key={branch.id} style={{ marginBottom: '8px', paddingLeft: (branch.level - 1) * 12 }}>
                    <div
                      onClick={() => setActiveBranchId(branch.id)}
                      style={{
                        display: 'flex', alignItems: 'center', padding: '8px', borderRadius: '6px', cursor: 'pointer',
                        background: isActive ? 'rgba(249,115,22,0.1)' : 'transparent',
                        border: isActive ? '1px solid #f97316' : '1px solid transparent'
                      }}
                    >
                      <div className="branch-indicator" style={{ height: '24px', background: BRANCH_COLORS[branch.level - 1] }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '11px', fontWeight: 500 }}>
                          {branch.level === 1 ? 'Root' : `Branch ${branch.level}`}
                          {branch.locked && <span style={{ marginLeft: '6px', opacity: 0.5 }}>🔒</span>}
                        </div>
                        <div style={{ fontSize: '9px', color: '#71717a' }}>
                          {harmonyModes.find(m => m.id === branch.harmonyMode)?.label} • {branchColors.length} colors
                        </div>
                      </div>
                      {branch.level > 1 && (
                        <button onClick={(e) => { e.stopPropagation(); deleteBranch(branch.id); }} style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: '16px' }}>×</button>
                      )}
                    </div>
                  </div>
                );
              })}
              
              {/* Branch from Selection button */}
              <button
                onClick={createBranch}
                disabled={!canCreateBranch()}
                className="radial-btn"
                style={{ width: '100%', borderRadius: '8px', height: '36px', fontSize: '11px', marginTop: '8px', gap: '6px' }}
              >
                <BranchIcon /> Branch from Selection
              </button>
            </div>

            {/* Active Branch Harmony */}
            {activeBranch && (
              <div className="control-panel">
                <div className="section-label">Harmony ({activeBranch.level === 1 ? 'Root' : `Branch ${activeBranch.level}`})</div>
                
                {/* Harmony mode as notched slider */}
                <div style={{ marginBottom: '8px' }}>
                  <input
                    type="range"
                    min="0"
                    max={harmonyModes.length - 1}
                    step="1"
                    value={harmonyModeIndex}
                    onChange={(e) => updateBranchProperty(activeBranch.id, 'harmonyMode', harmonyModes[parseInt(e.target.value)].id)}
                    disabled={activeBranch.locked}
                    style={{ width: '100%' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    {harmonyModes.map((mode, i) => (
                      <div 
                        key={mode.id} 
                        style={{ 
                          fontSize: '12px', 
                          opacity: i === harmonyModeIndex ? 1 : 0.4,
                          transition: 'opacity 0.15s'
                        }}
                      >
                        {mode.icon}
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: '#f97316', textAlign: 'center', marginBottom: '12px' }}>
                  {harmonyModes[harmonyModeIndex]?.label}
                </div>
                
                {/* Branch local rotation */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '9px', color: '#52525b' }}>BRANCH ROTATION</span>
                    <span style={{ fontSize: '11px' }}>{activeBranch.localRotation}°</span>
                  </div>
                  <input
                    type="range" min="0" max="360"
                    value={activeBranch.localRotation}
                    onChange={(e) => updateBranchProperty(activeBranch.id, 'localRotation', parseInt(e.target.value))}
                    disabled={activeBranch.locked}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            )}

            {/* CMYK */}
            <div className="control-panel">
              <div className="section-label">CMYK Gamut</div>
              <button onClick={() => setCmykMode(!cmykMode)} className={`radial-btn ${cmykMode ? 'active' : ''}`} style={{ width: '100%', borderRadius: '8px', height: '36px', fontSize: '11px', gap: '6px' }}>
                {cmykMode ? 'CMYK On' : 'CMYK Off'}
              </button>
              {cmykMode && (
                <div style={{ marginTop: '10px' }}>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="1"
                    value={cmykProfileIndex}
                    onChange={(e) => setCmykProfile(Object.keys(CMYK_PROFILES)[parseInt(e.target.value)])}
                    style={{ width: '100%' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
                    {Object.values(CMYK_PROFILES).map((p, i) => (
                      <span 
                        key={i} 
                        style={{ 
                          fontSize: '9px', 
                          color: i === cmykProfileIndex ? '#f97316' : '#52525b',
                          textAlign: 'center',
                          flex: 1
                        }}
                      >
                        {p.shortName}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Color Sense */}
            <div className="control-panel">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="section-label" style={{ margin: 0 }}>Color Sense</div>
                <button onClick={() => setShowColorSense(!showColorSense)} className={`radial-btn ${showColorSense ? 'active' : ''}`} style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px' }}>
                  <LightbulbIcon />
                </button>
              </div>
              {showColorSense && colorSenseSuggestions.length > 0 && (
                <div style={{ marginTop: '10px' }}>
                  {colorSenseSuggestions.map((sug, i) => (
                    <div key={i} className="color-sense-card">
                      <div style={{ fontSize: '10px', color: '#a1a1aa' }}>{sug.message}</div>
                    </div>
                  ))}
                </div>
              )}
              {showColorSense && colorSenseSuggestions.length === 0 && (
                <div style={{ marginTop: '10px', fontSize: '10px', color: '#52525b' }}>No harmony suggestions at this time.</div>
              )}
            </div>
          </div>

          {/* Center - Wheel */}
          <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <div style={{ position: 'relative' }}>
              <canvas ref={canvasRef} width={wheelSize} height={wheelSize} style={{ borderRadius: '50%', boxShadow: '0 0 0 1px rgba(255,255,255,0.05), 0 8px 32px rgba(0,0,0,0.4)' }} />
              
              <svg width={wheelSize} height={wheelSize} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
                {/* CMYK boundary */}
                {cmykMode && gamutBoundary.length > 0 && (
                  <>
                    <defs>
                      <mask id="gamutMask">
                        <circle cx={wheelCenter} cy={wheelCenter} r={wheelRadius} fill="white" />
                        <path d={gamutBoundary.map((p, i) => {
                          const angle = (p.hue - 90) * (Math.PI / 180);
                          const r = (p.maxSaturation / 100) * (wheelRadius - pointInset);
                          return `${i === 0 ? 'M' : 'L'} ${wheelCenter + r * Math.cos(angle)} ${wheelCenter + r * Math.sin(angle)}`;
                        }).join(' ') + ' Z'} fill="black" />
                      </mask>
                    </defs>
                    <circle cx={wheelCenter} cy={wheelCenter} r={wheelRadius} fill="rgba(0,0,0,0.4)" mask="url(#gamutMask)" />
                    <path d={gamutBoundary.map((p, i) => {
                      const angle = (p.hue - 90) * (Math.PI / 180);
                      const r = (p.maxSaturation / 100) * (wheelRadius - pointInset);
                      return `${i === 0 ? 'M' : 'L'} ${wheelCenter + r * Math.cos(angle)} ${wheelCenter + r * Math.sin(angle)}`;
                    }).join(' ') + ' Z'} fill="none" stroke="#f97316" strokeWidth="2" strokeDasharray="4,4" opacity="0.7" />
                  </>
                )}

                {/* Branch connection lines */}
                {branches.map(branch => {
                  const branchColors = allColors.filter(c => c.branchId === branch.id);
                  if (branchColors.length < 2) return null;
                  const isActive = branch.id === activeBranchId;
                  return (
                    <polygon
                      key={branch.id}
                      points={branchColors.map(c => {
                        const pos = getPointPosition(c.h, c.s);
                        return `${pos.x},${pos.y}`;
                      }).join(' ')}
                      fill="none"
                      stroke={BRANCH_COLORS[branch.level - 1]}
                      strokeWidth={isActive ? 2 : 1}
                      opacity={isActive ? 0.8 : 0.3}
                    />
                  );
                })}

                {/* Color points */}
                {allColors.map((color) => {
                  const pos = getPointPosition(color.h, color.s);
                  const hex = hslToHex(color.h, color.s, color.l);
                  const isSelected = selectedColorId === color.id;
                  const isActiveBranch = color.branchId === activeBranchId;
                  
                  return (
                    <g key={color.id} style={{ pointerEvents: 'auto', opacity: isActiveBranch ? 1 : 0.5 }}>
                      {isSelected && <circle cx={pos.x} cy={pos.y} r={colorPointRadius + 6} fill="none" stroke="#fff" strokeWidth="2" />}
                      <circle cx={pos.x} cy={pos.y} r={colorPointRadius} fill={hex} stroke={isSelected ? '#fff' : BRANCH_COLORS[color.branchLevel - 1]} strokeWidth={isSelected ? 3 : 2} style={{ cursor: 'pointer' }} onClick={() => selectColor(color.id)} />
                      <text x={pos.x} y={pos.y + 1} textAnchor="middle" dominantBaseline="middle" fill={color.l > 55 ? '#000' : '#fff'} fontSize="11" fontWeight="600" style={{ pointerEvents: 'none' }}>{color.index + 1}</text>
                      {color.locked && <circle cx={pos.x + 10} cy={pos.y - 10} r={6} fill="#f97316" stroke="#0a0a0b" strokeWidth="1" />}
                    </g>
                  );
                })}
              </svg>

              {/* Lock popup */}
              {selectedColorId && (() => {
                const color = allColors.find(c => c.id === selectedColorId);
                if (!color) return null;
                const pos = getPointPosition(color.h, color.s);
                return (
                  <div
                    onClick={() => toggleColorLock(selectedColorId)}
                    style={{
                      position: 'absolute', left: pos.x + 14, top: pos.y - 24,
                      background: colorOverrides[selectedColorId]?.locked ? 'rgba(249,115,22,0.2)' : '#18181b',
                      border: `1px solid ${colorOverrides[selectedColorId]?.locked ? '#f97316' : '#3f3f46'}`,
                      borderRadius: '50%', width: '24px', height: '24px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                      color: colorOverrides[selectedColorId]?.locked ? '#f97316' : '#a1a1aa'
                    }}
                  >
                    <LockIcon locked={colorOverrides[selectedColorId]?.locked} size={12} />
                  </div>
                );
              })()}
            </div>

            {/* Number of Colors (for active branch) */}
            {activeBranch && ['equidistant', 'analogous'].includes(activeBranch.harmonyMode) && (
              <div className="control-panel" style={{ width: '100%', maxWidth: '320px' }}>
                <div className="section-label">Number of Colors: {activeBranch.numColors}</div>
                <div style={{ position: 'relative', padding: '8px 0' }}>
                  <input
                    type="range"
                    min={activeBranch.level === 3 ? 2 : 3}
                    max={Math.min(
                      activeBranch.harmonyMode === 'analogous' ? 6 : 12,
                      MAX_TOTAL_COLORS - totalColorCount + allColors.filter(c => c.branchId === activeBranch.id).length
                    )}
                    step="1"
                    value={activeBranch.numColors}
                    onChange={(e) => updateBranchProperty(activeBranch.id, 'numColors', parseInt(e.target.value))}
                    disabled={activeBranch.locked}
                    style={{ width: '100%', position: 'relative', zIndex: 2 }}
                  />
                  <div style={{ position: 'absolute', top: '20px', left: 0, right: 0, display: 'flex', justifyContent: 'space-between', padding: '0 4px', pointerEvents: 'none' }}>
                    {Array.from({ length: activeBranch.harmonyMode === 'analogous' ? 4 : 10 }, (_, i) => <div key={i} style={{ width: '2px', height: '8px', background: '#3f3f46', borderRadius: '1px' }} />)}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 2px', marginTop: '4px' }}>
                  {(activeBranch.harmonyMode === 'analogous' ? [3, 4, 5, 6] : [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map(n => (
                    <span key={n} style={{ fontSize: '9px', color: '#52525b', width: '16px', textAlign: 'center' }}>{n}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Analogous Spread Slider */}
            {activeBranch && activeBranch.harmonyMode === 'analogous' && (
              <div className="control-panel" style={{ width: '100%', maxWidth: '320px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span className="section-label" style={{ margin: 0 }}>Spread</span>
                  <span style={{ fontSize: '11px' }}>{activeBranch.analogousSpread}° between</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="30"
                  step="1"
                  value={activeBranch.analogousSpread}
                  onChange={(e) => updateBranchProperty(activeBranch.id, 'analogousSpread', parseInt(e.target.value))}
                  disabled={activeBranch.locked}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span style={{ fontSize: '9px', color: '#52525b' }}>Tight (5°)</span>
                  <span style={{ fontSize: '9px', color: '#52525b' }}>Wide (30°)</span>
                </div>
                <div style={{ fontSize: '9px', color: '#71717a', marginTop: '6px', textAlign: 'center' }}>
                  Total span: {(activeBranch.numColors - 1) * activeBranch.analogousSpread}°
                </div>
              </div>
            )}

            {/* Global Rotation */}
            <div className="control-panel" style={{ width: '100%', maxWidth: '320px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <RotateIcon />
                <span className="section-label" style={{ margin: 0 }}>Global Rotation</span>
                <span style={{ fontSize: '12px', marginLeft: 'auto' }}>{globalRotation}°</span>
              </div>
              <input type="range" min="0" max="360" value={globalRotation} onChange={(e) => setGlobalRotation(parseInt(e.target.value))} style={{ width: '100%' }} />
            </div>
          </div>

          {/* Right - Hue Lab */}
          <div style={{ flex: 1, minWidth: '300px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="section-label" style={{ margin: 0, fontSize: '12px', letterSpacing: '2px', color: '#f97316' }}>Hue Lab</div>
                <div style={{ fontSize: '9px', color: '#52525b', marginTop: '2px' }}>Refine scales & contrast <span style={{ color: '#3f3f46' }}>• ⌥-click slider to reset</span></div>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => setShowContrastInfo(!showContrastInfo)}
                  className={`radial-btn ${showContrastInfo ? 'active' : ''}`}
                  style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px', fontSize: '10px' }}
                  title="Toggle contrast info"
                >
                  Aa
                </button>
              </div>
            </div>
            
            {/* Value Scale Settings */}
            <div className="control-panel" style={{ padding: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                <span className="section-label" style={{ margin: 0 }}>Value Scales</span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '9px', color: '#52525b' }}>Uniform</span>
                  <button
                    onClick={() => setUniformValueCount(!uniformValueCount)}
                    className={`radial-btn ${uniformValueCount ? 'active' : ''}`}
                    style={{ width: '24px', height: '24px', minWidth: '24px', minHeight: '24px', fontSize: '10px' }}
                  >
                    {uniformValueCount ? '=' : '≠'}
                  </button>
                </div>
              </div>
              
              {uniformValueCount && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ fontSize: '9px', color: '#52525b' }}>ALL SCALES</span>
                    <span style={{ fontSize: '10px', color: '#a1a1aa' }}>{globalValueCount} values</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    step="1"
                    value={[3, 5, 7, 9, 11, 13].indexOf(globalValueCount)}
                    onChange={(e) => setGlobalValueCount([3, 5, 7, 9, 11, 13][parseInt(e.target.value)])}
                    style={{ width: '100%' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    {[3, 5, 7, 9, 11, 13].map((n, i) => (
                      <span key={n} style={{ fontSize: '8px', color: [3, 5, 7, 9, 11, 13].indexOf(globalValueCount) === i ? '#f97316' : '#52525b' }}>{n}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            
            {/* Contrast Target Selector - Now a slider */}
            {showContrastInfo && (
              <div className="control-panel" style={{ padding: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span className="section-label" style={{ margin: 0 }}>Contrast Target</span>
                  <span style={{ fontSize: '10px', color: '#f97316', marginLeft: 'auto' }}>
                    {targetContrastRatio.toFixed(1)}:1
                  </span>
                </div>
                
                <input
                  type="range"
                  min="0"
                  max="3"
                  step="1"
                  value={contrastPresetIndex}
                  onChange={(e) => setContrastTarget(CONTRAST_PRESETS[parseInt(e.target.value)].id)}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
                  {CONTRAST_PRESETS.map((preset, i) => (
                    <span 
                      key={preset.id} 
                      style={{ 
                        fontSize: '9px', 
                        color: i === contrastPresetIndex ? '#f97316' : '#52525b',
                        textAlign: 'center',
                        flex: 1
                      }}
                    >
                      {preset.label}
                    </span>
                  ))}
                </div>
                
                {contrastTarget === 'custom' && (
                  <div style={{ marginTop: '10px' }}>
                    <input
                      type="range"
                      min="1"
                      max="21"
                      step="0.5"
                      value={customContrastRatio}
                      onChange={(e) => setCustomContrastRatio(parseFloat(e.target.value))}
                      style={{ width: '100%' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '9px', color: '#52525b' }}>
                      <span>1:1</span>
                      <span>21:1</span>
                    </div>
                  </div>
                )}
                
                <div style={{ display: 'flex', gap: '12px', marginTop: '10px', fontSize: '9px', color: '#71717a' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e' }} />
                    <span>Pass on white</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#3b82f6' }} />
                    <span>Pass on black</span>
                  </div>
                </div>
              </div>
            )}
            
            {allColors.map((color) => {
              const hex = hslToHex(color.h, color.s, color.l);
              const values = generateValueScale(color.h, color.s, color.l, color.valueCount);
              const isSelected = selectedColorId === color.id;
              const isActiveBranch = color.branchId === activeBranchId;
              
              return (
                <div
                  key={color.id}
                  className="control-panel"
                  style={{
                    border: isSelected ? '1px solid #fff' : `1px solid ${isActiveBranch ? BRANCH_COLORS[color.branchLevel - 1] + '40' : '#1a1a1d'}`,
                    opacity: isActiveBranch ? 1 : 0.6,
                    cursor: 'pointer'
                  }}
                  onClick={() => selectColor(color.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <div className="branch-indicator" style={{ height: '100%', minHeight: '28px', background: BRANCH_COLORS[color.branchLevel - 1] }} />
                    <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: hex, border: isSelected ? '2px solid #fff' : '2px solid rgba(255,255,255,0.1)', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '12px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
                        Color {color.index + 1}
                        {color.isUnlinked && (
                          <span style={{ fontSize: '8px', color: '#f97316', background: 'rgba(249,115,22,0.15)', padding: '1px 4px', borderRadius: '3px' }}>unlinked</span>
                        )}
                        {color.cmyk && !color.cmyk.isInGamut && (
                          <span style={{ fontSize: '8px', color: '#ef4444', background: 'rgba(239,68,68,0.15)', padding: '1px 4px', borderRadius: '3px' }}>⚠ {color.cmyk.overshoot}% out</span>
                        )}
                      </div>
                      <div style={{ fontSize: '10px', color: '#71717a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={(e) => { e.stopPropagation(); copyToClipboard(hex, `main-${color.id}`); }}>
                        {hex.toUpperCase()} <CopyIcon /> {copiedIndex === `main-${color.id}` && <span style={{ color: '#22c55e' }}>✓</span>}
                      </div>
                      {cmykMode && color.cmyk && (
                        <div style={{ fontSize: '9px', color: '#f97316', marginTop: '2px' }}>C{color.cmyk.c} M{color.cmyk.m} Y{color.cmyk.y} K{color.cmyk.k}</div>
                      )}
                      {!cmykMode && color.cmyk && !color.cmyk.isInGamut && (
                        <div style={{ fontSize: '8px', color: '#ef4444', marginTop: '2px' }}>⚠ Outside CMYK gamut</div>
                      )}
                      {color.isUnlinked && color.roomBaseline && (
                        <div style={{ fontSize: '8px', color: '#52525b', marginTop: '2px' }}>
                          Room: H{Math.round(color.roomBaseline.h)}° S{Math.round(color.roomBaseline.s)} L{Math.round(color.roomBaseline.l)}
                        </div>
                      )}
                    </div>
                    
                    {/* Link/Unlink button */}
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if (e.altKey || e.metaKey) {
                          relinkColor(color.id);
                        } else {
                          color.isUnlinked ? relinkColor(color.id) : unlinkColor(color.id);
                        }
                      }} 
                      className={`radial-btn ${color.isUnlinked ? 'active' : ''}`} 
                      style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px' }}
                      title={color.isUnlinked ? 'Click to relink to Room (sync with harmony)' : 'Click to unlink (edit independently)'}
                    >
                      <LinkIcon linked={!color.isUnlinked} />
                    </button>
                    
                    <button onClick={(e) => { e.stopPropagation(); toggleColorLock(color.id); }} className={`radial-btn ${colorOverrides[color.id]?.locked ? 'active' : ''}`} style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px' }}>
                      <LockIcon locked={colorOverrides[color.id]?.locked} size={12} />
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: '12px', marginBottom: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '9px', color: '#52525b' }}>SAT</span>
                        <span style={{ fontSize: '10px', color: color.isUnlinked ? '#f97316' : '#a1a1aa' }}>{color.s}</span>
                      </div>
                      <input 
                        type="range" 
                        min="0" 
                        max="100" 
                        value={color.s} 
                        onChange={(e) => updateColorProperty(color.id, 's', parseInt(e.target.value))} 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (e.altKey || e.metaKey) {
                            relinkColor(color.id);
                          }
                        }}
                        style={{ width: '100%' }}
                        title="Option/Alt-click to reset to Room baseline"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '9px', color: color.contrastLock ? '#3b82f6' : '#52525b' }}>
                          LGT {color.contrastLock && <span style={{ fontSize: '8px' }}>◎</span>}
                        </span>
                        <span style={{ fontSize: '10px', color: color.contrastLock ? '#3b82f6' : (color.isUnlinked ? '#f97316' : '#a1a1aa') }}>{Math.round(color.l)}</span>
                      </div>
                      <input 
                        type="range" 
                        min="10" 
                        max="90" 
                        value={color.l} 
                        onChange={(e) => {
                          // If contrast locked, clear the lock when manually adjusting
                          if (contrastLocks[color.id]) {
                            clearContrastLock(color.id);
                          }
                          updateColorProperty(color.id, 'l', parseInt(e.target.value));
                        }} 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (e.altKey || e.metaKey) {
                            relinkColor(color.id);
                          }
                        }}
                        style={{ 
                          width: '100%',
                          opacity: color.contrastLock ? 0.5 : 1
                        }}
                        title={color.contrastLock ? 'Contrast locked - drag to unlock and adjust manually' : 'Option/Alt-click to reset to Room baseline'}
                      />
                    </div>
                  </div>

                  {/* Contrast Lock Panel */}
                  {(solveMode === color.id || color.contrastLock) && (
                    <div style={{ 
                      background: 'rgba(59, 130, 246, 0.1)', 
                      border: '1px solid rgba(59, 130, 246, 0.3)', 
                      borderRadius: '6px', 
                      padding: '8px 10px', 
                      marginBottom: '10px',
                      fontSize: '10px'
                    }}>
                      {solveMode === color.id ? (
                        // Solve mode: show target options
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                            <span style={{ fontWeight: 600, color: '#3b82f6' }}>◎ Contrast Lock</span>
                            <button 
                              onClick={(e) => { e.stopPropagation(); setSolveMode(null); }}
                              style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: '14px', padding: 0 }}
                            >×</button>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ color: '#a1a1aa' }}>Hit</span>
                            {[3, 4.5, 7].map(ratio => (
                              <button
                                key={ratio}
                                onClick={(e) => { e.stopPropagation(); setContrastLock(color.id, ratio, 'white'); }}
                                style={{
                                  padding: '3px 8px',
                                  borderRadius: '4px',
                                  border: '1px solid #3b82f6',
                                  background: 'rgba(59, 130, 246, 0.2)',
                                  color: '#3b82f6',
                                  cursor: 'pointer',
                                  fontSize: '10px',
                                  fontWeight: 500
                                }}
                              >
                                {ratio}:1
                              </button>
                            ))}
                            <span style={{ color: '#a1a1aa' }}>on</span>
                            <button
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                const ratio = contrastLocks[color.id]?.target || 4.5;
                                setContrastLock(color.id, ratio, 'white'); 
                              }}
                              style={{
                                padding: '3px 8px',
                                borderRadius: '4px',
                                border: '1px solid #22c55e',
                                background: '#fff',
                                color: '#18181b',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 500
                              }}
                            >
                              white
                            </button>
                            <button
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                const ratio = contrastLocks[color.id]?.target || 4.5;
                                setContrastLock(color.id, ratio, 'black'); 
                              }}
                              style={{
                                padding: '3px 8px',
                                borderRadius: '4px',
                                border: '1px solid #3b82f6',
                                background: '#18181b',
                                color: '#fff',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 500
                              }}
                            >
                              black
                            </button>
                          </div>
                          {/* Preview what the solution would be */}
                          {(() => {
                            const preview = solveForContrast(color.h, color.s, 4.5, 'white');
                            return (
                              <div style={{ marginTop: '8px', color: '#71717a', fontSize: '9px' }}>
                                Preview (4.5:1 on white): L → {preview.l} {preview.meetsTarget ? '✓' : '(closest possible)'}
                              </div>
                            );
                          })()}
                        </div>
                      ) : color.contrastLock ? (
                        // Locked: show current lock status
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ color: '#3b82f6', fontWeight: 600 }}>◎</span>
                            <span style={{ color: '#a1a1aa' }}>
                              Locked to <strong style={{ color: '#3b82f6' }}>{color.contrastLock.target}:1</strong> on {color.contrastLock.background}
                            </span>
                            {color.contrastLock.meetsTarget ? (
                              <span style={{ color: '#22c55e' }}>✓ {color.contrastLock.achievedRatio}:1</span>
                            ) : (
                              <span style={{ color: '#f97316' }}>≈ {color.contrastLock.achievedRatio}:1</span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button 
                              onClick={(e) => { e.stopPropagation(); setSolveMode(color.id); }}
                              style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '10px', padding: '2px 4px' }}
                            >edit</button>
                            <button 
                              onClick={(e) => { e.stopPropagation(); clearContrastLock(color.id); }}
                              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '10px', padding: '2px 4px' }}
                            >clear</button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* Contrast solve button (when not in solve mode and no lock) */}
                  {solveMode !== color.id && !color.contrastLock && (
                    <div style={{ marginBottom: '8px' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSolveMode(color.id); }}
                        style={{
                          background: 'none',
                          border: '1px dashed #3b82f6',
                          borderRadius: '4px',
                          color: '#3b82f6',
                          cursor: 'pointer',
                          fontSize: '9px',
                          padding: '4px 8px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        <span>◎</span> Lock to contrast target
                      </button>
                    </div>
                  )}

                  {/* Value swatches with hex codes and contrast info */}
                  <div style={{ display: 'flex', gap: '2px' }}>
                    {values.map((v, vi) => {
                      const vHex = hslToHex(v.h, v.s, v.l);
                      const vRgb = hslToRgb(v.h, v.s, v.l);
                      const contrastOnWhite = getContrastRatio(vRgb, WHITE_RGB);
                      const contrastOnBlack = getContrastRatio(vRgb, BLACK_RGB);
                      const passesOnWhite = contrastOnWhite >= targetContrastRatio;
                      const passesOnBlack = contrastOnBlack >= targetContrastRatio;
                      const textColor = v.l > 55 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)';
                      const isBase = v.isBase;
                      
                      return (
                        <div
                          key={vi}
                          className="value-swatch"
                          style={{ 
                            background: vHex, 
                            position: 'relative',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                            alignItems: 'center',
                            padding: '4px 2px',
                            boxShadow: isBase ? 'inset 0 0 0 2px rgba(255,255,255,0.8), inset 0 0 0 3px rgba(0,0,0,0.3)' : 'none'
                          }}
                          onClick={(e) => { e.stopPropagation(); copyToClipboard(vHex, `${color.id}-${vi}`); }}
                          title={`${vHex}${isBase ? ' (base)' : ''}\nOn white: ${contrastOnWhite.toFixed(2)}:1\nOn black: ${contrastOnBlack.toFixed(2)}:1`}
                        >
                          {/* Hex code */}
                          <span style={{ 
                            fontSize: '7px', 
                            color: textColor,
                            fontWeight: 500,
                            letterSpacing: '-0.3px',
                            textTransform: 'uppercase',
                            lineHeight: 1
                          }}>
                            {vHex.slice(1)}
                          </span>
                          
                          {/* Contrast indicators */}
                          {showContrastInfo && (
                            <div style={{ 
                              display: 'flex', 
                              gap: '2px',
                              marginTop: '3px'
                            }}>
                              {passesOnWhite && (
                                <div style={{ 
                                  width: '5px', 
                                  height: '5px', 
                                  borderRadius: '50%', 
                                  background: '#22c55e',
                                  border: '1px solid rgba(0,0,0,0.2)'
                                }} />
                              )}
                              {passesOnBlack && (
                                <div style={{ 
                                  width: '5px', 
                                  height: '5px', 
                                  borderRadius: '50%', 
                                  background: '#3b82f6',
                                  border: '1px solid rgba(255,255,255,0.2)'
                                }} />
                              )}
                            </div>
                          )}
                          
                          {copiedIndex === `${color.id}-${vi}` && (
                            <div style={{ 
                              position: 'absolute', 
                              inset: 0, 
                              display: 'flex', 
                              alignItems: 'center', 
                              justifyContent: 'center', 
                              background: 'rgba(0,0,0,0.6)', 
                              borderRadius: '4px', 
                              color: '#22c55e', 
                              fontSize: '9px' 
                            }}>✓</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  
                  {/* Contrast ratio display row */}
                  {showContrastInfo && (
                    <div style={{ display: 'flex', gap: '2px', marginTop: '4px' }}>
                      {values.map((v, vi) => {
                        const vRgb = hslToRgb(v.h, v.s, v.l);
                        const contrastOnWhite = getContrastRatio(vRgb, WHITE_RGB);
                        const contrastOnBlack = getContrastRatio(vRgb, BLACK_RGB);
                        const bestContrast = Math.max(contrastOnWhite, contrastOnBlack);
                        const useWhite = contrastOnWhite > contrastOnBlack;
                        
                        return (
                          <div
                            key={vi}
                            style={{ 
                              flex: 1, 
                              minWidth: '24px', 
                              fontSize: '8px', 
                              textAlign: 'center',
                              color: useWhite ? '#22c55e' : '#3b82f6',
                              opacity: bestContrast >= targetContrastRatio ? 1 : 0.4
                            }}
                          >
                            {bestContrast.toFixed(1)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  
                  {/* Per-color value count slider (when uniform is off) */}
                  {!uniformValueCount && (
                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #1f1f23' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ fontSize: '9px', color: '#52525b' }}>VALUE COUNT</span>
                        <span style={{ fontSize: '10px', color: '#a1a1aa' }}>{color.valueCount}</span>
                      </div>
                      <input 
                        type="range" 
                        min="0" 
                        max="5" 
                        step="1" 
                        value={[3, 5, 7, 9, 11, 13].indexOf(color.valueCount) !== -1 ? [3, 5, 7, 9, 11, 13].indexOf(color.valueCount) : 1} 
                        onChange={(e) => updateValueCount(color.id, [3, 5, 7, 9, 11, 13][parseInt(e.target.value)])} 
                        onClick={(e) => e.stopPropagation()} 
                        style={{ width: '100%' }} 
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        {[3, 5, 7, 9, 11, 13].map((n, i) => (
                          <span key={n} style={{ fontSize: '8px', color: color.valueCount === n ? '#f97316' : '#3f3f46' }}>{n}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Export */}
            <div className="control-panel" style={{ marginTop: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                <ExportIcon />
                <span className="section-label" style={{ margin: 0 }}>Export</span>
              </div>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
                {[{ id: 'hex', label: 'HEX' }, { id: 'css', label: 'CSS' }, { id: 'json', label: 'JSON' }, { id: 'tokens', label: 'Tokens' }, ...(cmykMode ? [{ id: 'cmyk', label: 'CMYK' }] : [])].map(f => (
                  <button key={f.id} onClick={() => setActiveExport(activeExport === f.id ? null : f.id)} className={`radial-btn ${activeExport === f.id ? 'active' : ''}`} style={{ borderRadius: '6px', width: 'auto', height: '32px', minHeight: '32px', padding: '0 12px', fontSize: '11px' }}>{f.label}</button>
                ))}
              </div>
              {activeExport && (
                <div style={{ position: 'relative' }}>
                  <button onClick={() => copyToClipboard(generateExport(activeExport), 'export')} style={{ position: 'absolute', top: '6px', right: '6px', background: '#27272a', border: 'none', borderRadius: '4px', padding: '4px 10px', color: '#e4e4e7', cursor: 'pointer', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', zIndex: 1 }}>
                    <CopyIcon /> {copiedIndex === 'export' ? '✓' : 'Copy'}
                  </button>
                  <pre style={{ background: '#0a0a0b', border: '1px solid #27272a', borderRadius: '8px', padding: '12px', fontSize: '11px', lineHeight: '1.5', overflowX: 'auto', maxHeight: '200px', overflowY: 'auto', whiteSpace: 'pre' }}>{generateExport(activeExport)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default HueLab;
