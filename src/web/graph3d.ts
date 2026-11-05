import { createElement as h, useEffect, useRef } from "react";
import type { Memory, Link } from "./api";
const NS = "http://www.w3.org/2000/svg";
export function Graph3D({
  nodes,
  edges,
  onSelect,
  colors,
}: {
  nodes: Memory[];
  edges: Link[];
  onSelect: (m: Memory) => void;
  colors: Record<string, string>;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.replaceChildren();
    let frame = 0,
      raf = 0,
      yaw = 0.4,
      pitch = 0.2,
      zoom = 1,
      drag = false,
      moved = false,
      lastX = 0,
      lastY = 0,
      hover = "",
      selected = "",
      paused = false;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const create = (tag: string) => document.createElementNS(NS, tag);
    const points = nodes.map((n, i) => {
      const y = 1 - (2 * (i + 0.5)) / Math.max(nodes.length, 1),
        r = Math.sqrt(1 - y * y),
        a = i * 2.399963;
      return {
        n,
        x: 210 * r * Math.cos(a),
        y: 210 * y,
        z: 210 * r * Math.sin(a),
      };
    });
    const lines = edges.map((e) => {
      const el = create("line");
      el.setAttribute("stroke", "#96b9ad");
      svg.append(el);
      return { e, el };
    });
    const groups = points.map((p) => {
      const el = create("g"),
        circle = create("circle"),
        label = create("text"),
        title = create("title");
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", p.n.title || p.n.content);
      circle.setAttribute("fill", colors[p.n.type] || "#378e80");
      circle.setAttribute("stroke", "white");
      label.textContent = (p.n.title || p.n.content).slice(0, 12);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("fill", "#3c5b4b");
      title.textContent = p.n.content;
      el.append(circle, label, title);
      svg.append(el);
      el.addEventListener("pointerenter", () => (hover = p.n.id));
      el.addEventListener("pointerleave", () => (hover = ""));
      el.addEventListener("click", () => {
        if (!moved) {
          selected = p.n.id;
          select.current(p.n);
        }
      });
      el.addEventListener("keydown", (ev) => {
        const e = ev as KeyboardEvent;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selected = p.n.id;
          select.current(p.n);
        }
      });
      return { p, el, circle, label };
    });
    const draw = () => {
      frame++;
      svg.dataset.frame = String(frame);
      if (!drag && !paused && !reduced.matches) yaw += 0.0018;
      const positions = new Map<
        string,
        { x: number; y: number; z: number; s: number }
      >();
      for (const p of points) {
        const x = p.x * Math.cos(yaw) + p.z * Math.sin(yaw),
          z = -p.x * Math.sin(yaw) + p.z * Math.cos(yaw),
          y = p.y * Math.cos(pitch) - z * Math.sin(pitch),
          depth = p.y * Math.sin(pitch) + z * Math.cos(pitch),
          s = (620 / (620 + depth)) * zoom;
        positions.set(p.n.id, { x: 420 + x * s, y: 270 + y * s, z: depth, s });
      }
      for (const { e, el } of lines) {
        const a = positions.get(e.source_id),
          b = positions.get(e.target_id);
        if (!a || !b) {
          el.setAttribute("display", "none");
          continue;
        }
        el.setAttribute("x1", String(a.x));
        el.setAttribute("y1", String(a.y));
        el.setAttribute("x2", String(b.x));
        el.setAttribute("y2", String(b.y));
        el.setAttribute("stroke-width", String(1 + e.strength * 2));
        el.setAttribute(
          "opacity",
          hover
            ? e.source_id === hover || e.target_id === hover
              ? "1"
              : ".12"
            : ".4",
        );
      }
      for (const { p, el, circle, label } of [...groups].sort(
        (a, b) => positions.get(b.p.n.id)!.z - positions.get(a.p.n.id)!.z,
      )) {
        const v = positions.get(p.n.id)!;
        el.setAttribute("transform", "translate(" + v.x + " " + v.y + ")");
        circle.setAttribute(
          "r",
          String((7 + Math.max(0, Math.min(1, p.n.weight || 0)) * 11) * v.s),
        );
        circle.setAttribute(
          "stroke-width",
          p.n.id === hover || p.n.id === selected ? "4" : "2",
        );
        circle.setAttribute(
          "stroke",
          p.n.id === hover || p.n.id === selected ? "#173d30" : "white",
        );
        label.setAttribute("y", String(25 * v.s));
        label.setAttribute("font-size", String(11 * v.s));
        label.setAttribute(
          "visibility",
          nodes.length < 45 || hover === p.n.id ? "visible" : "hidden",
        );
        svg.append(el);
      }
      raf = requestAnimationFrame(draw);
    };
    const down = (e: PointerEvent) => {
      drag = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - lastX,
        dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      yaw += dx * 0.008;
      pitch += dy * 0.008;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const up = () => (drag = false);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom = Math.max(0.45, Math.min(2.3, zoom * Math.exp(-e.deltaY * 0.001)));
    };
    const key = (e: KeyboardEvent) => {
      if (e.target !== svg) return;
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        yaw += e.key === "ArrowLeft" ? -0.1 : e.key === "ArrowRight" ? 0.1 : 0;
        pitch += e.key === "ArrowUp" ? -0.1 : e.key === "ArrowDown" ? 0.1 : 0;
      }
      if (e.key === " ") {
        e.preventDefault();
        paused = !paused;
      }
      if (e.key === "+" || e.key === "=") zoom = Math.min(2.3, zoom + 0.1);
      if (e.key === "-") zoom = Math.max(0.45, zoom - 0.1);
    };
    svg.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    svg.addEventListener("wheel", wheel, { passive: false });
    svg.addEventListener("keydown", key);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      svg.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      svg.removeEventListener("wheel", wheel);
      svg.removeEventListener("keydown", key);
      svg.replaceChildren();
    };
  }, [nodes, edges, colors]);
  return h("svg", {
    ref,
    className: "star-map star-map-3d",
    viewBox: "0 0 840 540",
    tabIndex: 0,
    "data-frame": 0,
    "aria-label":
      "3D记忆星图：拖拽旋转，滚轮缩放，方向键旋转，空格暂停自动旋转，点击节点查看",
  });
}
