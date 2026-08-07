import type { Metadata } from "next";

import { AboutPage } from "@/app/components/AboutPage";

export const metadata: Metadata = {
  title: "About Dawn — Your Personal Super-Connector",
};

export default function About() {
  return <AboutPage />;
}
