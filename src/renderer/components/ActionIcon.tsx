import type { ReactNode } from "react";

// Use the control center's inset 24-unit drawings, rather than full-frame glyphs.
const paths = {
  start: <path d="M7.25 4.75v14.5L18.75 12 7.25 4.75Z" />,
  stop: <path d="M6.75 6.75h10.5v10.5H6.75z" />,
  restart: <path d="M440-122q-121-15-200.5-105.5T160-440q0-66 26-126.5T260-672l57 57q-38 34-57.5 79T240-440q0 88 56 155.5T440-202v80Zm80 0v-80q87-16 143.5-83T720-440q0-100-70-170t-170-70h-3l44 44-56 56-140-140 140-140 56 56-44 44h3q134 0 227 93t93 227q0 121-79.5 211.5T520-122Z" />,
  open: <><path d="M8 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" /><path d="M14 4h6v6m-9 3 8.5-8.5" /></>,
  info: <><circle cx="12" cy="6.75" r="2.15" /><path d="M10.55 10.05h2.9v9.2h-2.9z" /></>,
  refresh: <><path d="M19 9a7.25 7.25 0 1 0 .1 5" /><path d="M19 4.5V9h-4.5" /></>,
  import: <><path d="M5.5 14.5v3.25A2.25 2.25 0 0 0 7.75 20h8.5a2.25 2.25 0 0 0 2.25-2.25V14.5" /><path d="M12 4v9m-3.5-3.5L12 13l3.5-3.5" /></>,
  export: <><path d="M5.5 14.5v3.25A2.25 2.25 0 0 0 7.75 20h8.5a2.25 2.25 0 0 0 2.25-2.25V14.5" /><path d="M12 13V4m-3.5 3.5L12 4l3.5 3.5" /></>,
  add: <path d="M12 5.5v13M5.5 12h13" />,
  delete: <><path d="M9 5h6M5.5 8h13M8 8l.6 10.2A2 2 0 0 0 10.6 20h2.8a2 2 0 0 0 2-1.8L16 8M10.5 11v5m3-5v5" /></>,
  edit: <><path d="m14.5 5.5 4 4M5 19l4.5-1 10-10a1.75 1.75 0 0 0-4-4l-10 10L5 19Z" /></>,
  copy: <><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  reveal: <><path d="M3.5 12s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  hide: <><path d="M4 4l16 16M9 6.5a10 10 0 0 1 3-.5c5.5 0 8.5 6 8.5 6a17 17 0 0 1-2.5 3.2M6 8a17 17 0 0 0-2.5 4s3 6 8.5 6a10 10 0 0 0 3-.5" /></>,
  publish: <><path d="M7 18H6a3 3 0 0 1-.5-6 6.5 6.5 0 0 1 12.6-2A4 4 0 0 1 18 18h-1" /><path d="M12 20V11m-3 3 3-3 3 3" /></>
} satisfies Record<string, ReactNode>;

export type ActionIconName = keyof typeof paths;

export function ActionIcon({ name }: { name: ActionIconName }) {
  return <svg className={`service-action-icon service-action-icon-${name}`}
    viewBox={name === "restart" ? "0 -960 960 960" : "0 0 24 24"}
    aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
