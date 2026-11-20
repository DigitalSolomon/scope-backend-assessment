import "~/styles/globals.css";

import { type Metadata } from "next";
import { Courier_Prime, Geist } from "next/font/google";

export const metadata: Metadata = {
  title: "Theater Showtimes Manager",
  description: "Manage theater showtimes and schedules.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

// ScopeBot's speech uses a typewriter face.
const typewriter = Courier_Prime({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-typewriter",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${typewriter.variable}`}>
      <body>
        {children}
      </body>
    </html>
  );
}
