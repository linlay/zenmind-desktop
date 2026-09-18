import { Children, isValidElement, useId, useState, type ReactNode } from "react";
import type { TranslateFunction } from "../../../shared/i18n";

export function isEmptyIssuePropertyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.every(isEmptyIssuePropertyValue);
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function CollapsibleIssueProperties({ children, editing, t }: {
  children: ReactNode;
  editing: boolean;
  t: TranslateFunction;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const properties = Children.toArray(children);
  const isEmpty = (child: ReactNode) => isValidElement<{ empty?: boolean }>(child) && child.props.empty === true;
  const emptyCount = properties.filter(isEmpty).length;
  return <>
    <dl id={listId} className="kanban-detail-properties">
      {editing || expanded ? properties : properties.filter((child) => !isEmpty(child))}
    </dl>
    {!editing && emptyCount > 0 ? <button
      type="button"
      className="kanban-detail-empty-properties-toggle"
      aria-expanded={expanded}
      aria-controls={listId}
      onClick={() => setExpanded((value) => !value)}
    >{t(expanded ? "kanban.detail.collapseEmptyProperties" : "kanban.detail.expandEmptyProperties", { count: emptyCount })}</button> : null}
  </>;
}
