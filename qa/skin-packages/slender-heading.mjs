// Hand-drawn slender calligraphic lettering for the eight fixed Chinese glyphs.
// Inspired by thin, angular brushwork; not an installed or redistributed font.
const glyphs = {
 '置': ['M8 5H51V18H8Z M22 5V18M37 5V18','M5 25H55M30 20V32','M14 33H46V57H14ZM14 41H46M14 49H46','M5 59H55'],
 '顶': ['M3 12H24M15 12V55L9 52','M29 6H57M43 6L38 18','M30 19H54V48M37 25V44Q39 53 25 61','M44 50Q53 54 58 61'],
 '对': ['M3 15H24Q21 44 2 57','M5 26Q17 36 28 51','M29 20H58M48 5V58L39 54','M32 29L38 39'],
 '话': ['M8 5L16 12','M3 24H13V54L25 44','M30 11L54 5','M27 24H58M42 9V37','M30 38H54V59H30Z'],
 '项': ['M3 13H24M14 13V46M2 51L27 42','M29 6H58M44 6L39 18','M31 19H54V46M39 26V44Q40 54 25 61','M45 50Q54 55 58 61'],
 '目': ['M13 5H48V59H13Z','M14 22H47','M14 40H47'],
 '站': ['M12 4L18 12','M3 17H28','M7 25L12 45M24 23L18 49M2 54L29 47','M41 4V34M42 18H58','M32 35H55V59H32Z'],
 '点': ['M28 3V24M29 12H52','M12 25H48V43H12Z','M10 50L5 60M23 51L24 60M36 51L40 60M49 50L56 59']
};
// Small angular terminal strokes suggest the lifted brush and hooked finishes.
const tips = {
 '置': [[51,5],[55,25],[46,33],[46,41],[46,49],[55,59]],
 '顶': [[24,12],[57,6],[54,19],[58,61]],
 '对': [[24,15],[58,20],[38,39]],
 '话': [[13,24],[58,24],[54,38],[54,59]],
 '项': [[24,13],[58,6],[54,19],[58,61]],
 '目': [[48,5],[47,22],[47,40],[48,59]],
 '站': [[28,17],[58,18],[55,35],[55,59]],
 '点': [[52,12],[48,25],[48,43],[56,59]]
};
export function slenderHeadingSvg(label, color) {
 const letters=[...label];
 if(!letters.every(ch=>glyphs[ch]))return null;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${letters.length*62}" height="70" viewBox="0 0 ${letters.length*62} 70">${letters.map((ch,i)=>`<g transform="translate(${i*62} 3)" fill="none" stroke="${color}" stroke-width="1.65" stroke-linecap="butt" stroke-linejoin="miter">${glyphs[ch].map(d=>`<path d="${d}"/>`).join('')}${tips[ch].map(([x,y])=>`<path d="M${x-3} ${y}l3-2.3 2 3.2Z" fill="${color}" stroke="none"/>`).join('')}</g>`).join('')}</svg>`;
}
