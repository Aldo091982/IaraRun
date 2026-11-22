'use strict';
// Ilustrações esportivas próprias (SVG em linha, cor via currentColor).
const S = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

const ART = {
  run: `<svg viewBox="0 0 100 100" ${S} stroke-width="9"><circle cx="63" cy="13" r="8" fill="currentColor" stroke="none"/><path d="M58 27 47 53"/><path d="M56 31l14 9 11-6"/><path d="M56 31 42 37l-6 10"/><path d="M47 53l17 10 5 18"/><path d="M47 53 37 71l-15 3"/><path d="M8 40h14M4 52h12M10 64h10" stroke-width="4" opacity=".6"/></svg>`,
  bike: `<svg viewBox="0 0 120 100" ${S} stroke-width="6"><circle cx="26" cy="72" r="18"/><circle cx="94" cy="72" r="18"/><path d="M26 72 46 44h36L94 72M46 44l14 28h-34M60 72l18-34" stroke-width="5"/><circle cx="72" cy="12" r="7" fill="currentColor" stroke="none"/><path d="M68 22 54 40l8 14M62 26l18 12" stroke-width="8"/><path d="M4 50h12M8 62h8" stroke-width="3.5" opacity=".6"/></svg>`,
  swim: `<svg viewBox="0 0 120 100" ${S} stroke-width="8"><circle cx="78" cy="40" r="8" fill="currentColor" stroke="none"/><path d="M68 50 30 56"/><path d="M66 48c8-16 22-24 36-20"/><path d="M30 56 14 50"/><path d="M6 74c10-8 18-8 28 0s18 8 28 0 18-8 28 0 18 8 26 0" stroke-width="5"/><path d="M18 88c10-8 18-8 28 0s18 8 28 0 18-8 28 0" stroke-width="4" opacity=".6"/></svg>`,
  trail: `<svg viewBox="0 0 120 100" ${S} stroke-width="8"><path d="M2 96 38 48l18 22 22-34 40 60z" fill="currentColor" stroke="none" opacity=".25"/><circle cx="70" cy="12" r="7" fill="currentColor" stroke="none"/><path d="M66 24 57 46"/><path d="M64 28l12 7 8-6M64 28l-12 6-4 9" stroke-width="7"/><path d="M57 46l14 8 3 15M57 46l-9 15-13 2" stroke-width="7"/></svg>`,
  medal: `<svg viewBox="0 0 100 100" ${S} stroke-width="7"><path d="M30 6l14 34M70 6 56 40"/><circle cx="50" cy="64" r="26"/><path d="M50 50l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z" fill="currentColor" stroke-width="2"/></svg>`,
};

function sportKey(sport = '') {
  const s = String(sport).toLowerCase();
  if (/cicl|bike|mtb|pedal/.test(s)) return 'bike';
  if (/nata|swim|aqua|travessia/.test(s)) return 'swim';
  if (/trail|montanha|trilha/.test(s)) return 'trail';
  if (/triat|duat/.test(s)) return 'swim';
  return 'run';
}
const art = (key) => ART[key] || ART.run;
module.exports = { ART, art, sportKey };
