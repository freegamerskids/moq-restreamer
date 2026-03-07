export async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
		},
	});
	if (!response.ok) {
		await response.arrayBuffer().catch(() => undefined);
		throw new Error(`Failed to fetch playlist ${url}: ${response.status} ${response.statusText}`);
	}
	return await response.text();
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
		},
	});
	if (!response.ok) {
		await response.arrayBuffer().catch(() => undefined);
		throw new Error(`Failed to fetch segment ${url}: ${response.status} ${response.statusText}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}
