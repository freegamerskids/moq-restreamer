const DEFAULT_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};

function mergeHeaders(custom?: Record<string, string>): Record<string, string> {
	if (!custom || Object.keys(custom).length === 0) return DEFAULT_HEADERS;
	return { ...DEFAULT_HEADERS, ...custom };
}

export async function fetchText(
	url: string,
	options?: { headers?: Record<string, string> },
): Promise<string> {
	const headers = mergeHeaders(options?.headers);
	const response = await fetch(url, { headers });
	if (!response.ok) {
		await response.arrayBuffer().catch(() => undefined);
		throw new Error(`Failed to fetch playlist ${url}: ${response.status} ${response.statusText}`);
	}
	return await response.text();
}

export async function fetchBytes(
	url: string,
	options?: { headers?: Record<string, string> },
): Promise<Uint8Array> {
	const headers = mergeHeaders(options?.headers);
	const response = await fetch(url, { headers });
	if (!response.ok) {
		await response.arrayBuffer().catch(() => undefined);
		throw new Error(`Failed to fetch segment ${url}: ${response.status} ${response.statusText}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}
