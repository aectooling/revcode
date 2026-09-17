const randomId = () => crypto.randomUUID();
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { MAX_IMAGE_BYTES, parseImages, type ImageAttachment } from "../../../src/host/images";

export type AnnotationScene = {
	elements: readonly ExcalidrawElement[];
	files: BinaryFiles;
	appState: Partial<AppState>;
};

export type DraftImage = {
	id: string;
	name: string;
	image: ImageAttachment;
	scene?: AnnotationScene;
} & ({ original: ImageAttachment; width: number; height: number } | { original?: never; scene: AnnotationScene });

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const imageUrl = (image: ImageAttachment) => `data:${image.mimeType};base64,${image.data}`;

export function readDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Could not read this image."));
		reader.readAsDataURL(blob);
	});
}

export async function blobAttachment(blob: Blob): Promise<ImageAttachment> {
	const url = await readDataUrl(blob);
	return parseImages([{ type: "image", mimeType: blob.type, data: url.slice(url.indexOf(",") + 1) }])![0];
}

export async function readImage(file: File): Promise<DraftImage> {
	if (!IMAGE_ACCEPT.split(",").includes(file.type)) throw new Error("Use PNG, JPEG, WebP, or GIF images.");
	if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Choose an image smaller than 5 MB.");
	const image = await blobAttachment(file);
	const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
		const element = new Image();
		element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
		element.onerror = () => reject(new Error("This image could not be opened. Try another file."));
		element.src = imageUrl(image);
	});
	return { id: randomId(), name: file.name || "Pasted image", ...dimensions, image, original: image };
}

// Native view exports may be up to 10 MiB. Fit captures to the chat budget
// without weakening the upload limit or asking the user to resize a Revit view.
export async function readCapturedImage(image: ImageAttachment): Promise<DraftImage> {
  const bytes = Uint8Array.from(atob(image.data), character => character.charCodeAt(0));
  const name = "Active Revit view.png";
  if (bytes.byteLength <= MAX_IMAGE_BYTES) return readImage(new File([bytes], name, { type: image.mimeType }));
  const source = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("The captured view could not be opened."));
    element.src = imageUrl(image);
  });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the captured view.");
  let maximum = Math.min(2048, Math.max(source.naturalWidth, source.naturalHeight));
  while (true) {
    const scale = maximum / Math.max(source.naturalWidth, source.naturalHeight);
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Could not resize the captured view.")), "image/png"));
    if (blob.size <= MAX_IMAGE_BYTES) return readImage(new File([blob], name, { type: "image/png" }));
    if (maximum <= 128) throw new Error("Could not fit the captured view within 5 MB.");
    maximum = Math.max(128, Math.floor(maximum * 0.75));
  }
}
