const PET_HIT_ALPHA_THRESHOLD = 24;
const PET_HIT_PADDING_PX = 1;
const PET_MASK_FRAME_WIDTH = 96;

export type DesktopPetAlphaMask = {
  frameWidth: number;
  height: number;
  frameCount: number;
  alpha: Uint8Array;
};

export function createDesktopPetAlphaMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  frameCount: number
): DesktopPetAlphaMask {
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = pixels[index * 4 + 3];
  }
  return { frameWidth: width / frameCount, height, frameCount, alpha };
}

export function desktopPetMaskContainsPoint(
  mask: DesktopPetAlphaMask,
  x: number,
  y: number,
  frame: number,
  mirrored = false
) {
  if (x < 0 || y < 0 || x >= mask.frameWidth || y >= mask.height) {
    return false;
  }
  const pixelX = mirrored ? mask.frameWidth - 1 - Math.floor(x) : Math.floor(x);
  const pixelY = Math.floor(y);
  const frameOffset = Math.max(0, Math.min(mask.frameCount - 1, Math.floor(frame))) * mask.frameWidth;
  const atlasWidth = mask.frameWidth * mask.frameCount;
  // A single pixel of tolerance keeps the outline easy to grab without reviving
  // the transparent rectangle around the character or a neighbouring frame.
  for (let dy = -PET_HIT_PADDING_PX; dy <= PET_HIT_PADDING_PX; dy += 1) {
    for (let dx = -PET_HIT_PADDING_PX; dx <= PET_HIT_PADDING_PX; dx += 1) {
      const sampleX = pixelX + dx;
      const sampleY = pixelY + dy;
      if (sampleX < 0 || sampleX >= mask.frameWidth || sampleY < 0 || sampleY >= mask.height) {
        continue;
      }
      if (mask.alpha[sampleY * atlasWidth + frameOffset + sampleX] >= PET_HIT_ALPHA_THRESHOLD) {
        return true;
      }
    }
  }
  return false;
}

const maskCache = new Map<string, Promise<DesktopPetAlphaMask | null>>();

export function loadDesktopPetAlphaMask(assetPath: string, frameCount: number, isSprite: boolean) {
  const key = `${assetPath}\u0000${frameCount}\u0000${isSprite}`;
  const cached = maskCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = new Promise<DesktopPetAlphaMask | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onerror = () => resolve(null);
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = PET_MASK_FRAME_WIDTH * frameCount;
        canvas.height = isSprite
          ? 104
          : Math.max(1, Math.round(PET_MASK_FRAME_WIDTH * image.naturalHeight / image.naturalWidth));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(createDesktopPetAlphaMask(
          context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
          frameCount
        ));
      } catch {
        // If an imported asset cannot be sampled, keep only its image bounds
        // interactive; never fall back to the whole transparent native window.
        resolve(null);
      }
    };
    image.src = assetPath;
  });
  if (maskCache.size >= 24) {
    maskCache.delete(maskCache.keys().next().value!);
  }
  maskCache.set(key, pending);
  return pending;
}

export function pointIntersectsDesktopPetImage(
  element: HTMLElement,
  mask: DesktopPetAlphaMask | null,
  x: number,
  y: number
) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
    return false;
  }
  if (!mask) {
    return true;
  }
  const style = getComputedStyle(element);
  const transform = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
  const frame = mask.frameCount > 1
    ? Math.round(-Number.parseFloat(style.backgroundPositionX) / element.offsetWidth)
    : 0;
  return desktopPetMaskContainsPoint(
    mask,
    (x - rect.left) / rect.width * mask.frameWidth,
    (y - rect.top) / rect.height * mask.height,
    Number.isFinite(frame) ? frame : 0,
    transform.a < 0
  );
}
