import { useEffect, useRef, type CSSProperties } from "react";
import type { DesktopDisplayEffect } from "../../shared/desktop-display";

export type DesktopDisplayOverlayRequest = {
  token: number;
  effect: DesktopDisplayEffect;
  durationMs: number;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  phase: number;
};

const FIREWORK_COLORS = ["#ff5d73", "#ffd166", "#52d9ff", "#a78bfa", "#7cff8a"];
const NATIONAL_COLORS = ["#ffdc73", "#ffd24a", "#ffefb0", "#e33a2f"];

function random(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function drawStar(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  context.beginPath();
  for (let point = 0; point < 10; point += 1) {
    const angle = -Math.PI / 2 + point * Math.PI / 5;
    const length = point % 2 === 0 ? radius : radius * 0.42;
    const nextX = x + Math.cos(angle) * length;
    const nextY = y + Math.sin(angle) * length;
    if (point === 0) context.moveTo(nextX, nextY);
    else context.lineTo(nextX, nextY);
  }
  context.closePath();
  context.fill();
}

function createSnow(width: number, height: number): Particle {
  return {
    x: random(0, width), y: random(-height * 0.25, 0), vx: random(-0.2, 0.35), vy: random(0.45, 1.35),
    life: Number.POSITIVE_INFINITY, maxLife: 1, size: random(1.5, 4.5), color: "#ffffff", phase: random(0, Math.PI * 2),
  };
}

function createNationalParticle(width: number, height: number): Particle {
  return {
    x: random(0, width), y: random(-height * 0.2, 0), vx: random(-0.28, 0.28), vy: random(0.35, 0.9),
    life: Number.POSITIVE_INFINITY, maxLife: 1, size: random(4, 9), color: NATIONAL_COLORS[Math.floor(random(0, NATIONAL_COLORS.length))], phase: random(0, Math.PI * 2),
  };
}

export function DesktopDisplayOverlay({
  request,
  greeting,
  onComplete,
}: {
  request: DesktopDisplayOverlayRequest;
  greeting: string;
  onComplete(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let animationFrame = 0;
    let previousTime = performance.now();
    let lastBurst = -1_000;
    const particles: Particle[] = [];

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const addBurst = () => {
      const centerX = random(width * 0.15, width * 0.85);
      const centerY = random(height * 0.12, height * 0.58);
      const color = FIREWORK_COLORS[Math.floor(random(0, FIREWORK_COLORS.length))];
      for (let index = 0; index < 54; index += 1) {
        const angle = random(0, Math.PI * 2);
        const speed = random(0.8, 3.8);
        particles.push({
          x: centerX, y: centerY, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          life: random(700, 1_450), maxLife: 1_450, size: random(1.4, 3.2), color, phase: 0,
        });
      }
    };

    resize();
    if (!reducedMotion) {
      if (request.effect === "snowfall") {
        for (let index = 0; index < 90; index += 1) {
          const particle = createSnow(width, height);
          particle.y = random(0, height);
          particles.push(particle);
        }
      } else if (request.effect === "nationalDay") {
        for (let index = 0; index < 46; index += 1) {
          const particle = createNationalParticle(width, height);
          particle.y = random(0, height);
          particles.push(particle);
        }
      }
    }

    const render = (now: number) => {
      const delta = Math.min(32, now - previousTime);
      previousTime = now;
      context.clearRect(0, 0, width, height);
      if (request.effect === "fireworks" && now - lastBurst > 650) {
        addBurst();
        lastBurst = now;
      }
      if (request.effect === "nationalDay") {
        for (let ribbon = 0; ribbon < 4; ribbon += 1) {
          context.strokeStyle = ribbon % 2 === 0 ? "rgba(208, 25, 31, 0.72)" : "rgba(255, 210, 74, 0.64)";
          context.lineWidth = 8 + ribbon * 2;
          context.beginPath();
          context.moveTo(-20, height * (0.18 + ribbon * 0.2));
          context.bezierCurveTo(width * 0.32, height * (0.05 + ribbon * 0.2), width * 0.68, height * (0.35 + ribbon * 0.12), width + 20, height * (0.18 + ribbon * 0.2));
          context.stroke();
        }
      }
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        if (request.effect === "fireworks") {
          particle.life -= delta;
          particle.vy += 0.0024 * delta;
          particle.x += particle.vx * delta * 0.06;
          particle.y += particle.vy * delta * 0.06;
          if (particle.life <= 0) {
            particles.splice(index, 1);
            continue;
          }
          context.globalAlpha = Math.max(0, particle.life / particle.maxLife);
          context.fillStyle = particle.color;
          context.beginPath();
          context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          context.fill();
        } else {
          particle.phase += delta * 0.0014;
          particle.x += (particle.vx + Math.sin(particle.phase) * 0.3) * delta * 0.06;
          particle.y += particle.vy * delta * 0.06;
          if (particle.y > height + 15) {
            const replacement = request.effect === "snowfall" ? createSnow(width, height) : createNationalParticle(width, height);
            Object.assign(particle, replacement);
          }
          context.globalAlpha = request.effect === "snowfall" ? 0.9 : 0.94;
          context.fillStyle = particle.color;
          if (request.effect === "snowfall") {
            context.beginPath();
            context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
            context.fill();
          } else {
            drawStar(context, particle.x, particle.y, particle.size);
          }
        }
      }
      context.globalAlpha = 1;
      animationFrame = window.requestAnimationFrame(render);
    };

    window.addEventListener("resize", resize);
    if (!reducedMotion) animationFrame = window.requestAnimationFrame(render);
    const timer = window.setTimeout(() => onCompleteRef.current(), request.durationMs);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      context.clearRect(0, 0, width, height);
    };
  }, [request.durationMs, request.effect, request.token]);

  return (
    <div
      className={`desktop-display-overlay is-${request.effect}`}
      style={{ "--desktop-display-duration": `${request.durationMs}ms` } as CSSProperties}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
      {request.effect === "nationalDay" ? <div className="desktop-display-national-greeting">{greeting}</div> : null}
      <div className="desktop-display-static-decoration" />
    </div>
  );
}
