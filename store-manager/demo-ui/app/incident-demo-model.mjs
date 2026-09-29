export function readyIncidentState(telegramEnabled = false) {
  return {
    connected: true,
    phase: "ready",
    active: false,
    deliveryId: null,
    deliveryTarget: null,
    telegramEnabled: telegramEnabled === true,
    image: {
      src: "/incident.jpg",
      alt: "Current camera view of the reported produce-area incident",
      location: "Fruit and vegetable section",
    },
  };
}

export function sentIncidentState(deliveryId = null, telegramEnabled = true) {
  return {
    ...readyIncidentState(telegramEnabled),
    phase: "sent",
    active: true,
    deliveryTarget: "telegram",
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
