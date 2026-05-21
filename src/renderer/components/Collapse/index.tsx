import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import "./index.css";

export interface CollapseProps {
  className?: string;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  header: React.ReactNode;
  children: React.ReactNode;
}

export const Collapse: React.FC<CollapseProps> = ({
  className,
  expanded,
  onExpand,
  header,
  children,
}) => {
  const contentId = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  const measureContentHeight = useCallback(() => {
    setContentHeight(innerRef.current?.scrollHeight ?? 0);
  }, []);

  useLayoutEffect(() => {
    measureContentHeight();
  }, [children, expanded, measureContentHeight]);

  useLayoutEffect(() => {
    const innerElement = innerRef.current;

    if (!innerElement) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(measureContentHeight);
    resizeObserver.observe(innerElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, [measureContentHeight]);

  const handleToggle = () => {
    onExpand(!expanded);
  };

  return (
    <div className={`${expanded ? "is-expanded" : ""} Collapse ${className}`}>
      <button
        type="button"
        className="Collapse-header"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={handleToggle}
      >
        {header}
      </button>
      <div
        id={contentId}
        className="Collapse-content"
        style={{ height: expanded ? contentHeight : 0 }}
        aria-hidden={!expanded}
      >
        <div ref={innerRef} className="Collapse-contentInner">
          {children}
        </div>
      </div>
    </div>
  );
};
