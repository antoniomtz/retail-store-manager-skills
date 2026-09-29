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
    images: [
      {
        url: "/store-layout-no-people.png",
        width: 1137,
        height: 909,
        alt: "Isometric retail store with receiving, aisles, pickup, checkout, produce, and an operations office",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Retail Agent Platform Demo",
    description:
      "A visual demonstration of Store Manager priorities and Hermes activity.",
    images: ["/store-layout-no-people.png"],
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function Home() {
  return <StoreSimulation />;
}
