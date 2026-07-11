import streamDeck from "@elgato/streamdeck";
import { SensorAction } from "./actions/sensorAction.js";
import { FanAction } from "./actions/fanAction.js";

streamDeck.actions.registerAction(new SensorAction());
streamDeck.actions.registerAction(new FanAction());

streamDeck.connect();
