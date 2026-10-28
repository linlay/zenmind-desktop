// Exercise real pointer capture, range anchors and scrolling on the production page.
const assert = require('node:assert/strict');
module.exports = async function checkLibrarySelection({ win, js, until, delay, click, shot }) {
  const input = async (type, point, modifiers = []) => {
    win.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }), modifiers: [...modifiers, ...(type === 'mouseMove' ? ['leftButtonDown'] : [])] });
    await delay(25);
  };
  const selected = () => js('[...document.querySelectorAll(".library-file")].flatMap((item,index)=>item.classList.contains("is-selected")?[index]:[])');
  const count = value => until('document.querySelectorAll(".library-file.is-selected").length===' + value);
  const clickItem = async (index, modifiers = []) => {
    const point = await js(`(()=>{const rect=document.querySelectorAll('.library-file')[${index}].getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
    await input('mouseDown', point, modifiers); await input('mouseUp', point, modifiers);
  };
  const boxPoints = () => js(`(()=>{const files=document.querySelectorAll('.library-file'),first=files[0].getBoundingClientRect(),second=files[1].getBoundingClientRect();return {start:{x:first.left-5,y:first.top-5},end:{x:second.right-2,y:second.bottom-2},top:document.querySelector('.library-browse').getBoundingClientRect().top,fileTop:first.top};})()`);
  const blank = async () => {
    const point = await js(`(()=>{const rect=document.querySelector('.library-browse').getBoundingClientRect();return {x:rect.left+5,y:rect.top+5};})()`);
    await input('mouseDown', point); await input('mouseUp', point); await count(0);
    await until('getComputedStyle(document.querySelector(".library-inspector")).display==="none"');
  };
  const drag = async (points, modifiers = [], reverse = false) => {
    const start = reverse ? { x: points.end.x + 5, y: points.end.y + 5 } : points.start;
    // The reverse origin is the gap before the third tile, outside the second tile.
    await input('mouseDown', start, modifiers);
    const end = reverse ? { x: points.start.x + 7, y: points.start.y + 7 } : points.end;
    for (let step = 1; step <= 6; step++) await input('mouseMove', { x: start.x + (end.x - start.x) * step / 6, y: start.y + (end.y - start.y) * step / 6 }, modifiers);
    await until('document.querySelector(".library-selection-box")!==null');
    return end;
  };
  await click('[aria-label="小卡片"]'); await blank();
  await clickItem(1); await clickItem(5, ['shift']); await count(5);
  assert.deepEqual(await selected(), [1, 2, 3, 4, 5]);
  await clickItem(3, ['shift']); await count(3); assert.deepEqual(await selected(), [1, 2, 3]);
  await clickItem(0, ['shift']); await count(2); assert.deepEqual(await selected(), [0, 1]);
  await clickItem(7, ['meta']); await count(3); assert.deepEqual(await selected(), [0, 1, 7]);
  await clickItem(7, ['meta']); await count(2);
  // Shift + Command adds a continuous range without dropping an earlier selection.
  await clickItem(4, ['shift', 'meta']); await count(6); assert.deepEqual(await selected(), [0, 1, 4, 5, 6, 7]);
  await blank();
  for (const [label, name] of [['小卡片', 'small'], ['大卡片', 'large'], ['列表', 'list']]) {
    await click('[aria-label="' + label + '"]'); await blank();
    const points = await boxPoints(), end = await drag(points);
    await count(2); assert.deepEqual(await selected(), [0, 1]);
    assert.equal(await js('document.querySelector(".library-browse").getBoundingClientRect().top'), points.top);
    assert.equal(await js('document.querySelector(".library-file").getBoundingClientRect().top'), points.fileTop);
    assert.equal(await js('document.querySelector(".library-files-header").classList.contains("library-selectionbar")'), true);
    await shot('marquee-' + name);
    await input('mouseUp', end); await until('!document.querySelector(".library-selection-box")');
    assert.deepEqual(await selected(), [0, 1]);
    assert.equal(await js('document.querySelector(".library-file").getBoundingClientRect().top'), points.fileTop);
    await blank();
  }
  await click('[aria-label="小卡片"]'); await clickItem(7); await count(1);
  let points = await boxPoints(), end = await drag(points, ['meta']);
  await count(3); assert.deepEqual(await selected(), [0, 1, 7]);
  await input('mouseUp', end, ['meta']);
  points = await boxPoints(); end = await drag(points);
  await count(2);
  await js('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until('!document.querySelector(".library-selection-box")'); await count(3); assert.deepEqual(await selected(), [0, 1, 7]);
  await input('mouseUp', end);
  await blank();
  // Start in a real gap at the right of tile two, then drag backwards.
  points = await boxPoints();
  const start = { x: points.end.x + 5, y: points.end.y - 20 };
  await input('mouseDown', start); await input('mouseMove', { x: points.start.x + 7, y: points.start.y + 7 });
  await count(2); await input('mouseUp', { x: points.start.x + 7, y: points.start.y + 7 });
  assert.deepEqual(await selected(), [0, 1]);
  // A file drag must still carry the complete selection, and must not create a selection box.
  const payload = await js(`(()=>{const transfer=new DataTransfer();document.querySelector('.library-file').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));return JSON.parse(transfer.getData('application/x-zenmind-library-items'));})()`);
  assert.equal(payload.length, 2); assert.equal(await js('!!document.querySelector(".library-selection-box")'), false);
  await blank();
  // Windows modifier behavior is evaluated in the renderer; this is not native Windows OS QA.
  await js('window.qa.platform="win32";window.qa.remount()'); await until('document.querySelectorAll(".library-file").length===9');
  await js(`document.querySelectorAll('.library-file')[1].dispatchEvent(new MouseEvent('click',{bubbles:true}))`); await delay(25);
  await js(`document.querySelectorAll('.library-file')[3].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
  await count(2); assert.deepEqual(await selected(), [1, 3]);
  await js(`document.querySelectorAll('.library-file')[6].dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`);
  await count(4); assert.deepEqual(await selected(), [3, 4, 5, 6]);
  await js('window.qa.platform="darwin";window.qa.remount()'); await until('document.querySelectorAll(".library-file").length===9');
  await click('[aria-label="大卡片"]');
};

module.exports.scroll = async function checkLibraryMarqueeScroll({ win, js, until, delay }) {
  // Compact view now fits fifty items in a tall window; use a shorter viewport to exercise scrolling.
  win.setContentSize(1280, 540); await delay(80);
  await js('document.querySelector(".library-layout-switcher button:first-child").click()'); await delay(50);
  const points = await js(`(()=>{const root=document.querySelector('.library-browse'),rect=root.getBoundingClientRect(),first=document.querySelector('.library-file').getBoundingClientRect();return {start:{x:first.left-5,y:first.top-4},end:{x:rect.right-12,y:rect.bottom-3}};})()`);
  const input = (type, point) => win.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : { button: 'left', clickCount: 1 }) });
  input('mouseDown', points.start); await delay(20); input('mouseMove', points.end);
  await until('document.querySelector(".library-browse").scrollTop>120&&document.querySelectorAll(".library-file.is-selected").length>7');
  input('mouseUp', points.end); await until('!document.querySelector(".library-selection-box")');
  const top = await js('document.querySelector(".library-browse").scrollTop'); await delay(120);
  assert.equal(await js('document.querySelector(".library-browse").scrollTop'), top);
  win.setContentSize(1280, 820); await delay(80);
};
