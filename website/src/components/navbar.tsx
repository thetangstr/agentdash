"use client";

import { useState } from "react";
import Link from "next/link";
import { brand } from "@/config/branding";

const navLinks = [
  { label: "Features", href: "/features" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "#" },
  { label: "Contact", href: "/contact" },
];

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-16 border-b border-border bg-surface">
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">
        {/* Brand */}
        <Link href="/" className="text-lg font-bold text-text-primary">
          {brand.name}
        </Link>

        {/* Desktop links */}
        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href + link.label}
              href={link.href}
              className="text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/contact"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            Get Started
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          type="button"
          className="flex items-center justify-center md:hidden"
          aria-label="Toggle menu"
          onClick={() => setMobileOpen((prev) => !prev)}
        >
          <svg
            className="h-6 w-6 text-text-primary"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            {mobileOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile dropdown */}
      {mobileOpen && (
        <div className="border-b border-border bg-surface px-6 pb-4 pt-2 md:hidden">
          {navLinks.map((link) => (
            <Link
              key={link.href + link.label}
              href={link.href}
              className="block py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/contact"
            className="mt-2 block rounded-lg bg-brand-600 px-4 py-2 text-center text-sm font-medium text-white transition-colors hover:bg-brand-700"
            onClick={() => setMobileOpen(false)}
          >
            Get Started
          </Link>
        </div>
      )}
    </nav>
  );
}
