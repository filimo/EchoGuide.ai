import { useState } from "react";
import type { Uncertainty } from "../domain/session";

type UncertaintyMarkProps = {
  uncertainty: Uncertainty;
};

export function UncertaintyMark({ uncertainty }: UncertaintyMarkProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPreviewed, setIsPreviewed] = useState(false);

  if (uncertainty.level === "none") {
    return null;
  }

  const detail = [uncertainty.reason, uncertainty.alternative].filter(Boolean).join(" ");
  const label = detail.length > 0 ? `Есть uncertainty: ${detail}` : "Есть uncertainty";
  const showDetail = detail.length > 0 && (isOpen || isPreviewed);

  return (
    <span className="uncertainty-wrap">
      <button
        aria-expanded={isOpen}
        aria-label={label}
        className={`uncertainty uncertainty-${uncertainty.level}`}
        type="button"
        onBlur={() => setIsPreviewed(false)}
        onClick={() => setIsOpen((current) => !current)}
        onFocus={() => setIsPreviewed(true)}
        onMouseEnter={() => setIsPreviewed(true)}
        onMouseLeave={() => setIsPreviewed(false)}
      >
        Есть uncertainty
      </button>
      {showDetail ? <span className="uncertainty-detail">{detail}</span> : null}
    </span>
  );
}
