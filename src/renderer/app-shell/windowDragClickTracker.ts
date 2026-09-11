type ScreenPoint = { screenX: number; screenY: number };

const CLICK_MOVEMENT_TOLERANCE_PX = 4;

// Chromium supplies the native click count, including the OS double-click timing.
// This only verifies that both clicks were completed presses on the same drag
// region. Screen coordinates detect movement even while the window follows the
// cursor; they stay in the renderer and never enter the main-process DIP loop.
export function createWindowDragClickTracker<T>() {
  let press: {
    target: T;
    start: ScreenPoint;
    moved: boolean;
    released: boolean;
  } | null = null;
  let firstClickTarget: T | null = null;

  function reset() {
    press = null;
    firstClickTarget = null;
  }

  function move(point: ScreenPoint) {
    if (!press || press.released) return;
    const dx = point.screenX - press.start.screenX;
    const dy = point.screenY - press.start.screenY;
    if (dx * dx + dy * dy > CLICK_MOVEMENT_TOLERANCE_PX ** 2) {
      press.moved = true;
    }
  }

  return {
    reset,
    begin(target: T, point: ScreenPoint) {
      press = {
        target,
        start: { screenX: point.screenX, screenY: point.screenY },
        moved: false,
        released: false,
      };
    },
    move,
    release(point: ScreenPoint) {
      move(point);
      if (press) press.released = true;
    },
    click(target: T, clickCount: number) {
      const valid = press !== null && press.target === target && press.released && !press.moved;
      const doubleClick = valid && clickCount === 2 && firstClickTarget === target;
      firstClickTarget = valid && clickCount === 1 ? target : null;
      press = null;
      return doubleClick;
    },
  };
}
