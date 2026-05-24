import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownContent } from "../help/MarkdownContent";
import { getHelpContent } from "../help/helpContent";
import { useI18n } from "../i18n/useI18n";
import "./SplitWorkspaceLayout.css";
import "./HelpPage.css";

type HelpPageProps = {
  isWindows: boolean;
};

const ACCORDION_FALLBACK_HEIGHT = 800;

export function HelpPage({ isWindows }: HelpPageProps) {
  const { locale } = useI18n();
  const helpContent = useMemo(() => getHelpContent(locale, isWindows), [isWindows, locale]);
  const [activeCat, setActiveCat] = useState(() => helpContent.categories[0]?.id ?? "");
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const bodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("theme-help");
    return () => document.documentElement.classList.remove("theme-help");
  }, []);

  useEffect(() => {
    const categoryExists = helpContent.categories.some((category) => category.id === activeCat);
    if (!categoryExists) {
      setActiveCat(helpContent.categories[0]?.id ?? "");
      setOpenItems(new Set());
      contentRef.current?.scrollTo({ top: 0 });
    }
  }, [activeCat, helpContent.categories]);

  const currentCategory = helpContent.categories.find((category) => category.id === activeCat) ?? helpContent.categories[0];

  const switchCategory = useCallback((catId: string) => {
    setActiveCat(catId);
    setOpenItems(new Set());
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const toggleItem = useCallback((key: string) => {
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  return (
    <section className="help-page split-workspace-page">
      <div className="help-layout split-workspace-layout">
        <aside className="help-sidebar split-workspace-sidebar-card">
          <h2 className="help-sidebar-title">{helpContent.sidebarTitle}</h2>
          <nav className="help-nav">
            {helpContent.categories.map((cat) => (
              <button
                key={cat.id}
                className={`help-nav-btn${activeCat === cat.id ? " is-active" : ""}`}
                onClick={() => switchCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="help-main split-workspace-main-card" ref={contentRef}>
          <div className="help-hero">
            <h1 className="help-hero-title">{helpContent.heroTitle}</h1>
            <p className="help-hero-desc">{helpContent.heroDescription}</p>
          </div>

          <div className="help-faq-list">
            {currentCategory?.items.map((item) => {
              const key = `${currentCategory.id}-${item.id}`;
              const isOpen = openItems.has(key);
              return (
                <div
                  key={key}
                  className={`help-faq-item${isOpen ? " is-open" : ""}`}
                >
                  <button
                    className="help-faq-trigger"
                    onClick={() => toggleItem(key)}
                    aria-expanded={isOpen}
                  >
                    <span className="help-faq-question">{item.title}</span>
                    <svg
                      className="help-faq-chevron"
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                    >
                      <path
                        d="M5 7.5L10 12.5L15 7.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <div
                    className="help-faq-body"
                    ref={(el) => {
                      if (el) bodyRefs.current.set(key, el);
                      else bodyRefs.current.delete(key);
                    }}
                    style={{
                      maxHeight: isOpen
                        ? `${bodyRefs.current.get(key)?.scrollHeight ?? ACCORDION_FALLBACK_HEIGHT}px`
                        : "0px",
                    }}
                  >
                    <div className="help-faq-answer">
                      <MarkdownContent markdown={item.markdown} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
