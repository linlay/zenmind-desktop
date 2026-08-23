import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Popover } from "../Popover";
import "./index.css";

type CollapseHeaderButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  Partial<Record<`data-${string}`, string | undefined>>;

type CollapseHeaderPopover = Pick<
  React.ComponentProps<typeof Popover>,
  "content" | "placement" | "className" | "hoverEnterDelay" | "hoverLeaveDelay"
>;

export interface CollapseProps {
  className?: string;
  expanded?: boolean;
  onExpand?: (expanded: boolean) => void;
  header: React.ReactNode;
  headerSupplement?: React.ReactNode;
  headerActions?: React.ReactNode;
  headerButtonProps?: CollapseHeaderButtonProps;
  headerButtonRef?: React.Ref<HTMLButtonElement>;
  headerPopover?: CollapseHeaderPopover;
  children: React.ReactNode;
}

export const Collapse: React.FC<CollapseProps> = ({
  className,
  expanded,
  onExpand,
  header,
  headerSupplement,
  headerActions,
  headerButtonProps,
  headerButtonRef,
  headerPopover,
  children,
}) => {
  const contentId = useId();
  const headerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [innerExpanded, setInnerExpanded] = useState(expanded ?? false);
  const resolvedExpanded = expanded ?? innerExpanded;
  const handleExpand = (val: boolean) => {
    setInnerExpanded(val);
    onExpand?.(val);
  }

  const measureContentHeight = useCallback(() => {
    setContentHeight(innerRef.current?.scrollHeight ?? 0);
  }, []);

  useLayoutEffect(() => {
    measureContentHeight();
  }, [children, resolvedExpanded, measureContentHeight]);

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
    handleExpand(!resolvedExpanded);
  };
  const {
    className: headerButtonClassName,
    onClick: onHeaderButtonClick,
    ...restHeaderButtonProps
  } = headerButtonProps ?? {};

  const headerButton = (
    <button
      {...restHeaderButtonProps}
      ref={headerButtonRef}
      type="button"
      className={["Collapse-trigger", headerButtonClassName]
        .filter(Boolean)
        .join(" ")}
      aria-expanded={resolvedExpanded}
      aria-controls={contentId}
      onClick={(event) => {
        onHeaderButtonClick?.(event);
        if (!event.defaultPrevented) {
          handleToggle();
        }
      }}
    >
      {header}
    </button>
  );

  return (
    <div
      className={["Collapse", resolvedExpanded ? "is-expanded" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div ref={headerRef} className="Collapse-header">
        {headerPopover ? (
          <Popover
            trigger="hover"
            closeOnOutsideClick={false}
            positionReferenceRef={headerRef}
            {...headerPopover}
          >
            {headerButton}
          </Popover>
        ) : headerButton}
        {headerSupplement ? (
          <div className="Collapse-headerSupplement">{headerSupplement}</div>
        ) : null}
        {headerActions ? (
          <div className="Collapse-headerActions">{headerActions}</div>
        ) : null}
      </div>
      <div
        id={contentId}
        className="Collapse-content"
        style={{ height: resolvedExpanded ? contentHeight : 0 }}
        aria-hidden={!resolvedExpanded}
      >
        <div ref={innerRef} className="Collapse-contentInner">
          {children}
        </div>
      </div>
    </div>
  );
};
