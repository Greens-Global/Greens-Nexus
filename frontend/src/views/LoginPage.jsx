import { useEffect, useRef, useState } from "react";
import { useMsal } from "@azure/msal-react";
import { loginRequest } from "../authConfig";
import GlobeLogo from "../components/GlobeLogo";

// ─── Background neural network ────────────────────────────────────────────────
function NeuralCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let animId;
    let W, H;
    let particles = [];
    const mouse       = { x: -9999, y: -9999 };
    const MAX_DIST    = 150;
    const MOUSE_R     = 200;
    const COUNT       = 140;

    function initSize() {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }

    function initParticles() {
      particles = Array.from({ length: COUNT }, () => ({
        x:  Math.random() * W,
        y:  Math.random() * H,
        vx: (Math.random() - 0.5) * 1.1,
        vy: (Math.random() - 0.5) * 1.1,
        r:  Math.random() * 2 + 1.5,
      }));
    }

    function isDark() {
      return document.documentElement.getAttribute("data-theme") === "dark";
    }

    function frame() {
      ctx.clearRect(0, 0, W, H);
      const dark = isDark();
      const [r, g, b] = dark ? [96, 165, 250] : [15, 23, 42];
      const nodeBase  = dark ? "rgba(96,165,250," : "rgba(15,23,42,";

      for (const p of particles) {
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < MOUSE_R * MOUSE_R && d2 > 0.1) {
          const d = Math.sqrt(d2);
          const f = ((MOUSE_R - d) / MOUSE_R) * 0.9;
          p.vx += (dx / d) * f;
          p.vy += (dy / d) * f;
        }
        p.vx *= 0.992; p.vy *= 0.992;
        p.x  += p.vx;  p.y  += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      }

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], c = particles[j];
          const dx = a.x - c.x, dy = a.y - c.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= MAX_DIST) continue;
          const alpha = (1 - dist / MAX_DIST) * (dark ? 0.5 : 0.35);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(c.x, c.y);
          ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
          ctx.lineWidth   = 0.8;
          ctx.stroke();
        }
      }

      for (const p of particles) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const near = dx * dx + dy * dy < MOUSE_R * MOUSE_R;
        if (dark && near) { ctx.shadowBlur = 10; ctx.shadowColor = "rgba(96,165,250,0.5)"; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, near ? p.r * 1.5 : p.r, 0, Math.PI * 2);
        ctx.fillStyle = near
          ? nodeBase + (dark ? "1.0)"  : "0.9)")
          : nodeBase + (dark ? "0.50)" : "0.50)");
        ctx.fill();
        if (dark) ctx.shadowBlur = 0;
      }

      animId = requestAnimationFrame(frame);
    }

    const onMM = e => { mouse.x = e.clientX; mouse.y = e.clientY; };
    const onML = () => { mouse.x = -9999; mouse.y = -9999; };
    const onRz = () => { initSize(); for (const p of particles) { p.x = Math.min(p.x,W); p.y = Math.min(p.y,H); } };

    initSize(); initParticles(); frame();
    window.addEventListener("mousemove",  onMM);
    window.addEventListener("mouseleave", onML);
    window.addEventListener("resize",     onRz);
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("mousemove",  onMM);
      window.removeEventListener("mouseleave", onML);
      window.removeEventListener("resize",     onRz);
    };
  }, []);

  return (
    <canvas ref={canvasRef} style={{ position:"fixed", inset:0, width:"100%", height:"100%", pointerEvents:"none", zIndex:0 }} />
  );
}

// ─── Looping typewriter ───────────────────────────────────────────────────────
function TypewriterTitle() {
  const WORD        = "Nexus";
  const TYPE_MS     = 110;
  const ERASE_MS    = 65;
  const PAUSE_FULL  = 1800;
  const PAUSE_EMPTY = 500;

  const [text,   setText]   = useState("");
  const [cursor, setCursor] = useState(true);

  useEffect(() => {
    let t;
    function tick(cur, erasing) {
      if (!erasing) {
        if (cur.length < WORD.length) {
          const next = WORD.slice(0, cur.length + 1);
          setText(next);
          t = setTimeout(() => tick(next, false), TYPE_MS);
        } else {
          t = setTimeout(() => tick(cur, true), PAUSE_FULL);
        }
      } else {
        if (cur.length > 0) {
          const next = cur.slice(0, -1);
          setText(next);
          t = setTimeout(() => tick(next, true), ERASE_MS);
        } else {
          t = setTimeout(() => tick("", false), PAUSE_EMPTY);
        }
      }
    }
    tick("", false);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setCursor(c => !c), 530);
    return () => clearInterval(id);
  }, []);

  return (
    <h1 className="login-title">
      {text}
      <span style={{ opacity: cursor ? 1 : 0, transition: "opacity 0.1s", fontWeight: 200, marginLeft: "1px" }}>|</span>
    </h1>
  );
}

// ─── Login page ───────────────────────────────────────────────────────────────
export default function LoginPage() {
  const { instance } = useMsal();

  return (
    <div className="login-page">
      <NeuralCanvas />
      <div className="login-card" style={{ position: "relative", zIndex: 1 }}>
        <GlobeLogo size={220} borderRadius="50%" interactive={true} nodeCount={130} />
        <TypewriterTitle />
        <p className="login-subtitle">Sign in with your Greens Global account</p>
        <button className="login-btn" onClick={() => instance.loginRedirect(loginRequest)}>
          <svg width="20" height="20" viewBox="0 0 21 21" fill="none">
            <rect width="10" height="10"             fill="#F35325" />
            <rect x="11" width="10" height="10"      fill="#81BC06" />
            <rect y="11" width="10" height="10"      fill="#05A6F0" />
            <rect x="11" y="11" width="10" height="10" fill="#FFBA08" />
          </svg>
          Sign in with Microsoft
        </button>
      </div>
    </div>
  );
}
