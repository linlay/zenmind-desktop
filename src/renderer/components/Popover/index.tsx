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

type PopoverPlacement =
  | "top"
  | "top-start"
  | "top-end"
  | "right"
  | "right-start"
  | "right-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end";

type PopoverChildProps = {
  onClick?: React.MouseEventHandler<HTMLElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  onMouseDown?: React.MouseEventHandler<HTMLElement>;
  onMouseUp?: React.MouseEventHandler<HTMLElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
  "aria-controls"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: React.AriaAttributes["aria-haspopup"];
  tabIndex?: number;
};
type PopoverCloneProps = PopoverChildProps & React.RefAttributes<HTMLElement>;
type PopoverChildElement = React.ReactElement<PopoverCloneProps> & {
  ref?: React.Ref<HTMLElement>;
};

interface PopoverProps {
  children: PopoverChildElement;
  content: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: PopoverPlacement;
  positionReferenceRef?: React.RefObject<HTMLElement | null>;
  offset?: number;
  disabled?: boolean;
  closeOnOutsideClick?: boolean;
  closeOnEscape?: boolean;
  trigger?: "click" | "hover";
  hoverEnterDelay?: number;
  hoverLeaveDelay?: number;
  shouldOpen?: (trigger: HTMLElement) => boolean;
  className?: string;
  style?: React.CSSProperties;
}
export const Popover: React.FC<PopoverProps> = (props) => {
  const {
    children,
    content,
    open,
    defaultOpen = false,
    onOpenChange,
    placement = "bottom",
    positionReferenceRef,
    offset = 8,
    disabled = false,
    closeOnOutsideClick = true,
    closeOnEscape = true,
    trigger: triggerMode = "click",
    hoverEnterDelay = 180,
    hoverLeaveDelay = 100,
    shouldOpen,
    className,
    style,
  } = props;
  const popoverId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>();
  const hoverOpenTimerRef = useRef<number>();
  const hoverCloseTimerRef = useRef<number>();
  const suppressHoverUntilLeaveRef = useRef(false);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [position, setPosition] = useState<React.CSSProperties>({
    left: 0,
    top: 0,
    visibility: "hidden",
  });
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;
  const hasContent =
    content !== null && content !== undefined && content !== false;
  const shouldRenderDismissLayer =
    triggerMode === "click" && closeOnOutsideClick && isOpen && hasContent;

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

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (disabled || !hasContent) {
        nextOpen = false;
      }

      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [disabled, hasContent, isControlled, onOpenChange],
  );

  const clearHoverTimers = useCallback(() => {
    window.clearTimeout(hoverOpenTimerRef.current);
    window.clearTimeout(hoverCloseTimerRef.current);
  }, []);

  const canOpenFromTrigger = useCallback(() => {
    const trigger = triggerRef.current;
    return !shouldOpen || (trigger ? shouldOpen(trigger) : false);
  }, [shouldOpen]);

  const setHoverSuppressed = useCallback((suppressed: boolean) => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    if (suppressed) {
      trigger.setAttribute("data-popover-hover-suppressed", "true");
    } else {
      trigger.removeAttribute("data-popover-hover-suppressed");
    }
  }, []);

  const openFromHover = useCallback((delay = hoverEnterDelay) => {
    if (triggerMode !== "hover") {
      return;
    }
    window.clearTimeout(hoverCloseTimerRef.current);
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = window.setTimeout(() => {
      setOpen(canOpenFromTrigger());
    }, delay);
  }, [canOpenFromTrigger, hoverEnterDelay, setOpen, triggerMode]);

  const closeFromHover = useCallback(() => {
    if (triggerMode !== "hover") {
      return;
    }
    window.clearTimeout(hoverOpenTimerRef.current);
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setOpen(false);
    }, hoverLeaveDelay);
  }, [hoverLeaveDelay, setOpen, triggerMode]);

  const updatePosition = useCallback(() => {
    const positionReference = positionReferenceRef?.current ?? triggerRef.current;
    const popover = popoverRef.current;

    if (!positionReference || !popover) {
      return;
    }

    const triggerRect = positionReference.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportPadding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const [side, align = "center"] = placement.split("-") as [
      "top" | "right" | "bottom" | "left",
      "start" | "center" | "end" | undefined,
    ];
    const fits = {
      top: triggerRect.top >= popoverRect.height + offset + viewportPadding,
      right:
        viewportWidth - triggerRect.right >=
        popoverRect.width + offset + viewportPadding,
      bottom:
        viewportHeight - triggerRect.bottom >=
        popoverRect.height + offset + viewportPadding,
      left: triggerRect.left >= popoverRect.width + offset + viewportPadding,
    };
    const resolvedSide = fits[side]
      ? side
      : ((["bottom", "top", "right", "left"] as const).find(
          (candidate) => fits[candidate],
        ) ?? side);
    let top = 0;
    let left = 0;

    if (resolvedSide === "top" || resolvedSide === "bottom") {
      top =
        resolvedSide === "top"
          ? triggerRect.top - popoverRect.height - offset
          : triggerRect.bottom + offset;

      if (align === "start") {
        left = triggerRect.left;
      } else if (align === "end") {
        left = triggerRect.right - popoverRect.width;
      } else {
        left = triggerRect.left + triggerRect.width / 2 - popoverRect.width / 2;
      }
    } else {
      left =
        resolvedSide === "left"
          ? triggerRect.left - popoverRect.width - offset
          : triggerRect.right + offset;

      if (align === "start") {
        top = triggerRect.top;
      } else if (align === "end") {
        top = triggerRect.bottom - popoverRect.height;
      } else {
        top = triggerRect.top + triggerRect.height / 2 - popoverRect.height / 2;
      }
    }

    setPosition({
      left: Math.round(
        Math.min(
          Math.max(left, viewportPadding),
          viewportWidth - popoverRect.width - viewportPadding,
        ),
      ),
      top: Math.round(
        Math.min(
          Math.max(top, viewportPadding),
          viewportHeight - popoverRect.height - viewportPadding,
        ),
      ),
      visibility: "visible",
    });
  }, [offset, placement, positionReferenceRef]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    updatePosition();
  }, [content, isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frameRef.current ?? 0);
      frameRef.current = window.requestAnimationFrame(updatePosition);
    };
    const isInsidePopover = (target: EventTarget | null) => {
      if (!(target instanceof Node)) {
        return false;
      }

      return (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      );
    };
    const handleOutsideInteraction = (event: MouseEvent | PointerEvent) => {
      const target = event.target;
      if (
        !closeOnOutsideClick ||
        isInsidePopover(target)
      ) {
        return;
      }

      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    document.addEventListener("pointerdown", handleOutsideInteraction, true);
    document.addEventListener("click", handleOutsideInteraction, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      document.removeEventListener(
        "pointerdown",
        handleOutsideInteraction,
        true,
      );
      document.removeEventListener("click", handleOutsideInteraction, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.cancelAnimationFrame(frameRef.current ?? 0);
    };
  }, [
    closeOnEscape,
    closeOnOutsideClick,
    isOpen,
    setOpen,
    updatePosition,
  ]);

  useEffect(() => {
    if (disabled || !hasContent) {
      setOpen(false);
    }
  }, [disabled, hasContent, setOpen]);

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(frameRef.current ?? 0);
      clearHoverTimers();
    };
  }, [clearHoverTimers]);

  if (!isValidElement(children)) {
    return <>{children}</>;
  }

  const trigger = cloneElement<PopoverCloneProps>(children, {
    ref: setTriggerRef,
    "aria-controls": triggerMode === "click"
      ? isOpen ? popoverId : undefined
      : children.props["aria-controls"],
    "aria-expanded": triggerMode === "click"
      ? isOpen
      : children.props["aria-expanded"],
    "aria-haspopup": triggerMode === "click"
      ? children.props["aria-haspopup"] ?? "dialog"
      : children.props["aria-haspopup"],
    tabIndex: children.props.tabIndex ?? 0,
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onClick?.(event);

      if (triggerMode === "click" && !event.defaultPrevented) {
        setOpen(!isOpen);
      }
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      children.props.onKeyDown?.(event);

      if (event.defaultPrevented) {
        return;
      }

      if (
        triggerMode === "click" &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        setOpen(!isOpen);
      }
    },
    onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseDown?.(event);
      if (triggerMode === "hover") {
        suppressHoverUntilLeaveRef.current = true;
        setHoverSuppressed(true);
        clearHoverTimers();
        setOpen(false);
      }
    },
    onMouseUp: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseUp?.(event);
      if (triggerMode === "hover") {
        suppressHoverUntilLeaveRef.current = true;
        setHoverSuppressed(true);
        clearHoverTimers();
        setOpen(false);
      }
    },
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      if (event.buttons !== 0) {
        suppressHoverUntilLeaveRef.current = true;
        setHoverSuppressed(true);
        clearHoverTimers();
        setOpen(false);
        return;
      }
      if (suppressHoverUntilLeaveRef.current) {
        return;
      }
      openFromHover();
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      suppressHoverUntilLeaveRef.current = false;
      setHoverSuppressed(false);
      closeFromHover();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      if (
        triggerMode === "hover" &&
        event.currentTarget.matches(":focus-visible")
      ) {
        clearHoverTimers();
        setOpen(canOpenFromTrigger());
      }
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      closeFromHover();
    },
  });

  return (
    <>
      {trigger}
      {isOpen && hasContent
        ? createPortal(
            <>
              {shouldRenderDismissLayer ? (
                <div className={Style.PopoverDismissLayer} aria-hidden="true" />
              ) : null}
              <div
                id={popoverId}
                ref={popoverRef}
                className={`${Style.Popover} ${className || ""}`}
                onClick={(event) => event.stopPropagation()}
                onMouseEnter={() => {
                  if (triggerMode === "hover") {
                    clearHoverTimers();
                  }
                }}
                onMouseLeave={closeFromHover}
                onFocusCapture={() => {
                  if (triggerMode === "hover") {
                    clearHoverTimers();
                  }
                }}
                onBlurCapture={closeFromHover}
                role="dialog"
                style={{ ...position, ...style }}
              >
                {content}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
};
