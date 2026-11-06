import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  FogExp2,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  createElement as h,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Memory, Link } from "./api";
import "./graph3d.css";

interface Graph3DProps {
  nodes: Memory[];
  edges: Link[];
  colors: Record<string, string>;
  selectedId?: string | null;
  onSelect: (m: Memory) => void;
  autoRotate?: boolean;
  onFailure?: (message: string) => void;
}

interface GraphController {
  focus: (id: string) => void;
}

interface Curve {
  source: Vector3;
  control: Vector3;
  target: Vector3;
  strength: number;
}

const GOLD = new Color("#ffc66d");
const CYAN = new Color("#66e6d0");
const ORIGIN = new Vector3();
const UP = new Vector3(0, 1, 0);

function hash(value: string, salt = 0): number {
  let result = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  result += result << 13;
  result ^= result >>> 7;
  result += result << 3;
  result ^= result >>> 17;
  result += result << 5;
  return result >>> 0;
}

function unit(value: number): number {
  return value / 4294967295;
}

function nodePosition(memory: Memory): Vector3 {
  const y = unit(hash(memory.id, 17)) * 2 - 1;
  const angle = unit(hash(memory.id, 71)) * Math.PI * 2;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const radius = 120 + unit(hash(memory.id, 137)) * 80;
  return new Vector3(
    Math.cos(angle) * ring * radius,
    y * radius,
    Math.sin(angle) * ring * radius,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function curvePoint(curve: Curve, t: number, target: Vector3): Vector3 {
  const inverse = 1 - t;
  return target
    .copy(curve.source)
    .multiplyScalar(inverse * inverse)
    .addScaledVector(curve.control, 2 * inverse * t)
    .addScaledVector(curve.target, t * t);
}

function makeCurve(source: Vector3, target: Vector3, strength: number): Curve {
  const midpoint = source.clone().add(target).multiplyScalar(0.5);
  const lift = midpoint.lengthSq() > 0.01
    ? midpoint.clone().normalize()
    : source.clone().cross(UP).normalize();
  const control = midpoint.addScaledVector(
    lift,
    10 + source.distanceTo(target) * 0.16,
  );
  return { source, control, target, strength };
}

function labelTexture(memory: Memory, selected: boolean): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建星图标签。");
  const text = (memory.title || memory.content || "未命名记忆").trim();
  context.font = "500 30px system-ui, -apple-system, sans-serif";
  const measured = Math.min(460, context.measureText(text).width + 52);
  const left = (512 - measured) / 2;
  context.fillStyle = "rgba(3, 18, 25, 0.88)";
  context.strokeStyle = selected
    ? "rgba(255, 198, 109, 0.8)"
    : "rgba(102, 230, 208, 0.55)";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(left, 17, measured, 72, 18);
  context.fill();
  context.stroke();
  context.fillStyle = selected ? "#ffe0aa" : "#c8fff3";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const maxWidth = measured - 34;
  let shown = text;
  while (shown.length > 1 && context.measureText(shown).width > maxWidth) {
    shown = shown.slice(0, -1);
  }
  if (shown !== text) shown = shown.slice(0, -1) + "…";
  context.fillText(shown, 256, 54);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function setLabel(
  sprite: Sprite,
  memory: Memory | undefined,
  selected: boolean,
) {
  const material = sprite.material;
  const previous = material.map;
  if (!memory) {
    sprite.visible = false;
    if (previous) previous.dispose();
    material.map = null;
    return;
  }
  material.map = labelTexture(memory, selected);
  material.needsUpdate = true;
  if (previous) previous.dispose();
  sprite.visible = true;
}

function createStarField(count: number, seed: number): Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new Color();
  for (let i = 0; i < count; i++) {
    const y = unit(hash(String(i), seed)) * 2 - 1;
    const angle = unit(hash(String(i), seed + 1)) * Math.PI * 2;
    const radius = 360 + unit(hash(String(i), seed + 2)) * 480;
    const ring = Math.sqrt(1 - y * y);
    positions[i * 3] = Math.cos(angle) * ring * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = Math.sin(angle) * ring * radius;
    color
      .set(i % 11 === 0 ? "#ffd9a0" : "#a4e8e0")
      .multiplyScalar(0.4 + unit(hash(String(i), seed + 3)) * 0.6);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  const material = new PointsMaterial({
    size: 1.25,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.72,
    vertexColors: true,
    depthWrite: false,
  });
  return new Points(geometry, material);
}

export function Graph3D({
  nodes,
  edges,
  colors,
  selectedId = null,
  onSelect,
  autoRotate = true,
  onFailure,
}: Graph3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect);
  const controllerRef = useRef<GraphController | null>(null);
  const selectedRef = useRef(selectedId);
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;
  const reportFailure = (cause: unknown) => {
    failureRef.current?.(
      cause instanceof Error
        ? cause.message
        : "当前设备无法初始化 WebGL 记忆星图。",
    );
  };
  selectRef.current = onSelect;
  selectedRef.current = selectedId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch (cause) {
      reportFailure(cause);
      return;
    }

    const canvas = renderer.domElement;
    canvas.className = "graph3d-canvas";
    canvas.tabIndex = 0;
    canvas.dataset.frame = "0";
    canvas.setAttribute("role", "application");
    canvas.setAttribute(
      "aria-label",
      "三维记忆星图。拖拽旋转，滚轮缩放，方向键旋转，加减键缩放，空格暂停自动环绕，点击节点查看详情。",
    );
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor("#020b12", 1);
    renderer.outputColorSpace = SRGBColorSpace;
    host.prepend(canvas);

    const scene = new Scene();
    scene.background = new Color("#020b12");
    scene.fog = new FogExp2("#020b12", 0.00075);
    const camera = new PerspectiveCamera(48, 1, 0.1, 1800);
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const positions = new Map<string, Vector3>();
    const memories: Memory[] = [];
    const matrix = new Matrix4();
    const rotation = new Quaternion();
    const scale = new Vector3();

    const nodeGeometry = new SphereGeometry(1, 16, 12);
    const nodeMaterial = new MeshBasicMaterial({ color: "#ffffff" });
    const nodeMesh = new InstancedMesh(
      nodeGeometry,
      nodeMaterial,
      nodes.length,
    );
    nodeMesh.name = "memory-nodes";
    nodeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const glowMaterial = new MeshBasicMaterial({
      color: "#62e7d1",
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const glowMesh = new InstancedMesh(
      new SphereGeometry(1, 12, 8),
      glowMaterial,
      nodes.length,
    );

    nodes.forEach((memory, index) => {
      const position = nodePosition(memory);
      positions.set(memory.id, position);
      memories[index] = memory;
      const weight = clamp(Number(memory.weight) || 0, 0, 1);
      const size = 1.6 + weight * 2.0;
      scale.setScalar(size);
      matrix.compose(position, rotation, scale);
      nodeMesh.setMatrixAt(index, matrix);
      const color = new Color(colors[memory.type] || "#55d8c2");
      nodeMesh.setColorAt(index, color);
      scale.setScalar(size * 1.8);
      matrix.compose(position, rotation, scale);
      glowMesh.setMatrixAt(index, matrix);
    });
    nodeMesh.instanceMatrix.needsUpdate = true;
    glowMesh.instanceMatrix.needsUpdate = true;
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    nodeMesh.computeBoundingSphere();
    glowMesh.computeBoundingSphere();
    scene.add(glowMesh, nodeMesh);

    const curves: Curve[] = [];
    const lineVertices: number[] = [];
    const lineColors: number[] = [];
    const from = new Vector3();
    const to = new Vector3();
    for (const edge of edges) {
      const source = positions.get(edge.source_id);
      const target = positions.get(edge.target_id);
      if (!source || !target) continue;
      const strength = clamp(Number(edge.strength) || 0, 0, 1);
      const curve = makeCurve(source, target, strength);
      curves.push(curve);
      const color = CYAN.clone().lerp(GOLD, strength * 0.35);
      color.multiplyScalar(0.38 + strength * 0.62);
      for (let segment = 0; segment < 10; segment++) {
        curvePoint(curve, segment / 10, from);
        curvePoint(curve, (segment + 1) / 10, to);
        lineVertices.push(from.x, from.y, from.z, to.x, to.y, to.z);
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          lineColors.push(color.r, color.g, color.b);
        }
      }
    }
    const lineGeometry = new BufferGeometry();
    lineGeometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(lineVertices), 3),
    );
    lineGeometry.setAttribute(
      "color",
      new BufferAttribute(new Float32Array(lineColors), 3),
    );
    const lines = new LineSegments(
      lineGeometry,
      new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    scene.add(lines);

    const particlesPerEdge = 3;
    const particlePositions = new Float32Array(
      curves.length * particlesPerEdge * 3,
    );
    const particleColors = new Float32Array(
      curves.length * particlesPerEdge * 3,
    );
    curves.forEach((curve, index) => {
      for (let p = 0; p < particlesPerEdge; p++) {
        const color = GOLD.clone().multiplyScalar(0.7 + curve.strength * 0.5);
        const offset = (index * particlesPerEdge + p) * 3;
        particleColors[offset] = color.r;
        particleColors[offset + 1] = color.g;
        particleColors[offset + 2] = color.b;
      }
    });
    const particleGeometry = new BufferGeometry();
    const particleAttribute = new BufferAttribute(particlePositions, 3);
    particleAttribute.setUsage(DynamicDrawUsage);
    particleGeometry.setAttribute("position", particleAttribute);
    particleGeometry.setAttribute("color", new BufferAttribute(particleColors, 3));
    const particles = new Points(
      particleGeometry,
      new PointsMaterial({
        color: "#ffd18a",
        size: 3.2,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.92,
        vertexColors: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    particles.frustumCulled = false;
    scene.add(particles);

    const farStars = createStarField(900, 313);
    const nearStars = createStarField(240, 719);
    nearStars.scale.setScalar(0.58);
    scene.add(farStars, nearStars);

    const selectedRing = new Mesh(
      new TorusGeometry(1, 0.075, 8, 64),
      new MeshBasicMaterial({
        color: GOLD,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    const hoverRing = new Mesh(
      new TorusGeometry(1, 0.05, 8, 48),
      new MeshBasicMaterial({
        color: CYAN,
        transparent: true,
        opacity: 0.75,
        depthTest: false,
      }),
    );
    selectedRing.renderOrder = 5;
    hoverRing.renderOrder = 4;
    selectedRing.visible = false;
    hoverRing.visible = false;
    scene.add(selectedRing, hoverRing);

    const selectedLabel = new Sprite(
      new SpriteMaterial({ transparent: true, depthTest: false }),
    );
    const hoverLabel = new Sprite(
      new SpriteMaterial({ transparent: true, depthTest: false }),
    );
    selectedLabel.scale.set(62, 13.6, 1);
    hoverLabel.scale.set(56, 12.3, 1);
    selectedLabel.renderOrder = 7;
    hoverLabel.renderOrder = 6;
    selectedLabel.visible = false;
    hoverLabel.visible = false;
    scene.add(selectedLabel, hoverLabel);

    let width = 0;
    let height = 0;
    const resize = () => {
      width = Math.max(1, host.clientWidth);
      height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let hoveredId: string | null = null;
    let shownSelectedId: string | null | undefined;
    let shownHoverId: string | null | undefined;
    let yaw = 0.62;
    let pitch = 0.26;
    let distance = 450;
    const target = new Vector3();
    let dragging = false;
    let moved = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let lastInteraction = performance.now();
    let userPaused = false;
    let frame = 0;
    let raf = 0;
    let previousTime = performance.now();
    let elapsed = 0;
    let activeFocus: string | null = null;
    let flight: {
      started: number;
      fromTarget: Vector3;
      toTarget: Vector3;
      fromDistance: number;
      toDistance: number;
    } | null = null;
    const particle = new Vector3();

    const focus = (id: string) => {
      const position = positions.get(id);
      if (!position) return;
      if (activeFocus === id && flight) return;
      activeFocus = id;
      lastInteraction = performance.now();
      if (reducedMotion.matches) {
        flight = null;
        target.copy(position);
        distance = 175;
        return;
      }
      flight = {
        started: performance.now(),
        fromTarget: target.clone(),
        toTarget: position.clone(),
        fromDistance: distance,
        toDistance: clamp(distance * 0.62, 125, 185),
      };
    };
    controllerRef.current = { focus };

    const hitTest = (event: PointerEvent): Memory | undefined => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(nodeMesh, false)[0];
      return hit?.instanceId === undefined
        ? undefined
        : memories[hit.instanceId];
    };

    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging = true;
      moved = false;
      pointerId = event.pointerId;
      startX = lastX = event.clientX;
      startY = lastY = event.clientY;
      lastInteraction = performance.now();
      flight = null;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-dragging");
      canvas.focus({ preventScroll: true });
    };
    const pointerMove = (event: PointerEvent) => {
      if (dragging && event.pointerId === pointerId) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > 4) {
          moved = true;
        }
        yaw -= dx * 0.005;
        pitch = clamp(pitch + dy * 0.005, -1.42, 1.42);
        lastX = event.clientX;
        lastY = event.clientY;
        lastInteraction = performance.now();
        return;
      }
      const memory = hitTest(event);
      hoveredId = memory?.id || null;
      canvas.classList.toggle("has-hover", Boolean(memory));
    };
    const pointerUp = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      canvas.classList.remove("is-dragging");
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (!moved) {
        const memory = hitTest(event);
        if (memory) {
          activeFocus = null;
          focus(memory.id);
          selectRef.current(memory);
        }
      }
      pointerId = -1;
    };
    const pointerCancel = () => {
      dragging = false;
      pointerId = -1;
      canvas.classList.remove("is-dragging");
    };
    const pointerLeave = () => {
      if (!dragging) {
        hoveredId = null;
        canvas.classList.remove("has-hover");
      }
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      flight = null;
      distance = clamp(distance * Math.exp(event.deltaY * 0.001), 120, 900);
      lastInteraction = performance.now();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.target !== canvas) return;
      let handled = true;
      if (event.key === "ArrowLeft") yaw += 0.1;
      else if (event.key === "ArrowRight") yaw -= 0.1;
      else if (event.key === "ArrowUp") pitch = clamp(pitch - 0.1, -1.42, 1.42);
      else if (event.key === "ArrowDown") pitch = clamp(pitch + 0.1, -1.42, 1.42);
      else if (event.key === "+" || event.key === "=") distance = Math.max(120, distance - 18);
      else if (event.key === "-") distance = Math.min(900, distance + 18);
      else if (event.key === " ") userPaused = !userPaused;
      else handled = false;
      if (handled) {
        event.preventDefault();
        flight = null;
        lastInteraction = performance.now();
      }
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(raf);
      reportFailure(new Error("WebGL 上下文已丢失，请重试星图或使用文字列表。"));
    };
    const motionChanged = () => {
      particles.visible = !reducedMotion.matches;
      if (reducedMotion.matches && flight) {
        target.copy(flight.toTarget);
        distance = flight.toDistance;
        flight = null;
      }
    };
    let inViewport = true;
    const syncAnimation = () => {
      cancelAnimationFrame(raf);
      previousTime = performance.now();
      if (!document.hidden && inViewport) raf = requestAnimationFrame(draw);
    };
    const intersectionObserver = new IntersectionObserver((entries) => {
      inViewport = entries[0]?.isIntersecting ?? true;
      syncAnimation();
    });
    intersectionObserver.observe(host);

    function draw(now: number) {
      if (document.hidden || !inViewport) return;
      const delta = Math.min(50, Math.max(0, now - previousTime));
      previousTime = now;
      elapsed += delta;
      if (
        autoRotate &&
        !userPaused &&
        !dragging &&
        !flight &&
        !reducedMotion.matches &&
        now - lastInteraction > 2400
      ) {
        yaw += delta * 0.000055;
      }
      if (flight) {
        const progress = clamp((now - flight.started) / 900, 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
        distance = flight.fromDistance +
          (flight.toDistance - flight.fromDistance) * eased;
        if (progress >= 1) flight = null;
      }
      const horizontal = Math.cos(pitch) * distance;
      camera.position.set(
        target.x + Math.sin(yaw) * horizontal,
        target.y + Math.sin(pitch) * distance,
        target.z + Math.cos(yaw) * horizontal,
      );
      camera.lookAt(target);

      if (!reducedMotion.matches) {
        curves.forEach((curve, edgeIndex) => {
          for (let p = 0; p < particlesPerEdge; p++) {
            const phase = p / particlesPerEdge + edgeIndex * 0.173;
            const speed = 0.000075 + curve.strength * 0.000075;
            curvePoint(curve, (elapsed * speed + phase) % 1, particle);
            const offset = (edgeIndex * particlesPerEdge + p) * 3;
            particlePositions[offset] = particle.x;
            particlePositions[offset + 1] = particle.y;
            particlePositions[offset + 2] = particle.z;
          }
        });
        particleAttribute.needsUpdate = true;
        farStars.rotation.y += delta * 0.0000015;
      }

      const selected = selectedRef.current
        ? positions.get(selectedRef.current)
        : undefined;
      selectedRing.visible = Boolean(selected);
      if (selected) {
        selectedRing.position.copy(selected);
        selectedRing.quaternion.copy(camera.quaternion);
        selectedRing.scale.setScalar(10.5 + Math.sin(elapsed * 0.003) * 0.35);
      }
      const hovered = hoveredId ? positions.get(hoveredId) : undefined;
      hoverRing.visible = Boolean(hovered && hoveredId !== selectedRef.current);
      if (hovered) {
        hoverRing.position.copy(hovered);
        hoverRing.quaternion.copy(camera.quaternion);
        hoverRing.scale.setScalar(9.5);
      }
      if (shownSelectedId !== selectedRef.current) {
        const memory = nodes.find((item) => item.id === selectedRef.current);
        setLabel(selectedLabel, memory, true);
        shownSelectedId = selectedRef.current;
      }
      if (shownHoverId !== hoveredId) {
        const memory = hoveredId !== selectedRef.current
          ? nodes.find((item) => item.id === hoveredId)
          : undefined;
        setLabel(hoverLabel, memory, false);
        shownHoverId = hoveredId;
      }
      if (selected && selectedLabel.visible) {
        selectedLabel.position.copy(selected).addScaledVector(UP, 13);
      }
      if (hovered && hoverLabel.visible) {
        hoverLabel.position.copy(hovered).addScaledVector(UP, 12);
      }

      renderer.render(scene, camera);
      frame += 1;
      canvas.dataset.frame = String(frame);
      raf = requestAnimationFrame(draw);
    }

    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerCancel);
    canvas.addEventListener("pointerleave", pointerLeave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", keyDown);
    canvas.addEventListener("webglcontextlost", contextLost);
    document.addEventListener("visibilitychange", syncAnimation);
    reducedMotion.addEventListener("change", motionChanged);
    motionChanged();
    if (selectedRef.current) focus(selectedRef.current);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      controllerRef.current = null;
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerCancel);
      canvas.removeEventListener("pointerleave", pointerLeave);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", keyDown);
      canvas.removeEventListener("webglcontextlost", contextLost);
      document.removeEventListener("visibilitychange", syncAnimation);
      intersectionObserver.disconnect();
      reducedMotion.removeEventListener("change", motionChanged);
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<MeshBasicMaterial | LineBasicMaterial | PointsMaterial | SpriteMaterial>();
      scene.traverse((object) => {
        if ("geometry" in object && object.geometry instanceof BufferGeometry) {
          geometries.add(object.geometry);
        }
        if ("material" in object) {
          const value = object.material;
          const list = Array.isArray(value) ? value : [value];
          for (const material of list) {
            if (material instanceof MeshBasicMaterial ||
              material instanceof LineBasicMaterial ||
              material instanceof PointsMaterial ||
              material instanceof SpriteMaterial) {
              materials.add(material);
            }
          }
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => {
        if ("map" in material && material.map) material.map.dispose();
        material.dispose();
      });
      nodeMesh.dispose();
      glowMesh.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [nodes, edges, colors, autoRotate]);

  useEffect(() => {
    if (selectedId) controllerRef.current?.focus(selectedId);
  }, [selectedId, nodes]);

  return h(
    "div",
    { ref: hostRef, className: "star-map star-map-3d graph3d" },
    h(
      "div",
      { className: "graph3d-instructions", "aria-hidden": true },
      h("span", { className: "graph3d-status-dot" }),
      autoRotate ? "记忆星系 · 空闲自动环绕" : "记忆星系 · 手动探索",
    ),
    h(
      "div",
      { className: "graph3d-controls", "aria-hidden": true },
      "拖拽旋转 · 滚轮缩放 · 点击聚焦",
    ),
  );
}
