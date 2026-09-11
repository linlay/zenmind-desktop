import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export function ChatTitle({ text }: { text: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = textRef.current;
    if (!container || !content) return;

    const measure = () => {
      setOverflow(Math.max(0, content.scrollWidth - container.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={containerRef}
      className="worker-chat-name sidebar-chat-title"
      data-overflow={overflow > 0 ? "true" : undefined}
      style={{
        "--chat-title-offset": `${-overflow}px`,
        "--chat-title-duration": `${Math.max(2, overflow / 35 + 1)}s`,
      } as CSSProperties}
    >
      <span ref={textRef} className="sidebar-chat-title-text">{text}</span>
    </span>
  );
}
