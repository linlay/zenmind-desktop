interface PlaceholderPageProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <section className="placeholder-page">
      <div className="placeholder-orbit" />
      <div className="placeholder-copy">
        <p className="eyebrow">Coming Next</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </section>
  );
}
