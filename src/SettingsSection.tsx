import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export default function SettingsSection({ headingId, title, description, icon, className = "", children }: {
  headingId?: string;
  title: string;
  description: ReactNode;
  icon: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const titleId = headingId ?? `${id}-heading`;
  const descriptionId = `${id}-description`;
  const contentId = `${id}-content`;
  const [expanded, setExpanded] = useState(false);

  return (
    <section className={`settings-card settings-section${className ? ` ${className}` : ""}`} aria-labelledby={titleId}>
      <h2 className="settings-section-heading">
        <button
          type="button"
          className="settings-section-toggle"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(current => !current)}
        >
          <span className="settings-section-icon" aria-hidden="true">{icon}</span>
          <span className="settings-section-copy">
            <span id={titleId} className="settings-section-title">{title}</span>
            <span id={descriptionId} className="settings-section-description">{description}</span>
          </span>
          <ChevronDown className="settings-section-chevron" size={18} aria-hidden="true" />
        </button>
      </h2>
      {/* Keep drafts and pending operations alive when the section is folded. */}
      <div id={contentId} className="settings-section-content" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
