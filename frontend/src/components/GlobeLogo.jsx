import { useEffect, useRef } from "react";

// ─── Fibonacci sphere distribution ───────────────────────────────────────────
function fibSphere(n) {
  const pts   = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y     = 1 - (i / (n - 1)) * 2;
    const r     = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push([r * Math.cos(theta), y, r * Math.sin(theta)]);
  }
  return pts;
}

function rotY(p, a) {
  const [x, y, z] = p, c = Math.cos(a), s = Math.sin(a);
  return [x * c + z * s, y, -x * s + z * c];
}
function rotX(p, a) {
  const [x, y, z] = p, c = Math.cos(a), s = Math.sin(a);
  return [x, y * c - z * s, y * s + z * c];
}

/**
 * size        — canvas px (default 220, use 38 for sidebar)
 * borderRadius — CSS value (default "50%", use "10px" for sidebar)
 * interactive  — whether mouse tilt is applied (default true)
 * nodeCount    — sphere point count (default 130, use 60 for mini)
 */
export default function GlobeLogo({
  size         = 220,
  borderRadius = "50%",
  interactive  = true,
  nodeCount    = 130,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx  = canvas.getContext("2d");
    const cx   = size / 2;
    const cy   = size / 2;
    const R    = size * 0.408; // ~41% of size = globe radius

    const N    = nodeCount;
    const BASE = fibSphere(N);
    const THRESH = 0.74;
    const CONNS  = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const [ax, ay, az] = BASE[i];
        const [bx, by, bz] = BASE[j];
        if (ax * bx + ay * by + az * bz > THRESH) CONNS.push([i, j]);
      }
    }

    let animId;
    let spin     = 0;
    let tiltX    = 0.28;
    let tiltYExtra = 0;
    let targetTY = 0;
    let targetTX = 0.28;

    const onMouseMove = (e) => {
      if (!interactive) return;
      const rect = canvas.getBoundingClientRect();
      const nx   = (e.clientX - (rect.left + cx)) / window.innerWidth;
      const ny   = (e.clientY - (rect.top  + cy)) / window.innerHeight;
      targetTY   = nx * 1.5;
      targetTX   = 0.28 + ny * 0.7;
    };

    function frame() {
      spin       += 0.006;
      tiltYExtra += (targetTY - tiltYExtra) * 0.035;
      tiltX      += (targetTX - tiltX)      * 0.035;

      const ay = spin + tiltYExtra;
      const ax = tiltX;

      ctx.clearRect(0, 0, size, size);

      // Dark circular background
      const bgGrad = ctx.createRadialGradient(cx - R * 0.13, cy - R * 0.13, 0, cx, cy, R + 3);
      bgGrad.addColorStop(0,   "rgba(22,34,58,0.97)");
      bgGrad.addColorStop(0.6, "rgba(10,16,32,0.99)");
      bgGrad.addColorStop(1,   "rgba(4, 8, 18, 1)");
      ctx.beginPath();
      ctx.arc(cx, cy, R + 2, 0, Math.PI * 2);
      ctx.fillStyle = bgGrad;
      ctx.fill();

      // Edge glow ring
      const glowGrad = ctx.createRadialGradient(cx, cy, R * 0.75, cx, cy, R + 2);
      glowGrad.addColorStop(0, "rgba(96,165,250,0)");
      glowGrad.addColorStop(1, "rgba(96,165,250,0.14)");
      ctx.beginPath();
      ctx.arc(cx, cy, R + 2, 0, Math.PI * 2);
      ctx.fillStyle = glowGrad;
      ctx.fill();

      // Rotate points
      const pts3 = BASE.map(p => rotX(rotY(p, ay), ax));

      // Perspective project
      const FOV  = 4.8;
      const pts2 = pts3.map(([x, y, z]) => {
        const s = FOV / (FOV + z);
        return [cx + x * R * s, cy + y * R * s, z];
      });

      // Connections
      for (const [i, j] of CONNS) {
        const [x1, y1, z1] = pts2[i];
        const [x2, y2, z2] = pts2[j];
        const depth = ((z1 + z2) * 0.5 + 1) * 0.5;
        const alpha = 0.06 + depth * 0.38;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(160,200,255,${alpha.toFixed(3)})`;
        ctx.lineWidth   = size > 80 ? 0.65 : 0.5;
        ctx.stroke();
      }

      // Nodes back → front
      const order = pts2.map((_, i) => i).sort((a, b) => pts2[a][2] - pts2[b][2]);
      for (const i of order) {
        const [x, y, z] = pts2[i];
        const depth = (z + 1) * 0.5;
        const nr    = (size > 80 ? 0.7 : 0.35) + depth * (size > 80 ? 2.0 : 0.9);
        const alpha = 0.15 + depth * 0.85;

        if (z > 0.4) {
          ctx.shadowBlur  = size > 80 ? 6 : 2;
          ctx.shadowColor = `rgba(147,197,253,${(depth * 0.6).toFixed(2)})`;
        }
        ctx.beginPath();
        ctx.arc(x, y, nr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(210,228,255,${alpha.toFixed(3)})`;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      animId = requestAnimationFrame(frame);
    }

    if (interactive) window.addEventListener("mousemove", onMouseMove);
    frame();

    return () => {
      cancelAnimationFrame(animId);
      if (interactive) window.removeEventListener("mousemove", onMouseMove);
    };
  }, [size, interactive, nodeCount]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{
        display:      "block",
        borderRadius,
        flexShrink:   0,
        boxShadow:    size > 80
          ? "0 0 48px rgba(96,165,250,0.22), 0 0 96px rgba(96,165,250,0.08)"
          : "0 0 8px rgba(96,165,250,0.35)",
      }}
    />
  );
}
