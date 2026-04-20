import type { ReactNode } from "react";

// AgentDash: luxe sidebar section label (mono uppercase eyebrow above nav group).

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
}

export function SidebarSection({ label, children }: SidebarSectionProps) {
  return (
    <div>
      <div className="lux-section-label">{label}</div>
      <div className="flex flex-col gap-0.5 mt-0.5">{children}</div>
    </div>
  );
}
