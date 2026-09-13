import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Socket } from "socket.io-client";

const CHUNK_SIZE = 25;
const MAX_SPEED_TILES_PER_SECOND = 6; // must stay <= server's MOVEMENT.MAX_SPEED_TILES_PER_SECOND
const MOVE_SEND_INTERVAL_MS = 100;
const REACH_TILES = 3;

const BLOCK_COLORS: Record<number, number> = {
  0: 0x4caf50, // GRASS
  1: 0x8d6e63, // DIRT
  2: 0x9e9e9e, // STONE
  3: 0x1a1a1a, // MINED (pit)
};

interface ChunkPayload {
  cx: number;
  cz: number;
  chunkSize: number;
  blocks: number[];
}

interface Props {
  socket: Socket;
  spawn: { x: number; z: number };
  worldSize: number;
  onMiningStateChange?: (mining: { x: number; z: number } | null) => void;
}

/**
 * Vanilla Three.js scene (spec §3.1): InstancedMesh per block type per chunk, since a 1000x1000
 * world is far too many blocks to give each its own mesh. Movement is predicted locally every
 * frame and reconciled only when the server sends a move:correction — the blockchain never sits
 * in this loop (spec §2).
 */
export function GameCanvas({ socket, spawn, worldSize, onMiningStateChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
    const playerPos = new THREE.Vector3(spawn.x, 1.6, spawn.z);
    camera.position.copy(playerPos);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(50, 100, 50);
    scene.add(sun);

    const boxGeom = new THREE.BoxGeometry(1, 1, 1);
    const chunkMeshes = new Map<string, THREE.InstancedMesh[]>();

    function rebuildChunk(chunk: ChunkPayload) {
      const key = `${chunk.cx}:${chunk.cz}`;
      const existing = chunkMeshes.get(key);
      if (existing) {
        for (const mesh of existing) scene.remove(mesh);
      }

      const byType = new Map<number, { x: number; z: number }[]>();
      for (let dz = 0; dz < chunk.chunkSize; dz++) {
        for (let dx = 0; dx < chunk.chunkSize; dx++) {
          const type = chunk.blocks[dz * chunk.chunkSize + dx];
          if (type === 3) continue; // mined tiles render as empty pits — nothing to draw
          if (!byType.has(type)) byType.set(type, []);
          byType.get(type)!.push({ x: chunk.cx * CHUNK_SIZE + dx, z: chunk.cz * CHUNK_SIZE + dz });
        }
      }

      const meshes: THREE.InstancedMesh[] = [];
      const dummy = new THREE.Object3D();
      for (const [type, positions] of byType.entries()) {
        const material = new THREE.MeshLambertMaterial({ color: BLOCK_COLORS[type] ?? 0xffffff });
        const mesh = new THREE.InstancedMesh(boxGeom, material, positions.length);
        positions.forEach((p, i) => {
          dummy.position.set(p.x, -0.5, p.z);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        scene.add(mesh);
        meshes.push(mesh);
      }
      chunkMeshes.set(key, meshes);
    }

    socket.on("chunk", rebuildChunk);

    // ── Input ────────────────────────────────────────────────────────────
    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => keys.add(e.code);
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let yaw = 0;
    let pitch = 0;
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement) return;
      yaw -= e.movementX * 0.0025;
      pitch -= e.movementY * 0.0025;
      pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
    };
    window.addEventListener("mousemove", onMouseMove);
    const onClickCanvas = () => renderer.domElement.requestPointerLock();
    renderer.domElement.addEventListener("click", onClickCanvas);

    // ── Mining (hold left mouse button on the tile under the crosshair) ───
    let miningTarget: { x: number; z: number } | null = null;
    function targetTile(): { x: number; z: number } | null {
      const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      if (Math.abs(dir.y) < 1e-4) return null;
      const t = -playerPos.y / dir.y; // intersect the y=0 ground plane
      if (t <= 0 || t > REACH_TILES + 2) return null;
      const hit = playerPos.clone().addScaledVector(dir, t);
      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      if (Math.hypot(x - playerPos.x, z - playerPos.z) > REACH_TILES) return null;
      return { x, z };
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || document.pointerLockElement !== renderer.domElement) return;
      const target = targetTile();
      if (!target) return;
      miningTarget = target;
      onMiningStateChange?.(target);
      socket.emit("mine:start", target);
    };
    const onMouseUp = () => {
      if (miningTarget) socket.emit("mine:cancel", miningTarget);
      miningTarget = null;
      onMiningStateChange?.(null);
    };
    renderer.domElement.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);

    socket.on("mine:result", () => {
      miningTarget = null;
      onMiningStateChange?.(null);
    });
    socket.on("mine:rejected", () => {
      miningTarget = null;
      onMiningStateChange?.(null);
    });

    // ── Networking: client-predicted movement, server-reconciled ─────────
    let lastMoveSentAt = 0;
    socket.on("move:correction", (payload: { x: number; z: number }) => {
      playerPos.x = payload.x;
      playerPos.z = payload.z;
    });

    // ── Render loop ────────────────────────────────────────────────────
    let lastFrame = performance.now();
    let raf = 0;
    function animate() {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;

      const forward = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      const move = new THREE.Vector3();
      if (keys.has("KeyW")) move.add(forward);
      if (keys.has("KeyS")) move.sub(forward);
      if (keys.has("KeyD")) move.add(right);
      if (keys.has("KeyA")) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(MAX_SPEED_TILES_PER_SECOND * dt);
        const nextX = playerPos.x + move.x;
        const nextZ = playerPos.z + move.z;
        if (nextX >= 0 && nextX < worldSize && nextZ >= 0 && nextZ < worldSize) {
          playerPos.x = nextX;
          playerPos.z = nextZ;
        }
      }

      camera.position.copy(playerPos);
      camera.rotation.set(pitch, yaw, 0, "YXZ");

      if (now - lastMoveSentAt > MOVE_SEND_INTERVAL_MS) {
        lastMoveSentAt = now;
        socket.emit("move", { x: playerPos.x, z: playerPos.z });
      }

      renderer.render(scene, camera);
    }
    animate();

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", onClickCanvas);
      renderer.domElement.removeEventListener("mousedown", onMouseDown);
      socket.off("chunk", rebuildChunk);
      socket.off("move:correction");
      socket.off("mine:result");
      socket.off("mine:rejected");
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, [socket, spawn, worldSize, onMiningStateChange]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
