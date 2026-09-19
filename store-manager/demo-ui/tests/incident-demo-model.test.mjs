import assert from "node:assert/strict";
import test from "node:test";

import {
  readyIncidentState,
  sentIncidentState,
  unavailableIncidentState,
} from "../app/incident-demo-model.mjs";

test("keeps the camera evidence inactive until the event is triggered", () => {
  const ready = readyIncidentState();
  assert.equal(ready.connected, true);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.active, false);
  assert.equal(ready.image.src, "/incident.jpg");
  assert.equal(ready.image.location, "Fruit and vegetable section");
});

test("shows the incident after Hermes accepts the signed event", () => {
  const sent = sentIncidentState("delivery-incident-001");
  assert.equal(sent.connected, true);
  assert.equal(sent.phase, "sent");
  assert.equal(sent.active, true);
  assert.equal(sent.deliveryId, "delivery-incident-001");
});

test("returns a bounded unavailable incident state", () => {
  const unavailable = unavailableIncidentState();
  assert.equal(unavailable.connected, false);
  assert.equal(unavailable.phase, "unavailable");
  assert.equal(unavailable.active, false);
  assert.equal(unavailable.deliveryId, null);
});
