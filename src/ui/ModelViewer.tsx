import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { meshStats, type ManifestFile, type Mesh, type MeshStats } from "../core";
import { workerMesher } from "../mesh/client";

const PALETTE = [0x4f7fd9, 0xd98a4f, 0x5fae6e, 0xb76cc4, 0xc9b23f, 0x4fb3b8];
const SELECTED = 0xff5a36;

type View = "iso" | "top" | "front" | "right";
const VIEW_DIRECTIONS: Record<View, [number, number, number]> = {
  iso: [1, -1, 0.8],
  top: [0, 0, 1],
  front: [0, -1, 0],
  right: [1, 0, 0],
};

interface Scene {
  setView(view: View): void;
  setVisible(index: number, visible: boolean): void;
  setSelected(index: number | null): void;
  setEdges(on: boolean): void;
}

const mm = (v: number) => `${Math.round(v * 10) / 10}`;

/**
 * Interactive 3D view of a verified STEP model. Meshing runs in a throwaway OpenCascade worker;
 * the page only receives triangles. CAD convention: Z is up.
 */
export function ModelViewer({ file, bytes }: { file: ManifestFile; bytes: Uint8Array }) {
  const [meshes, setMeshes] = useState<Mesh[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [edges, setEdges] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeshes(null);
    setError(null);
    setSelected(null);
    setHidden(new Set());
    workerMesher(bytes).then(
      (m) => !cancelled && setMeshes(m),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [file.path, bytes]);

  const stats = useMemo<MeshStats[]>(() => (meshes ?? []).map(meshStats), [meshes]);

  useEffect(() => {
    if (!meshes || !canvasRef.current || !containerRef.current) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100_000);
    camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    scene.add(sun);

    const objects = meshes.map((m, i) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(m.positions), 3));
      geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.indices), 1));
      geometry.computeVertexNormals();
      const color = PALETTE[i % PALETTE.length]!;
      const material = new THREE.MeshStandardMaterial({ color, flatShading: true, metalness: 0.1, roughness: 0.6 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.index = i;
      const lines = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({ color: 0x1a1a1a }),
      );
      mesh.add(lines);
      scene.add(mesh);
      return { mesh, lines, color };
    });

    const box = new THREE.Box3();
    objects.forEach((o) => box.expandByObject(o.mesh));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);

    // Build-plate grid under the model, in the XY plane.
    const grid = new THREE.GridHelper(radius * 4, 20, 0x888888, 0xbbbbbb);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(center.x, center.y, box.min.z);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    scene.add(grid);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.copy(center);

    let frame = 0;
    const render = () => {
      frame = 0;
      const moving = controls.update();
      sun.position.copy(camera.position);
      renderer.render(scene, camera);
      if (moving) requestRender();
    };
    const requestRender = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    controls.addEventListener("change", requestRender);

    const setView = (view: View) => {
      const dir = new THREE.Vector3(...VIEW_DIRECTIONS[view]).normalize();
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
      camera.position.copy(center).addScaledVector(dir, distance);
      // Looking straight down Z needs a different up vector to stay well defined.
      camera.up.set(0, view === "top" ? 1 : 0, view === "top" ? 0 : 1);
      controls.target.copy(center);
      camera.lookAt(center);
      controls.update();
      requestRender();
    };

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    setView("iso");

    // Click (not drag) to select a solid.
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(objects.map((o) => o.mesh).filter((m) => m.visible), false)[0];
      setSelected(hit ? (hit.object.userData.index as number) : null);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    sceneRef.current = {
      setView,
      setVisible: (i, visible) => {
        objects[i]!.mesh.visible = visible;
        requestRender();
      },
      setSelected: (sel) => {
        objects.forEach((o, i) => (o.mesh.material as THREE.MeshStandardMaterial).color.setHex(i === sel ? SELECTED : o.color));
        requestRender();
      },
      setEdges: (on) => {
        objects.forEach((o) => (o.lines.visible = on));
        requestRender();
      },
    };

    return () => {
      sceneRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      controls.dispose();
      objects.forEach(({ mesh, lines }) => {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        lines.geometry.dispose();
        (lines.material as THREE.Material).dispose();
      });
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, [meshes]);

  useEffect(() => sceneRef.current?.setSelected(selected), [selected, meshes]);
  useEffect(() => sceneRef.current?.setEdges(edges), [edges, meshes]);

  const toggle = (i: number) => {
    const next = new Set(hidden);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setHidden(next);
    sceneRef.current?.setVisible(i, !next.has(i));
  };

  if (error) return <div className="banner fail">Could not load model: {error}</div>;

  const triangles = stats.reduce((n, s) => n + s.triangles, 0);
  return (
    <div className="model">
      <div className="toolbar row">
        {(["iso", "top", "front", "right"] as View[]).map((v) => (
          <button key={v} disabled={!meshes} onClick={() => sceneRef.current?.setView(v)}>
            {v[0]!.toUpperCase() + v.slice(1)}
          </button>
        ))}
        <label className="row">
          <input type="checkbox" checked={edges} onChange={(e) => setEdges(e.target.checked)} /> Edges
        </label>
      </div>
      <div
        ref={containerRef}
        className="model-canvas"
        data-solids={meshes?.length ?? 0}
        data-triangles={triangles}
      >
        {!meshes && <p className="muted overlay">Meshing {file.path}…</p>}
        <canvas ref={canvasRef} aria-label={`3D model ${file.path}`} />
      </div>
      {meshes && (
        <ul className="solids">
          {meshes.map((m, i) => {
            const s = stats[i]!;
            return (
              <li key={i} className={i === selected ? "selected" : ""}>
                <input type="checkbox" aria-label={`Show ${m.name}`} checked={!hidden.has(i)} onChange={() => toggle(i)} />
                <span className="swatch" data-color={i % PALETTE.length} />
                <button className="link" onClick={() => setSelected(i === selected ? null : i)}>
                  {m.name}
                </button>
                <span className="muted">
                  {" "}{mm(s.max[0] - s.min[0])} × {mm(s.max[1] - s.min[1])} × {mm(s.max[2] - s.min[2])} mm · {s.triangles} triangles
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
