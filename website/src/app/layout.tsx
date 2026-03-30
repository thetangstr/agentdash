import type { Metadata } from "next";
import { brand } from "@/config/branding";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import "./globals.css";

export const metadata: Metadata = {
  title: `${brand.name} - ${brand.tagline}`,
  description: brand.description,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
