export function readyIncidentState() {
  return {
    connected: true,
    phase: "ready",
    active: false,
    deliveryId: null,
    image: {
      src: "/incident.jpg",
      alt: "Current camera view of the reported produce-area incident",
      location: "Fruit and vegetable section",
    },
  };
}

export function sentIncidentState(deliveryId = null) {
  return {
    ...readyIncidentState(),
    phase: "sent",
    active: true,
    deliveryId: typeof deliveryId === "string" && deliveryId.trim()
      ? deliveryId.trim()
      : null,
  };
}

export function unavailableIncidentState() {
  return {
    ...readyIncidentState(),
    connected: false,
    phase: "unavailable",
  };
}
