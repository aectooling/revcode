export type ImageAttachment = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
export type StoredImage = { type: "image"; mimeType?: string; artifact?: string; unavailable?: string };
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function parseImages(value: unknown): ImageAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images`);
	return value.map((image) => {
		if ((!image || typeof image !== "object" || Array.isArray(image)) || image.type !== "image" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(image.mimeType))) throw new Error("Use PNG, JPEG, WebP, or GIF images");
		if (typeof image.data !== "string" || !image.data.length || image.data.length > MAX_IMAGE_BASE64 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Image must be valid base64 and at most 5 MB");
		const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
		if (image.data.length * 3 / 4 - padding > MAX_IMAGE_BYTES) throw new Error("Image must be at most 5 MB");
		return { type: "image", data: image.data, mimeType: image.mimeType as ImageAttachment["mimeType"] };
	});
}
