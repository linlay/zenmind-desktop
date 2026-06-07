import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownContent } from "../help/MarkdownContent";
import { getHelpContent } from "../help/helpContent";
import { useI18n } from "../i18n/useI18n";
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
    <section className="help-page help-page-single">
      <div className="help-content-panel">
        <div className="help-content-shell">
          <div className="help-page-head">
            <h1>{helpContent.sidebarTitle}</h1>
            <p className="page-copy">{helpContent.heroDescription}</p>
          </div>

          <div className="help-section-body">
            <div className="help-workspace">
              <aside className="help-sidebar help-category-card">
                <nav className="help-category-list" aria-label={helpContent.sidebarTitle}>
                  {helpContent.categories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      className={`help-category-btn${activeCat === cat.id ? " is-active" : ""}`}
                      onClick={() => switchCategory(cat.id)}
                      aria-current={activeCat === cat.id ? "page" : undefined}
                    >
                      {cat.label}
                    </button>
                  ))}
                </nav>
              </aside>

              <div className="help-main-card help-item-card" ref={contentRef}>
                <div className="help-item-section-head">
                  <div>
                    <strong>{currentCategory?.label ?? helpContent.sidebarTitle}</strong>
                    <span>{helpContent.heroTitle}</span>
                  </div>
                </div>

                <div className="help-faq-list help-item-list">
                  {currentCategory?.items.map((item) => {
                    const key = `${currentCategory.id}-${item.id}`;
                    const isOpen = openItems.has(key);
                    return (
                      <div
                        key={key}
                        className={`help-faq-item help-item-row${isOpen ? " is-open" : ""}`}
                      >
                        <button
                          type="button"
                          className="help-faq-trigger"
                          onClick={() => toggleItem(key)}
                          aria-expanded={isOpen}
                        >
                          <span className="help-faq-question">{item.title}</span>
                          <svg
                            className="help-faq-chevron"
                            width="16"
                            height="16"
                            viewBox="0 0 20 20"
                            fill="none"
                            aria-hidden="true"
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
          </div>
        </div>
      </div>
    </section>
  );
}
