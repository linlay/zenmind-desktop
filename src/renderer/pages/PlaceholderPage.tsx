import type { ReactNode } from "react";

interface PlaceholderPageProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function PlaceholderPage({ title, description, action }: PlaceholderPageProps) {
  return (
    <section className="placeholder-page">
      <div className="placeholder-orbit" />
      <div className="placeholder-copy">
        <h1>{title}</h1>
        <p>{description}</p>
        {action}
      </div>
    </section>
  );
}
