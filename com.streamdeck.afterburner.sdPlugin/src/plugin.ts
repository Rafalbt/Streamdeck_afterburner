import streamDeck from "@elgato/streamdeck";
import { SensorAction } from "./actions/sensorAction.js";
import { FanAction } from "./actions/fanAction.js";

// Verbose logging while we develop the fan-control (NVAPI/ADL) FFI.
streamDeck.logger.setLevel("trace");

streamDeck.actions.registerAction(new SensorAction());
streamDeck.actions.registerAction(new FanAction());

streamDeck.connect();
