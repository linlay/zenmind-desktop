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
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  header: React.ReactNode;
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
  headerActions,
  headerButtonProps,
  headerButtonRef,
  headerPopover,
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
      aria-expanded={expanded}
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
      className={["Collapse", expanded ? "is-expanded" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="Collapse-header">
        {headerPopover ? (
          <Popover
            trigger="hover"
            closeOnOutsideClick={false}
            {...headerPopover}
          >
            {headerButton}
          </Popover>
        ) : headerButton}
        {headerActions ? (
          <div className="Collapse-headerActions">{headerActions}</div>
        ) : null}
      </div>
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
