import { createPortal } from "react-dom";

export interface LightboxImage {
  name: string;
  mimeType: string;
  dataBase64: string;
}

/**
 * Full-screen preview for an inline (base64) image, shared by the composer's
 * attachment chips and the user bubble's image chips.
 *
 * Portaled to <body> so the chat area's zoom transform doesn't scale a
 * viewport-sized overlay past the actual viewport.
 */
export default function ImageLightbox({ image, onClose }: { image: LightboxImage; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div className="flex max-h-full max-w-full flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <img
          src={`data:${image.mimeType};base64,${image.dataBase64}`}
          alt={image.name}
          className="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
        />
        <div className="flex items-center gap-3 text-xs text-white/80">
          <span>{image.name}</span>
          <button onClick={onClose} className="rounded border border-white/30 px-2 py-0.5 hover:bg-white/10">
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
