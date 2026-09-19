export type IncidentDemoState = {
  connected: boolean;
  phase: "ready" | "sending" | "sent" | "failed" | "unavailable";
  active: boolean;
  deliveryId: string | null;
  image: {
    src: string;
    alt: string;
    location: string;
  };
};

export function readyIncidentState(): IncidentDemoState;
export function sentIncidentState(deliveryId?: string | null): IncidentDemoState;
export function unavailableIncidentState(): IncidentDemoState;
