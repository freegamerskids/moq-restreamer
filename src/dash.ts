import { setTimeout as sleep } from "node:timers/promises";

import { maxSegmentsPerPoll, seenUrlLimit } from "./config.js";
import { decryptIfNeeded } from "./cenc.js";
import { fetchBytes, fetchText } from "./fetch.js";
import { AVC_CODEC_STRING, getDefaultAvcCDescription } from "./init-segment.js";
import type {
	DashSegmentTemplate,
	DashTrackDescriptor,
	RunnerConfig,
	RunnerContext,
	StreamKind,
} from "./types.js";
import { createBoundedSeen, parseAttributeLine } from "./util.js";

function parseSegmentTemplate(xml: string): DashSegmentTemplate | null {
	const match =
		xml.match(/<SegmentTemplate\b([^>]*)\/>/i) ??
		xml.match(/<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/i);
	if (!match) return null;
	return parseAttributeLine(match[1] || "") as unknown as DashSegmentTemplate;
}

function parseSegmentList(
	xml: string,
	baseUrl: string,
): { initialization?: string; segmentUrls: string[] } {
	const segmentListBlock = xml.match(/<SegmentList\b[^>]*>([\s\S]*?)<\/SegmentList>/i)?.[1] ?? "";
	if (!segmentListBlock) return { segmentUrls: [] };
	const initialization = segmentListBlock.match(/<Initialization\b([^>]*)\/>/i)?.[1];
	const initAttr = initialization ? parseAttributeLine(initialization) : undefined;
	const urls: string[] = [];

	for (const segMatch of segmentListBlock.matchAll(/<SegmentURL\b([^>]*)\/>/gi)) {
		const attrs = parseAttributeLine(segMatch[1] ?? "");
		if (attrs.media) urls.push(attrs.media);
	}
	return {
		initialization: initAttr?.media,
		segmentUrls: urls,
	};
}

function detectStreamKind(adaptationAttrs: Record<string, string>): StreamKind {
	const contentType = adaptationAttrs.contentType;
	if (contentType === "audio") return "audio";
	if (contentType === "video") return "video";
	if ((adaptationAttrs.mimeType || "").startsWith("audio/")) return "audio";
	if ((adaptationAttrs.mimeType || "").startsWith("video/")) return "video";
	return "video";
}

function detectTrackKind(fromAdaptation: StreamKind, mimeType?: string): StreamKind {
	if (mimeType?.startsWith("audio/")) return "audio";
	if (mimeType?.startsWith("video/")) return "video";
	return fromAdaptation;
}

function resolveDashBaseURL(xml: string, baseFallback: string): URL {
	const baseUrl = xml.match(/<BaseURL>(.*?)<\/BaseURL>/i)?.[1];
	return baseUrl ? new URL(baseUrl, baseFallback) : new URL(baseFallback);
}

export function renderTemplateUrl(
	template: string,
	vars: { Number: number; RepresentationID: string },
): string {
	return template
		.replace(/\$Number\$/g, String(vars.Number))
		.replace(/\$RepresentationID\$/g, vars.RepresentationID)
		.replace(/\$\$/g, "$");
}

export function parseDashManifest(
	xml: string,
	playlistUrl: URL,
	streamName: string,
): DashTrackDescriptor[] {
	const descriptors: DashTrackDescriptor[] = [];
	const manifestBase = resolveDashBaseURL(xml, playlistUrl.toString());
	let videoTrackIndex = 0;
	let audioTrackIndex = 0;

	const adaptationSetRegex = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
	const representationRegex = /<Representation\b([^>]*)(?:>([\s\S]*?)<\/Representation>|\/>)/gi;

	for (const adaptationMatch of xml.matchAll(adaptationSetRegex)) {
		const adaptationAttr = parseAttributeLine(adaptationMatch[1] ?? "");
		const adaptationBody = adaptationMatch[2] ?? "";
		const adaptationBase = resolveDashBaseURL(adaptationBody, manifestBase.toString());
		const adaptationTemplate = parseSegmentTemplate(adaptationBody);
		const adaptationList = parseSegmentList(adaptationBody, adaptationBase.toString());
		const adaptationKind = detectStreamKind(adaptationAttr);

		let representationIndex = 0;
		for (const representationMatch of adaptationBody.matchAll(representationRegex)) {
			const representationAttr = parseAttributeLine(representationMatch[1] ?? "");
			const representationBody = representationMatch[2] ?? "";
			const representationBase = resolveDashBaseURL(
				representationBody,
				adaptationBase.toString(),
			);
			const repTemplate = parseSegmentTemplate(representationBody);
			const repList = parseSegmentList(representationBody, representationBase.toString());
			const mimeType = representationAttr.mimeType || adaptationAttr.mimeType;
			const kind = detectTrackKind(adaptationKind, mimeType);
			const representationId = representationAttr.id || String(representationIndex);
			const trackIndex = kind === "video" ? videoTrackIndex++ : audioTrackIndex++;

			const template = repTemplate ?? adaptationTemplate;
			const segmentList =
				repList.segmentUrls.length > 0 ? repList.segmentUrls : adaptationList.segmentUrls;
			const initFromList = repList.initialization ?? adaptationList.initialization;

			const trackName = `${kind}/${trackIndex}`;
			const id = `${streamName}::${kind}::${representationId}::${trackIndex}`;

			if (template?.media) {
				const media = template.media;
				descriptors.push({
					id,
					kind,
					trackName,
					representationId,
					manifestUrl: playlistUrl.toString(),
					manifestBase: manifestBase.toString(),
					mode: "template",
					template: {
						media,
						initialization: template.initialization,
						startNumber: Number(template.startNumber || "1"),
						endNumber: template.endNumber ? Number(template.endNumber) : undefined,
					},
					segmentUrls: [],
				});
				representationIndex += 1;
				continue;
			}

			if (segmentList.length === 0 && !initFromList) continue;
			const resolvedSegments = segmentList.map((segmentUrl) =>
				new URL(segmentUrl, representationBase).toString(),
			);
			const initUrl = initFromList
				? new URL(initFromList, representationBase).toString()
				: undefined;
			const fullSegments = initUrl ? [initUrl, ...resolvedSegments] : resolvedSegments;
			descriptors.push({
				id,
				kind,
				trackName,
				representationId,
				manifestUrl: playlistUrl.toString(),
				manifestBase: manifestBase.toString(),
				mode: "list",
				template: {
					media: "",
					startNumber: 1,
				},
				segmentUrls: fullSegments,
			});
			representationIndex += 1;
		}
	}

	return descriptors;
}

export async function buildDashRunnerConfigs(context: RunnerContext): Promise<RunnerConfig[]> {
	const fetchOpts = { headers: context.stream.headers };
	const raw = await fetchText(context.stream.url, fetchOpts);
	const descriptors = parseDashManifest(raw, new URL(context.stream.url), context.stream.name);
	const configs: RunnerConfig[] = [];

	for (const desc of descriptors) {
		const state = {
			seen: createBoundedSeen(seenUrlLimit),
			initEmitted: false,
			nextNumber: desc.template.startNumber,
		};

		const pollMs = 1000;
		if (desc.mode === "template") {
			configs.push({
				streamName: context.stream.name,
				name: desc.trackName,
				kind: desc.kind,
				cenc: context.cenc,
				pollMs,
				...(desc.kind === "video" && {
					codec: AVC_CODEC_STRING,
					codecDescription: getDefaultAvcCDescription(),
				}),
				nextSegments: async () => {
					const chunks: Uint8Array[] = [];
					const currentText = await fetchText(desc.manifestUrl, fetchOpts);
					const latest = parseDashManifest(
						currentText,
						new URL(desc.manifestUrl),
						context.stream.name,
					);
					const activeDesc = latest.find((candidate) => candidate.id === desc.id);
					const activeTemplate = activeDesc?.template ?? desc.template;
					const activeRepId = activeDesc?.representationId ?? desc.representationId;
					const activeBase = activeDesc?.manifestBase ?? desc.manifestBase;
					const activeEndNumber = activeTemplate.endNumber;

					if (activeTemplate.startNumber > state.nextNumber) {
						state.nextNumber = activeTemplate.startNumber;
					}

					if (!state.initEmitted && activeTemplate.initialization) {
						const initUrl = renderTemplateUrl(activeTemplate.initialization, {
							RepresentationID: activeRepId,
							Number: state.nextNumber,
						});
						const initResolved = new URL(initUrl, activeBase).toString();
						if (!state.seen.has(initResolved)) {
							try {
								const bytes = await fetchBytes(initResolved, fetchOpts);
								chunks.push(
									context.cenc && desc.kind === "audio"
										? await decryptIfNeeded(bytes, context.cenc)
										: bytes,
								);
								state.seen.add(initResolved);
							} catch {
								// Skip init fetch failures
							}
						}
						state.initEmitted = true;
					}

					let segmentUrl = "";
					let attempts = 0;
					do {
						segmentUrl = renderTemplateUrl(activeTemplate.media, {
							RepresentationID: activeRepId,
							Number: state.nextNumber,
						});
						segmentUrl = new URL(segmentUrl, activeBase).toString();
						state.nextNumber += 1;
						attempts += 1;
						if (!state.seen.has(segmentUrl)) {
							try {
								const bytes = await fetchBytes(segmentUrl, fetchOpts);
								chunks.push(
									context.cenc && desc.kind === "audio"
										? await decryptIfNeeded(bytes, context.cenc)
										: bytes,
								);
								state.seen.add(segmentUrl);
								break;
							} catch {
								// Try a few future numbers
							}
						}
					} while (attempts < 12);

					if (activeEndNumber !== undefined && state.nextNumber > activeEndNumber + 1) {
						await sleep(Number.MAX_SAFE_INTEGER);
					}

					return chunks;
				},
			});
			continue;
		}

		configs.push({
			streamName: context.stream.name,
			name: desc.trackName,
			kind: desc.kind,
			cenc: context.cenc,
			pollMs,
			...(desc.kind === "video" && {
				codec: AVC_CODEC_STRING,
				codecDescription: getDefaultAvcCDescription(),
			}),
			nextSegments: async () => {
				const currentText = await fetchText(desc.manifestUrl, fetchOpts);
				const latest = parseDashManifest(
					currentText,
					new URL(context.stream.url),
					context.stream.name,
				);
				const matching = latest.find((d) => d.id === desc.id);
				const candidate = matching?.segmentUrls ?? desc.segmentUrls;
				const chunkPayloads: Uint8Array[] = [];
				let added = 0;

				for (const candidateUrl of candidate) {
					if (added >= maxSegmentsPerPoll) break;
					if (state.seen.has(candidateUrl)) continue;
					state.seen.add(candidateUrl);
					try {
						const bytes = await fetchBytes(candidateUrl, fetchOpts);
						chunkPayloads.push(
							context.cenc && desc.kind === "audio"
								? await decryptIfNeeded(bytes, context.cenc)
								: bytes,
						);
						added += 1;
					} catch {
						// Ignore per-segment failures
					}
				}

				return chunkPayloads;
			},
		});
	}

	return configs;
}
