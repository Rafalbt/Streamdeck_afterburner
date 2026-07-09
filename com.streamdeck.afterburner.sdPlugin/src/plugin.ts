import streamDeck from "@elgato/streamdeck";
import { SensorAction } from "./actions/sensorAction.js";

streamDeck.actions.registerAction(new SensorAction());

streamDeck.connect();
