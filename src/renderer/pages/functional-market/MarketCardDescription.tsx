import { useRef, useState } from "react";
import { Popover } from "antd";

/** Keep short descriptions quiet; reveal only text clipped by the card layout. */
export function MarketCardDescription({ text, onDetail }: { text: string; onDetail: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <Popover trigger={["hover", "focus"]} placement="topLeft" mouseEnterDelay={0.3}
    open={open} onOpenChange={(next) => {
      const button = buttonRef.current;
      setOpen(Boolean(next && button && (button.scrollHeight > button.clientHeight || button.scrollWidth > button.clientWidth)));
    }}
    styles={{ root: { maxWidth: "min(380px, calc(100vw - 32px))" } }}
    content={<div className="skill-discovery-package-preview">{text}</div>}>
    <button ref={buttonRef} type="button" className="skill-discovery-description"
      onClick={() => { setOpen(false); onDetail(); }}>{text}</button>
  </Popover>;
}
