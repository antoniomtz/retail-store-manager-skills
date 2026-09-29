export type IncidentDemoState = {
  connected: boolean;
  phase: "ready" | "sending" | "analyzing" | "complete" | "sent" | "failed" | "unavailable";
  active: boolean;
  deliveryId: string | null;
  deliveryTarget: "ui" | "telegram" | null;
  telegramEnabled: boolean;
  image: {
    src: string;
    alt: string;
    location: string;
  };
};

export function readyIncidentState(telegramEnabled?: boolean): IncidentDemoState;
export function sentIncidentState(deliveryId?: string | null, telegramEnabled?: boolean): IncidentDemoState;
export function unavailableIncidentState(): IncidentDemoState;
