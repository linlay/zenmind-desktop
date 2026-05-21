import React, {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Style from "./index.module.css";

type TooltipPlacement = "top" | "right" | "bottom" | "left";
type TooltipChildProps = {
  onBlur?: React.FocusEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  "aria-describedby"?: string;
};
type TooltipCloneProps = TooltipChildProps & React.RefAttributes<HTMLElement>;
type TooltipChildElement = React.ReactElement<TooltipCloneProps> & {
  ref?: React.Ref<HTMLElement>;
};

interface TooltipProps {
  children: TooltipChildElement;
  content: React.ReactNode;
  placement?: TooltipPlacement;
  offset?: number;
  enterDelay?: number;
  leaveDelay?: number;
  disabled?: boolean;
}
export const Tooltip: React.FC<TooltipProps> = (props) => {
  const {
    children,
    content,
    placement = "top",
    offset = 8,
    enterDelay = 250,
    leaveDelay = 80,
    disabled = false,
  } = props;
  const tooltipId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const enterTimerRef = useRef<number>();
  const leaveTimerRef = useRef<number>();
  const frameRef = useRef<number>();
  const [isVisible, setIsVisible] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] =
    useState<TooltipPlacement>(placement);
  const [position, setPosition] = useState<React.CSSProperties>({
    left: 0,
    top: 0,
    visibility: "hidden",
  });
  const hasContent =
    content !== null && content !== undefined && content !== false;

  const setTriggerRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node;

      const childRef = children.ref;
      if (typeof childRef === "function") {
        childRef(node);
      } else if (childRef) {
        (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
      }
    },
    [children],
  );

  const clearTimers = useCallback(() => {
    window.clearTimeout(enterTimerRef.current);
    window.clearTimeout(leaveTimerRef.current);
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    leaveTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
    }, leaveDelay);
  }, [clearTimers, leaveDelay]);

  const show = useCallback(
    (delay = enterDelay) => {
      if (disabled || !hasContent) {
        return;
      }
      clearTimers();
      enterTimerRef.current = window.setTimeout(() => {
        setIsVisible(true);
      }, delay);
    },
    [clearTimers, disabled, enterDelay, hasContent],
  );

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;

    if (!trigger || !tooltip) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportPadding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const fits = {
      top: triggerRect.top >= tooltipRect.height + offset + viewportPadding,
      right:
        viewportWidth - triggerRect.right >=
        tooltipRect.width + offset + viewportPadding,
      bottom:
        viewportHeight - triggerRect.bottom >=
        tooltipRect.height + offset + viewportPadding,
      left: triggerRect.left >= tooltipRect.width + offset + viewportPadding,
    };
    const resolvedPlacement = fits[placement]
      ? placement
      : ((["top", "bottom", "right", "left"] as TooltipPlacement[]).find(
          (side) => fits[side],
        ) ?? placement);
    let top = 0;
    let left = 0;

    if (resolvedPlacement === "top" || resolvedPlacement === "bottom") {
      left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
      top =
        resolvedPlacement === "top"
          ? triggerRect.top - tooltipRect.height - offset
          : triggerRect.bottom + offset;
    } else {
      left =
        resolvedPlacement === "left"
          ? triggerRect.left - tooltipRect.width - offset
          : triggerRect.right + offset;
      top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
    }

    const clampedLeft = Math.min(
      Math.max(left, viewportPadding),
      viewportWidth - tooltipRect.width - viewportPadding,
    );
    const clampedTop = Math.min(
      Math.max(top, viewportPadding),
      viewportHeight - tooltipRect.height - viewportPadding,
    );
    const arrowLeft = Math.min(
      Math.max(triggerRect.left + triggerRect.width / 2 - clampedLeft, 8),
      tooltipRect.width - 8,
    );
    const arrowTop = Math.min(
      Math.max(triggerRect.top + triggerRect.height / 2 - clampedTop, 8),
      tooltipRect.height - 8,
    );

    setResolvedPlacement(resolvedPlacement);
    setPosition({
      left: Math.round(clampedLeft),
      top: Math.round(clampedTop),
      visibility: "visible",
      "--tooltip-arrow-left": `${Math.round(arrowLeft)}px`,
      "--tooltip-arrow-top": `${Math.round(arrowTop)}px`,
    } as React.CSSProperties);
  }, [offset, placement]);

  useLayoutEffect(() => {
    if (!isVisible) {
      return;
    }

    updatePosition();
  }, [content, isVisible, updatePosition]);

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frameRef.current ?? 0);
      frameRef.current = window.requestAnimationFrame(updatePosition);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsVisible(false);
      }
    };

    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.cancelAnimationFrame(frameRef.current ?? 0);
    };
  }, [isVisible, updatePosition]);

  useEffect(() => {
    if (disabled || !hasContent) {
      setIsVisible(false);
    }
  }, [disabled, hasContent]);

  useEffect(() => {
    return () => {
      clearTimers();
      window.cancelAnimationFrame(frameRef.current ?? 0);
    };
  }, [clearTimers]);

  if (!isValidElement(children)) {
    return <>{children}</>;
  }

  const trigger = cloneElement<TooltipCloneProps>(children, {
    ref: setTriggerRef,
    "aria-describedby": isVisible ? tooltipId : undefined,
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      show(0);
    },
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      show();
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {isVisible
        ? createPortal(
            <div
              id={tooltipId}
              ref={tooltipRef}
              className={Style.Tooltip}
              onMouseEnter={() => show(0)}
              onMouseLeave={hide}
              onClick={(e) => e.stopPropagation()}
              role="tooltip"
              style={position}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
