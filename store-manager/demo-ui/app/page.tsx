import type { Metadata } from "next";
import StoreSimulation from "./StoreSimulation";

export const metadata: Metadata = {
  title: "Retail Agent Platform Demo",
  description:
    "An animated retail environment with current manager priorities and Hermes activity.",
  openGraph: {
    title: "Retail Agent Platform Demo",
    description:
      "A visual demonstration of Store Manager priorities and Hermes activity.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Retail Agent Platform Demo",
    description:
      "A visual demonstration of Store Manager priorities and Hermes activity.",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function Home() {
  return <StoreSimulation />;
}
