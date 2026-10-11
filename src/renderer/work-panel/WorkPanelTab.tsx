import { CloseOutlined } from "@ant-design/icons";
import type { KeyboardEventHandler, MouseEventHandler, ReactNode, Ref } from "react";

type WorkPanelTabProps = {
  title: string;
  tooltip?: string;
  active: boolean;
  overview?: boolean;
  loading?: boolean;
  icon: ReactNode;
  badge?: ReactNode;
  onActivate: () => void;
  onClose?: () => void;
  closeLabel?: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  triggerRef?: Ref<HTMLButtonElement>;
  id?: string;
  controls?: string;
  tabIndex?: number;
};

/** The common WorkPanel tab chrome; its owner retains activation and close state. */
export function WorkPanelTab({
  title, tooltip, active, overview, loading, icon, badge, onActivate, onClose,
  closeLabel, onContextMenu, onKeyDown, triggerRef, id, controls, tabIndex,
}: WorkPanelTabProps) {
  return (
    <div
      className={`chat-work-panel-tab${active ? " is-active" : ""}${overview ? " is-overview" : ""}${onClose ? " has-close" : ""}`}
      role="presentation"
      onContextMenu={onContextMenu}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="tab"
        className="chat-work-panel-tab-trigger"
        aria-selected={active}
        aria-controls={controls}
        tabIndex={tabIndex}
        title={tooltip || title}
        onClick={onActivate}
        onKeyDown={onKeyDown}
      >
        <span className={`chat-work-panel-tab-icon${loading ? " is-loading" : ""}`} aria-hidden="true">
          {loading ? <span className="chat-work-panel-tab-loading-spinner" /> : icon}
        </span>
        <span className="chat-work-panel-tab-title">{title}</span>
        {badge}
      </button>
      {onClose ? (
        <button
          type="button"
          className="chat-work-panel-tab-close"
          aria-label={closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <CloseOutlined />
        </button>
      ) : null}
    </div>
  );
}
