import type { Metadata } from "next";
import StoreSimulation from "./StoreSimulation";

export const metadata: Metadata = {
  title: "Retail Agent Platform Demo",
  description:
    "An animated retail environment paired with live Hermes and NeMo Relay platform telemetry.",
  openGraph: {
    title: "Retail Agent Platform Demo",
    description:
      "A visual demonstration of Hermes agent activity and the Retail Agent Toolkit telemetry path.",
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
      "A visual demonstration of Hermes activity, tools, models, and trace delivery.",
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
