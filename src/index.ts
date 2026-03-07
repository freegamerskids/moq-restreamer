import { WebTransport, quicheLoaded } from "@fails-components/webtransport";

// @ts-expect-error - WebTransport polyfill for Node
global.WebTransport = WebTransport;

import { buildStreamBroadcasts, relayUrl, runBroadcastLoop } from "./broadcast.js";
import { loadStreamList, streamsFile } from "./config.js";
import * as Moq from "@moq/lite";

await quicheLoaded;

async function main() {
	const entries = await loadStreamList(streamsFile);
	const streamBroadcasts = await buildStreamBroadcasts(entries);
	console.log(`Registered ${streamBroadcasts.length} stream(s).`);

	for (;;) {
		let connection: Awaited<ReturnType<typeof Moq.Connection.connect>>;
		try {
			connection = await Moq.Connection.connect(relayUrl);
		} catch (err) {
			console.error("Failed to connect:", err);
			await new Promise((r) => setTimeout(r, 5000));
			continue;
		}

		for (const sb of streamBroadcasts) {
			const broadcast = new Moq.Broadcast();
			connection.publish(sb.path, broadcast);
			void runBroadcastLoop(broadcast, sb);
		}
		console.log(`Published ${streamBroadcasts.length} broadcast(s). Waiting for subscribers...`);

		await connection.closed;
		console.log("Connection closed. Reconnecting in 2s...");
		await new Promise((r) => setTimeout(r, 2000));
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
