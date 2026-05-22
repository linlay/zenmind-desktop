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
  offset?: number;
  disabled?: boolean;
  closeOnOutsideClick?: boolean;
  closeOnEscape?: boolean;
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
    offset = 8,
    disabled = false,
    closeOnOutsideClick = true,
    closeOnEscape = true,
    className,
    style,
  } = props;
  const popoverId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>();
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

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;

    if (!trigger || !popover) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
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
  }, [offset, placement]);

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
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        !closeOnOutsideClick ||
        !target ||
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
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
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
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
    };
  }, []);

  if (!isValidElement(children)) {
    return <>{children}</>;
  }

  const trigger = cloneElement<PopoverCloneProps>(children, {
    ref: setTriggerRef,
    "aria-controls": isOpen ? popoverId : undefined,
    "aria-expanded": isOpen,
    "aria-haspopup": "dialog",
    tabIndex: children.props.tabIndex ?? 0,
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onClick?.(event);

      if (!event.defaultPrevented) {
        setOpen(!isOpen);
      }
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      children.props.onKeyDown?.(event);

      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(!isOpen);
      }
    },
  });

  return (
    <>
      {trigger}
      {isOpen && hasContent
        ? createPortal(
            <div
              id={popoverId}
              ref={popoverRef}
              className={`${Style.Popover} ${className || ""}`}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              style={{ ...position, ...style }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
