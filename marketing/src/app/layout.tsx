import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AgentDash — AI Agent Orchestration",
  description: "Spin up AI employees that ship work, not just chat.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
