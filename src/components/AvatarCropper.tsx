import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/language";

export function AvatarCropper({
  file,
  onSave,
  onCancel,
}: {
  file: File;
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const polish = useLanguage() === "pl";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imgLoaded, setImgLoaded] = useState(false);
  const size = 512;
  const preview = 220;

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
      const scale = Math.max(preview / img.width, preview / img.height);
      setZoom(scale);
      setPos({ x: 0, y: 0 });
    };
    img.src = URL.createObjectURL(file);
    return () => URL.revokeObjectURL(img.src);
  }, [file]);

  const draw = () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, preview, preview);
    // background
    ctx.fillStyle = "#191919";
    ctx.fillRect(0, 0, preview, preview);
    // circular clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(preview / 2, preview / 2, preview / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    const w = img.width * zoom;
    const h = img.height * zoom;
    const x = preview / 2 - w / 2 + pos.x;
    const y = preview / 2 - h / 2 + pos.y;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    // border
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(preview / 2, preview / 2, preview / 2 - 0.5, 0, Math.PI * 2);
    ctx.stroke();
  };

  useEffect(() => {
    if (imgLoaded) draw();
  }, [imgLoaded, zoom, pos]);

  const handlePointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    setDragStart({ x: e.clientX - pos.x, y: e.clientY - pos.y });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    setPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };
  const handlePointerUp = () => setDragging(false);

  const handleSave = () => {
    const img = imgRef.current;
    if (!img) return;
    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    const scale = (zoom * size) / preview;
    const w = img.width * scale;
    const h = img.height * scale;
    const x = size / 2 - w / 2 + (pos.x * size) / preview;
    const y = size / 2 - h / 2 + (pos.y * size) / preview;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    const dataUrl = out.toDataURL("image/webp", 0.92);
    // fallback to jpeg if webp not supported (toDataURL defaults to png)
    const finalUrl = dataUrl.startsWith("data:image/webp") ? dataUrl : out.toDataURL("image/jpeg", 0.92);
    onSave(finalUrl);
  };

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div
        className="relative overflow-hidden rounded-full bg-inset touch-none select-none"
        style={{ width: preview, height: preview }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <canvas ref={canvasRef} width={preview} height={preview} className="block touch-none" style={{ width: preview, height: preview }} />
        {!imgLoaded && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-secondary">{polish ? "Wczytywanie..." : "Loading..."}</div>}
      </div>
      <div className="text-center text-[11px] text-ink-secondary max-w-[220px]">
        {polish ? "Przeciągnij by ustawić kadr, suwakiem powiększ" : "Drag to reposition, use slider to zoom"}
      </div>
      <div className="flex items-center gap-2 w-full max-w-[220px]">
        <span className="text-[11px] text-ink-secondary">−</span>
        <input
          type="range"
          min={0.1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="text-[11px] text-ink-secondary">+</span>
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="rounded-lg bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover">
          {polish ? "Anuluj" : "Cancel"}
        </button>
        <button onClick={handleSave} className="rounded-lg bg-accent px-5 py-2 text-[13px] font-medium text-white hover:opacity-90">
          {polish ? "Zapisz" : "Save"}
        </button>
      </div>
    </div>
  );
}
