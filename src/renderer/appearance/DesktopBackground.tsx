import { useState } from "react";
import type { DesktopSkinBackground } from "./model";

function BackgroundImage({ background, fallback }: { background: DesktopSkinBackground; fallback?: DesktopSkinBackground | null }) {
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading");
  if (state === "fallback" && fallback && fallback.imageUrl !== background.imageUrl) {
    return <BackgroundImage key={fallback.imageUrl} background={fallback} />;
  }
  return (
    <img
      className="desktop-background-image"
      src={background.imageUrl}
      alt=""
      draggable={false}
      decoding="async"
      data-background-state={state}
      style={{ objectPosition: background.position }}
      onLoad={() => setState("ready")}
      onError={() => setState("fallback")}
    />
  );
}

export function DesktopBackground({ background, fallback }: {
  background: DesktopSkinBackground | null;
  fallback?: DesktopSkinBackground | null;
}) {
  return (
    <div className="desktop-background" aria-hidden="true" hidden={!background}>
      {/* Only the decoration changes identity. A broken custom image falls
          back to the bundled wallpaper; a broken bundled image uses the base. */}
      {background ? <BackgroundImage key={background.imageUrl} background={background} fallback={fallback} /> : null}
    </div>
  );
}
