import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Store Manager Simulation",
  description:
    "Static-first demo UI for the Store Manager Agent reference blueprint.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
