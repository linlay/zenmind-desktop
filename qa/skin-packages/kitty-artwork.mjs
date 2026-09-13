export const kittyUnreadOutline = [[12, 52], [2, 40], [0, 22], [8, 12], [20, 15], [26, 35], [27, 8], [36, 0], [45, 4], [49, 30], [53, 4], [63, 0], [73, 8], [74, 35], [80, 15], [92, 12], [100, 22], [98, 40], [88, 52], [75, 45], [65, 50], [89, 73], [91, 89], [80, 100], [50, 89], [20, 100], [9, 89], [11, 73], [35, 50], [25, 45]];
// Original compact cat silhouettes. Geometry is designed on a 24 px grid, not decorated stock icons.
export const kittyPaths = {
 search: '<path d="M3 9V2l5 3q3-1 6 0l5-3v7c2 7-4 10-8 10S1 16 3 9Z"/><path d="m17 17 5 5"/>',
 back: '<path d="m9 3-7 8 7 7M3 11h10c12 0 10 12 3 10-3-1-3-4-1-5"/>',
 forward: '<g transform="translate(24 0) scale(-1 1)"><path d="m9 3-7 8 7 7M3 11h10c12 0 10 12 3 10-3-1-3-4-1-5"/></g>',
 sidebar: '<path d="M2 8V2l6 4h8l6-4v16q0 4-4 4H6q-4 0-4-4Z"/><path d="M9 6v16"/>',
 sidebar_right: '<path d="M2 8V2l6 4h8l6-4v16q0 4-4 4H6q-4 0-4-4Z"/><path d="M15 6v16"/>',
 kanban: '<path d="M2 9V2l6 4h8l6-4v14q0 6-10 6T2 16Z"/><path d="M7 10v6m5-6v4m5-4v8"/>',
 automation: '<path d="M4 8 3 2l6 3m6 0 6-3-1 6"/><circle cx="12" cy="13" r="9"/><path d="M12 8v6l4 2M6 21l-2 2m14-2 2 2"/>',
 new_chat: '<path d="M3 15V2l5 4h7l5-4v7M3 15q0 4 4 4l-2 4 7-4"/><path d="m12 19 1-5 7-7 3 3-7 7-4 2"/>',
 chat: '<path d="M2 10V2l6 4h8l6-4v12q0 6-9 6H8l-5 3 1-5q-2-2-2-8Z"/><path d="M7 12h.1m10 0h.1M11 15h2"/>',
 project: '<path d="M2 9V3l5 3 5-3 4 5h4q2 0 2 3v8q0 3-3 3H5q-3 0-3-3Z"/><path d="M2 10h20"/>',
 website: '<path d="M3 8V2l6 3m6 0 6-3v6"/><circle cx="12" cy="13" r="9"/><ellipse cx="12" cy="13" rx="4" ry="9"/><path d="M3 13h18"/>',
 send: '<g fill="currentColor" stroke="none"><ellipse cx="4" cy="9" rx="2.8" ry="3.8" transform="rotate(-25 4 9)"/><ellipse cx="9" cy="4.7" rx="2.8" ry="3.7"/><ellipse cx="15.5" cy="4.7" rx="2.8" ry="3.7"/><ellipse cx="20.5" cy="9" rx="2.8" ry="3.8" transform="rotate(25 20.5 9)"/><path d="M5 17c1-2 3-3 4-5 2-3 5-3 7 0 1 2 3 3 4 5 3 7-5 6-8 4-3 2-10 3-7-4Z"/></g>',
 stop: '<path d="M2 10V2l6 4h8l6-4v13q0 7-10 7T2 15Z"/><rect x="8" y="10" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
 attach: '<path d="M4 19C-1 14 4 9 8 5l3-3 1 5 5-1-4 5c-7 7-7 9-3 10 3 1 7-5 10-8 3-4 1-7-1-8"/>',
 expand: '<path d="M2 9V2l5 3M17 5l5-3v7M2 15v7h7m6 0h7v-7M7 12l-5 2m15-2 5 2"/>',
 collapse: '<path d="M2 2 8 8M8 2v6H2m20-6-6 6m0-6v6h6M2 22l6-6m-6 0h6v6m14 0-6-6m0 6v-6h6"/><path d="M10 10v-2l2 2 2-2v2"/>',
 voice: '<path d="M7 6V2l5 3 5-3v10a5 5 0 0 1-10 0ZM3 11v2a9 9 0 0 0 18 0v-2M12 22v-2"/><path d="M8 23h8"/>',
 terminal: '<path d="M2 9V2l6 4h8l6-4v17q0 3-3 3H5q-3 0-3-3Z"/><path d="m6 11 4 3-4 3m8 1h4"/>',
 database: '<path d="M3 7V2l5 3q4-2 8 0l5-3v16c0 5-18 5-18 0Z"/><path d="M3 8c0 5 18 5 18 0M3 14c0 5 18 5 18 0"/>',
 library: '<path d="M2 7V2l5 3q3 0 5 3 2-3 5-3l5-3v19q-6-3-10 1-4-4-10-1ZM12 8v14"/>',
 refresh: '<path d="M21 8C15-3 1 3 2 14s19 12 20 2M21 2v6h-6"/><path d="m4 17 3-3 3 3M7 14v6"/>',
 more: '<g fill="currentColor" stroke="none"><ellipse cx="4" cy="12" rx="3" ry="4" transform="rotate(-20 4 12)"/><ellipse cx="12" cy="10" rx="3" ry="4"/><ellipse cx="20" cy="12" rx="3" ry="4" transform="rotate(20 20 12)"/></g>'
};
// Draw glyphs individually with rounded stroke joins; ears grow from the first glyph,
// and the final baseline curls into a tail instead of using a separate corner ornament.
export function drawKittyHeading(ctx, label, ink, accent, background) {
 ctx.font='bold 62px "CollectionSans"'; ctx.textBaseline='alphabetic';ctx.lineJoin='round';ctx.lineCap='round';
 let x=12;
 for (const [i,ch] of [...label].entries()) {
  ctx.save();ctx.translate(x,77+(i%2?2:0));ctx.rotate((i%2?1:-1)*.025);
  ctx.strokeStyle=background;ctx.lineWidth=8;ctx.strokeText(ch,0,0);
  ctx.strokeStyle=ink;ctx.fillStyle=ink;ctx.lineWidth=1.8;ctx.strokeText(ch,0,0);ctx.fillText(ch,0,0);ctx.restore();
  x+=ctx.measureText(ch).width;
 }
 ctx.strokeStyle=ink;ctx.fillStyle=accent;ctx.lineWidth=3;
 ctx.beginPath();ctx.moveTo(17,29);ctx.lineTo(16,14);ctx.quadraticCurveTo(17,11,20,15);ctx.lineTo(30,26);ctx.closePath();ctx.fill();ctx.stroke();
 ctx.beginPath();ctx.moveTo(49,26);ctx.lineTo(60,14);ctx.quadraticCurveTo(63,11,63,16);ctx.lineTo(62,30);ctx.closePath();ctx.fill();ctx.stroke();
 ctx.strokeStyle=accent;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(16,92);ctx.bezierCurveTo(x*.45,88,x*.8,100,x+9,89);ctx.bezierCurveTo(x+30,75,x+34,101,x+16,102);ctx.stroke();
}
