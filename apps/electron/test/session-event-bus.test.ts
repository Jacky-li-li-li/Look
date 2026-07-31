import { describe, expect, it } from "vitest";
import { SessionEventBus } from "../src/main/session/events/session-event-bus.js";

describe("SessionEventBus", () => {
	it("delivers events to every current subscriber and supports unsubscribe", () => {
		const bus = new SessionEventBus();
		const received: string[] = [];
		const unsubscribe = bus.onEvent((event) => received.push(event.type));
		bus.onEvent((event) => received.push(`second:${event.type}`));

		bus.emit({ type: "usage:updated" });
		unsubscribe();
		bus.emit({ type: "mcp:status-changed" });

		expect(received).toEqual(["usage:updated", "second:usage:updated", "second:mcp:status-changed"]);
		expect(bus.size).toBe(1);
	});

	it("uses a dispatch snapshot when a callback unsubscribes during delivery", () => {
		const bus = new SessionEventBus();
		const received: string[] = [];
		let unsubscribeSecond!: () => void;
		bus.onEvent(() => {
			received.push("first");
			unsubscribeSecond();
		});
		unsubscribeSecond = bus.onEvent(() => received.push("second"));

		bus.emit({ type: "usage:updated" });
		bus.emit({ type: "usage:updated" });

		expect(received).toEqual(["first", "second", "first"]);
	});
});
