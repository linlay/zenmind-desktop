import { slenderHeadingSvg } from './slender-heading.mjs';
// Theme-specific silhouettes on the same 24px grid as the functional icon set.
const p = d => `<path d="${d}"/>`;
const mirror = s => `<g transform="translate(24 0) scale(-1 1)">${s}</g>`;
const shellBody = p('M9 20C7 18 2 15 1.5 11Q.5 8 3 7Q2.5 3.5 6 4Q7 1 10 3Q12 .3 14 3Q17 1 18 4Q21.5 3.5 21 7Q23.5 8 22.5 11C22 15 17 18 15 20L16 22H8Z');
const shell = `<g stroke-width="1.25">${shellBody}<g stroke-width=".8">${p('M12 20V4M10.5 19Q8 10 6 5M9 18Q5 12 3 8M13.5 19Q16 10 18 5M15 18Q19 12 21 8M9 20h6')}</g></g>`;
const fish = p('M3 12c5-10 13-10 18 0-5 10-13 10-18 0ZM3 12 1 6v12ZM14 6q-4 6 0 12')+'<circle cx="17" cy="10" r=".8" fill="currentColor" stroke="none"/>';
const turtleLimbs = p('M10 5.8C9 2 10.5.6 12 1s3 1 2 4.8M7.4 8C4 5 1 5.5.6 7.5Q3 10.5 6.5 12M16.6 8C20 5 23 5.5 23.4 7.5Q21 10.5 17.5 12M8 17Q3 17.5 3 21Q7 21.5 10 19M16 17Q21 17.5 21 21Q17 21.5 14 19M11 20l1 2 1-2');
const turtleCarapace = p('M12 5C4.5 5 5 14 7.5 18Q12 22 16.5 18C19 14 19.5 5 12 5Z');
const turtle = `<g transform="rotate(-25 12 12)" stroke-width="1.15">${turtleLimbs}${turtleCarapace}<g stroke-width=".7">${p('M12 7 9 9v5l3 3 3-3V9ZM9 9 7 8m8 1 2-1M9 14l-2 1m8-1 2 1M12 17v2M12 5v2')}</g></g>`;
const mountains = p('M2 17 8 5l4 6 4-9 6 15M6 9l2 2 2-2m4-2 2 2 2-2M2 20q3-3 7 0t7 0 6 0');
// A drawn recurve bow: distinct curved limbs, fine taut string and one clear arrow.
const bow = `<g transform="rotate(-35 12 12)" stroke-linecap="round" stroke-linejoin="round">
 <path d="M6 2C4 5 11 4.5 13 8Q14 10 14 12Q14 14 13 16C11 19.5 4 19 6 22" stroke-width="1.8"/>
 <path d="M6 2 3.5 12 6 22" stroke-width=".8"/>
 <path d="M2 12H21" stroke-width="1.25"/>
 <path d="M23 12 18 9.4 19.2 12 18 14.6Z" fill="currentColor" stroke="none"/>
 <path d="M4 12 2 10m2 2-2 2" stroke-width="1"/>
 </g>`;
const wings = p('M10 10 1 3l2 10 7 6m4-9 9-7-2 10-7 6M3 8l6 5m12-5-6 5M9 9l3-4 3 4v9l-3 4-3-4Z');
const joint = p('M2 4h20v16H2ZM2 12h6L6 8h5l-1 4h4l-1 4h5l-2-4h6M5 6h3m8 12h3');
const scroll = p('M5 3h14v18H5M5 3C0 3 0 8 5 8m14-5c5 0 5 5 0 5M5 16c-5 0-5 5 0 5m14-5c5 0 5 5 0 5M9 8h6M9 12h6M9 16h4');
const motifs = { 'gold-saints': bow, maldives: shell, tahiti: turtle, 'walnut-song': joint };
export const themedOutlines = {
 'gold-saints': [[8,78],[65,21],[40,21],[40,4],[96,4],[96,60],[79,60],[79,35],[22,92],[8,92]],
 maldives: [[35,90],[20,75],[8,57],[2,40],[8,29],[15,27],[16,15],[28,10],[38,14],[45,4],[55,4],[62,14],[72,10],[84,15],[85,27],[92,29],[98,40],[92,57],[80,75],[65,90],[70,100],[30,100]],
 tahiti: [[43,22],[40,11],[43,3],[50,0],[57,3],[60,11],[57,22],[69,28],[85,21],[96,23],[100,31],[85,42],[75,46],[75,65],[68,78],[85,80],[91,91],[77,94],[59,85],[50,99],[41,85],[23,94],[9,91],[15,80],[32,78],[25,65],[25,46],[15,42],[0,31],[4,23],[15,21],[31,28]],
 'walnut-song': [[0,20],[35,20],[35,0],[65,0],[65,20],[100,20],[100,55],[80,55],[80,100],[45,100],[45,75],[0,75]]
};
export function themedGeometry(key, name, original) {
 const back = key === 'gold-saints' ? p('M22 12H2l7-7M2 12l7 7M18 8l-4 4 4 4') : key === 'walnut-song' ? p('M21 10H8V5l-6 7 6 7v-5h13ZM17 10V7m-4 7v3') : p('M22 12H3l6-6M3 12l6 6M16 8q3 4 0 8');
 const sets = {
 'gold-saints': {
 send: bow, project: wings, new_project: wings, chat: p('M3 5h18v12l-5 3h-7l-5 3 1-6Z M7 9h10M9 13h6'),
 search: '<circle cx="10" cy="10" r="7"/>'+p('M10 5v10M5 10h10m0 5 7 7m-4-2 2-2'),
 stop: p('M12 2 21 6v7q-1 6-9 9-8-3-9-9V6Z')+'<rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
 automation: '<circle cx="12" cy="12" r="9"/>'+p('M12 5v7l5 3M3 3l3 3m12 12 3 3'),
 kanban: p('M3 21V6l9-4 9 4v15ZM7 8v9m5-10v6m5-5v11M2 21h20'),
 attach: p('M6 19 18 7q4-4 0-5L4 16q-4 6 3 6L21 8M8 16l8-8'),
 terminal: p('M3 5h18v15H3ZM6 10l4 3-4 3m8 0h4M8 2l4 3 4-3'),
 library: p('M3 5l9-3 9 3v16l-9-3-9 3ZM12 2v16M6 8l3-1m6 0 3 1'),
 screenshot: p('M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5M7 12h10M12 7v10'),
 },
 maldives: {
 send: fish, project: shell, new_project: shell,
 chat: p('M3 12c0-10 18-10 18 0q0 7-11 6l-6 4 1-7M7 10q2-2 4 0t6 0'),
 search: '<circle cx="10" cy="10" r="7"/>'+p('M4 11q3-4 6 0t6 0m-1 4 7 7'),
 stop: `<g stroke-width="1.25">${shellBody}</g>`+'<rect x="8" y="9" width="8" height="7" rx="1" fill="currentColor" stroke="none"/>',
 automation: '<circle cx="12" cy="11" r="8"/>'+p('M12 6v5l4 2M2 21q3-3 7 0t7 0 6 0'),
 website: '<circle cx="12" cy="12" r="9"/>'+p('M4 12q4-4 8 0t8 0M12 3q-6 9 0 18 6-9 0-18'),
 database: p('M3 6q9-6 18 0v12q-9 7-18 0ZM3 6q9 6 18 0M3 12q9 6 18 0M8 8v2m8 4v2'),
 library: p('M2 5q5-3 10 2 5-5 10-2v15q-5-3-10 1-5-4-10-1ZM12 7v14M5 10q2-1 4 1m6 0q2-2 4-1'),
 more: '<circle cx="4" cy="13" r="2"/><circle cx="12" cy="10" r="2.5"/><circle cx="20" cy="13" r="2"/>',
 screenshot: p('M2 8V4h5m10 0h5v4M2 16v4h5m10 0h5v-4M6 13q3-4 6 0t6 0')
 },
 tahiti: {
 send: turtle, project: mountains, new_project: mountains,
 chat: p('M3 6q9-5 18 0v10q-6 4-12 2l-5 4v-6ZM7 13l3-6 4 6 3-4'),
 search: '<circle cx="10" cy="10" r="7"/>'+p('M5 12l4-7 5 7m1 3 7 7'),
 stop: `<g stroke-width="1.15">${turtleLimbs}${turtleCarapace}</g><rect x="9" y="10" width="6" height="6" rx=".8" fill="currentColor" stroke="none"/>`,
 automation: '<circle cx="12" cy="12" r="9"/>'+p('M12 6v6l4 2M8 2l4 3 4-3M8 22l4-3 4 3'),
 kanban: p('M3 21V8l5-5 4 5 4-5 5 5v13ZM7 11v6m5-6v4m5-4v7'),
 website: mountains,
 library: p('M3 4q5-2 9 3 4-5 9-3v16q-5-2-9 2-4-4-9-2ZM12 7v15M6 10l3-3m6 3 3-3M6 15l3-3m6 3 3-3'),
 more: p('m2 12 2-3 2 3-2 3Zm8 0 2-3 2 3-2 3Zm8 0 2-3 2 3-2 3Z'),
 screenshot: p('M2 8V3h5m10 0h5v5M2 16v5h5m10 0h5v-5M6 15l4-7 4 7 3-4 2 4')
 },
 'walnut-song': {
 send: p('M3 17h18v4H3ZM5 17V9h12l3 8M9 9V5h7v4M7 13h8M3 5l4-3m13 4 2-2'),
 project: joint, new_project: joint, library: scroll,
 chat: p('M3 4h18v14H9l-6 4ZM6 8h12M6 12h8'),
 search: '<circle cx="10" cy="10" r="7"/>'+p('M6 6h8v8H6Zm9 9 7 7m-5-7-2 2'),
 stop: p('M3 3h18v18H3ZM7 3v4H3m14-4v4h4M3 17h4v4m10 0v-4h4')+'<rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none"/>',
 kanban: p('M2 3h20v18H2ZM2 7h20M8 7v14m8-14v14M5 2v3m14-3v3'),
 automation: '<circle cx="12" cy="12" r="8"/>'+p('M12 7v5l4 2M4 4H2v16h2m16-16h2v16h-2'),
 website: p('M3 21V3h18v18ZM3 8h18M8 3v18m8-18v18M3 16h18M8 12h8'),
 terminal: p('M2 4h20v17H2ZM6 9l4 3-4 3m8 0h4M5 20h14'),
 database: p('M4 3h16v18H4ZM4 9h16M4 15h16M10 6h4m-4 6h4m-4 6h4'),
 attach: joint,
 more: p('M2 10h4v4H2Zm8 0h4v4h-4Zm8 0h4v4h-4Z'),
 screenshot: p('M2 8V2h6m8 0h6v6M2 16v6h6m8 0h6v-6M7 7h10v10H7Z')
 }
 };
 if(name==='back')return back;
 if(name==='forward')return mirror(back);
 if(sets[key]?.[name])return sets[key][name];
 // Retain familiar operation geometry while incorporating the theme's construction.
 const detail = key==='gold-saints'?p('M8 2l4 2 4-2'):key==='maldives'?p('M4 22q4-3 8 0t8 0'):key==='tahiti'?p('M7 22l5-3 5 3'):p('M2 7V2h5m10 20h5v-5');
 return `<g transform="translate(2 2) scale(.82)">${original}</g>${detail}`;
}
export async function drawThemedHeading(ctx, {key,label,ink,accent,background,width,loadImage}) {
 ctx.font=`${key==='walnut-song'?'':'bold '}58px "${key==='walnut-song'||key==='gold-saints'?'CollectionSerif':'CollectionSans'}"`;
 ctx.textBaseline='middle';ctx.lineJoin='round';
 const lettering=key==='walnut-song'?slenderHeadingSvg(label,ink):null;
 if(lettering){ctx.drawImage(await loadImage(Buffer.from(lettering)),52,13,[...label].length*62,70);}else{
 ctx.strokeStyle=background;ctx.lineWidth=4;ctx.strokeText(label,52,49);ctx.fillStyle=ink;ctx.fillText(label,52,49);
 }
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-2 -2 28 28" color="${accent}"><g fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${motifs[key]}</g></svg>`;
 ctx.drawImage(await loadImage(Buffer.from(svg)),0,23,46,46);
 ctx.strokeStyle=accent;ctx.lineWidth=1.7;ctx.beginPath();
 if(key==='maldives'||key==='tahiti'){
  ctx.moveTo(54,85);for(let x=54;x<width-15;x+=18)ctx.bezierCurveTo(x+5,79,x+13,91,x+18,85);
 }else{ctx.moveTo(54,82);ctx.lineTo(width-12,82);if(key==='walnut-song'){ctx.lineTo(width-12,72);ctx.lineTo(width-20,72);}else{ctx.moveTo(54,88);ctx.lineTo(width-30,88);}}
 ctx.stroke();
}
