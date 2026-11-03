import type { ReactNode } from "react";

const paths = {
  annotate: (
    <>
      <path d="M6 4h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-6 3V7a3 3 0 0 1 3-3Z" />
      <path d="M7 9h10M7 13h6" />
    </>
  ),
  removeObject: (
    <>
      <path d="m4 12 8-8a2 2 0 0 1 2.8 0l5.2 5.2a2 2 0 0 1 0 2.8L12 20H8l-4-4a2.83 2.83 0 0 1 0-4Zm4-4 8 8M12 20h8.5" />
      <path d="M3.5 4v3M2 5.5h3" />
    </>
  ),
  removeBackground: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M4.5 4.5h5v5h-5zm10 0h5v5h-5zm-5 5h5v5h-5zm-5 5h5v5h-5zm10 0h5v5h-5z" fill="currentColor" stroke="none" opacity=".3" />
      <path d="M3 21 21 3" />
    </>
  ),
  replaceBackground: (
    <>
      <path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
      <circle cx="7.5" cy="8.5" r="1.5" />
      <path d="m3 17 4.5-4.5L12 17l3-3 6 6M15 4h6l-2-2m2 6h-6l2 2" />
    </>
  ),
  outpaint: (
    <>
      <path d="M8 3H4a1 1 0 0 0-1 1v4m13-5h5v5M3 16v5h5m8 0h4a1 1 0 0 0 1-1v-4" />
      <rect x="7.5" y="7.5" width="9" height="9" rx="1" />
      <path d="m7.5 14 2.5-2.5 2.5 2.5 1.5-1.5 2.5 2.5M17 7l4-4M3 21l4-4" />
    </>
  ),
  enhance: (
    <>
      <path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5M3 17l5-5 4 4 2-2 6 6" />
      <path d="m16.5 2 1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4L10.5 8l4.4-1.6L16.5 2Z" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export function WorkPanelImageToolIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
