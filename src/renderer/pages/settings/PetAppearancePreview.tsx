import { useEffect, useState, type CSSProperties } from "react";
import type { DesktopPetAppearanceOption } from "../../../shared/contracts";

/** Hover previews are local: they never request an action from the live desktop pet. */
export function PetAppearancePreview({ appearance, hovered }: {
  appearance: DesktopPetAppearanceOption;
  hovered: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setPlaying(hovered); }, [hovered, appearance.id]);
  const active = hovered && playing;
  const signature = appearance.signature?.[0]?.variants[0];
  const asset = active && signature ? signature : appearance.states.idle;
  if (!asset?.path) return <img src={appearance.previewUrl} alt="" />;
  const frames = Math.max(1, Math.round(Number(asset.frameCount) || 1));
  const style = {
    "--desktop-pet-appearance-preview-frames": String(frames),
    "--pet-preview-end": `${-128 * frames}px`,
    backgroundImage: `url("${appearance.assetBasePath.replace(/\/$/u, "")}/${asset.path}")`,
    animation: active
      ? `pet-card-action ${signature ? signature.durationMs : 600}ms steps(${frames}, end) 1`
      : "none"
  } as CSSProperties;
  return <span key={`${asset.path}:${active}`} className="desktop-pet-appearance-sprite" style={style}
    onAnimationEnd={() => setPlaying(false)} />;
}
