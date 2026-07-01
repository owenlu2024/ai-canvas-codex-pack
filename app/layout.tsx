import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Canvas",
  description: "Local AI canvas prototype",
  other: {
    google: "notranslate"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html className="notranslate" lang="zh-CN" translate="no">
      <body className="notranslate" translate="no">
        {children}
      </body>
    </html>
  );
}
