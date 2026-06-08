import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";
import ModeNav from "@/components/ModeNav";

// DM Sans is the official Circles brand typeface (shipped in their media-kit).
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Word Circles",
  description: "A daily word game on Circles",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ModeNav />
        {children}
      </body>
    </html>
  );
}
