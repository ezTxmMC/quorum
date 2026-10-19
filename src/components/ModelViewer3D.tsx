import { memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BbCube, BbFace, BbGroup, BbModel } from '@shared/bbmodel';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { cx } from './ui';

const DEFAULT_COLOR = '#b4b4b4';
const FACE_NAMES: BbFace[] = ['east', 'west', 'up', 'down', 'south', 'north'];

export interface ModelViewer3DProps {
  model: BbModel;
  renderUrl?: string | null;
  className?: string;
  onOpenBlockbench?: () => void;
}

export const ModelViewer3D = memo(function ModelViewer3D({ model, renderUrl, className, onOpenBlockbench }: ModelViewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const resetCamRef = useRef<(() => void) | null>(null);

  const [mouseMode, setMouseMode] = useState<'orbit' | 'pan'>('orbit');
  const [viewMode, setViewMode] = useState<'3d' | 'image'>('3d');
  const [autoRotate, setAutoRotate] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [wireframe, setWireframe] = useState(false);

  // Sync mouseMode to controls
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (mouseMode === 'orbit') {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
    } else {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
      };
    }
  }, [mouseMode]);

  // Sync autoRotate to controls
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate;
      controlsRef.current.autoRotateSpeed = 2.0;
    }
  }, [autoRotate]);

  useEffect(() => {
    if (viewMode !== '3d') return;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const width = container.clientWidth || 380;
    const height = container.clientHeight || 300;

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    // Scene
    const scene = new THREE.Scene();

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / Math.max(1, height), 0.1, 1000);

    // Controls
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 2.0;
    if (mouseMode === 'orbit') {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
    } else {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
      };
    }
    controlsRef.current = controls;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight1.position.set(20, 30, 25);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xa5b4fc, 0.45);
    dirLight2.position.set(-20, -10, -20);
    scene.add(dirLight2);

    // Textures cache
    const textures: (THREE.Texture | null)[] = [];
    (model.textures || []).forEach((tInfo, idx) => {
      if (tInfo?.source && tInfo.source.startsWith('data:image/')) {
        const img = new Image();
        img.src = tInfo.source;
        const tex = new THREE.Texture(img);
        img.onload = () => {
          tex.needsUpdate = true;
        };
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        textures[idx] = tex;
      } else {
        textures[idx] = null;
      }
    });

    // Build hierarchy
    const root = new THREE.Group();
    root.name = 'ModelRoot';
    scene.add(root);

    const groupMap = new Map<string, { obj: THREE.Group; origin: [number, number, number] }>();
    function buildGroups(nodes: (BbGroup | string)[], parent: THREE.Group, parentOrigin: [number, number, number]) {
      for (const node of nodes) {
        if (typeof node === 'string') continue;
        const origin: [number, number, number] = node.origin ? [...node.origin] : [0, 0, 0];
        const groupObj = new THREE.Group();
        groupObj.name = node.name || 'Group';
        parent.add(groupObj);
        groupObj.position.set(origin[0] - parentOrigin[0], origin[1] - parentOrigin[1], origin[2] - parentOrigin[2]);
        groupObj.rotation.order = 'ZYX';
        if (node.rotation) {
          groupObj.rotation.set(
            THREE.MathUtils.degToRad(node.rotation[0] || 0),
            THREE.MathUtils.degToRad(node.rotation[1] || 0),
            THREE.MathUtils.degToRad(node.rotation[2] || 0),
          );
        }
        groupMap.set(node.uuid, { obj: groupObj, origin });
        if (node.children) buildGroups(node.children, groupObj, origin);
      }
    }
    buildGroups(model.outliner || [], root, [0, 0, 0]);

    const cubeParents = new Map<string, { parent: THREE.Group; origin: [number, number, number] }>();
    function mapCubeParents(nodes: (BbGroup | string)[], parent: THREE.Group, origin: [number, number, number]) {
      for (const node of nodes) {
        if (typeof node === 'string') {
          cubeParents.set(node, { parent, origin });
        } else {
          const g = groupMap.get(node.uuid);
          if (g) mapCubeParents(node.children || [], g.obj, g.origin);
        }
      }
    }
    mapCubeParents(model.outliner || [], root, [0, 0, 0]);

    // Track created materials and geometries to dispose cleanly
    const disposables: { dispose: () => void }[] = [];

    // Create cubes
    const elements: BbCube[] = (model.elements || []).filter((e) => e && (e.type === 'cube' || !e.type));
    for (const cube of elements) {
      const from = cube.from || [0, 0, 0];
      const to = cube.to || [1, 1, 1];
      const minX = Math.min(from[0], to[0]), maxX = Math.max(from[0], to[0]);
      const minY = Math.min(from[1], to[1]), maxY = Math.max(from[1], to[1]);
      const minZ = Math.min(from[2], to[2]), maxZ = Math.max(from[2], to[2]);
      const w = Math.max(0.01, maxX - minX);
      const h = Math.max(0.01, maxY - minY);
      const d = Math.max(0.01, maxZ - minZ);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;

      const { parent, origin: parentOrigin } = cubeParents.get(cube.uuid) ?? { parent: root, origin: [0, 0, 0] };
      const pivot: [number, number, number] = cube.origin ? [...cube.origin] : [cx, cy, cz];
      const rot = cube.rotation || [0, 0, 0];

      const geom = new THREE.BoxGeometry(w, h, d);
      disposables.push(geom);

      // Materials for the 6 faces: ['east', 'west', 'up', 'down', 'south', 'north']
      const mats: THREE.Material[] = [];
      const hasTextures = (model.textures?.length ?? 0) > 0;

      for (let i = 0; i < 6; i++) {
        const faceName = FACE_NAMES[i];
        const faceData = cube.faces?.[faceName];
        const texIdx = faceData?.texture !== undefined ? Number(faceData.texture) : 0;
        const tex = hasTextures ? textures[texIdx] : null;

        if (tex && faceData?.uv) {
          const mat = new THREE.MeshStandardMaterial({
            map: tex,
            roughness: cube.material?.roughness ?? 0.8,
            metalness: cube.material?.metalness ?? 0.0,
            wireframe,
          });
          mats.push(mat);
          disposables.push(mat);

          // Update UV for face i (vertices i*4 to i*4+3)
          const uv = geom.attributes.uv;
          const texInfo = model.textures[texIdx];
          const tw = texInfo?.width || model.resolution?.width || 16;
          const th = texInfo?.height || model.resolution?.height || 16;
          const [u0, v0, u1, v1] = faceData.uv;
          const u_left = u0 / tw;
          const u_right = u1 / tw;
          const v_top = 1 - (v0 / th);
          const v_bottom = 1 - (v1 / th);
          const base = i * 4;
          uv.setXY(base + 0, u_left, v_top);
          uv.setXY(base + 1, u_right, v_top);
          uv.setXY(base + 2, u_left, v_bottom);
          uv.setXY(base + 3, u_right, v_bottom);
        } else {
          const colorHex = cube.facePaint?.[faceName] ?? cube.paint ?? DEFAULT_COLOR;
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(colorHex),
            roughness: cube.material?.roughness ?? 0.8,
            metalness: cube.material?.metalness ?? 0.0,
            wireframe,
          });
          mats.push(mat);
          disposables.push(mat);
        }
      }

      geom.attributes.uv.needsUpdate = true;

      const cubeGroup = new THREE.Group();
      cubeGroup.name = cube.name || 'Cube';
      parent.add(cubeGroup);
      cubeGroup.position.set(pivot[0] - parentOrigin[0], pivot[1] - parentOrigin[1], pivot[2] - parentOrigin[2]);
      cubeGroup.rotation.order = 'ZYX';
      if (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0) {
        cubeGroup.rotation.set(
          THREE.MathUtils.degToRad(rot[0]),
          THREE.MathUtils.degToRad(rot[1]),
          THREE.MathUtils.degToRad(rot[2]),
        );
      }

      const mesh = new THREE.Mesh(geom, mats);
      mesh.position.set(cx - pivot[0], cy - pivot[1], cz - pivot[2]);
      cubeGroup.add(mesh);
    }

    // Framing: compute bounds and place camera
    const box = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();

    if (box.isEmpty()) {
      center.set(0, 0, 0);
      size.set(16, 16, 16);
    } else {
      box.getCenter(center);
      box.getSize(size);
    }

    const maxDim = Math.max(size.x, size.y, size.z, 6);
    const dist = maxDim * 1.7;

    const setupCamera = () => {
      camera.position.set(center.x + dist * 0.85, center.y + dist * 0.7, center.z + dist * 0.95);
      controls.target.copy(center);
      camera.lookAt(center);
      controls.update();
    };
    setupCamera();
    resetCamRef.current = setupCamera;

    // Ground Grid Helper
    let gridHelper: THREE.GridHelper | null = null;
    if (showGrid) {
      const gridSize = Math.max(16, Math.ceil(maxDim * 1.6 / 8) * 8);
      gridHelper = new THREE.GridHelper(gridSize, 16, 0x64748b, 0x334155);
      gridHelper.position.set(center.x, box.isEmpty() ? 0 : box.min.y, center.z);
      scene.add(gridHelper);
      disposables.push(gridHelper.geometry, gridHelper.material as THREE.Material);
    }

    // Animation Loop
    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize handling
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        }
      }
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      disposables.forEach((d) => d.dispose());
      textures.forEach((t) => t?.dispose());
    };
  }, [model, viewMode, showGrid, wireframe]);

  const cubeCount = model.elements?.length ?? 0;

  return (
    <div className={cx('group/threed relative flex flex-col overflow-hidden rounded-lumen border border-edge bg-surface shadow-xs', className)}>
      {/* Top Toolbar */}
      <div className="flex items-center justify-between gap-1.5 border-b border-edge/60 bg-surface/80 px-2.5 py-1.5 backdrop-blur-xs">
        <div className="flex items-center gap-1">
          {renderUrl && (
            <div className="flex rounded-lumen-sm border border-edge bg-base/50 p-0.5 text-[11px]">
              <button
                className={cx('rounded-sm px-1.5 py-0.5 font-medium transition-colors', viewMode === '3d' ? 'bg-active text-text shadow-xs' : 'text-subtle hover:text-text')}
                onClick={() => setViewMode('3d')}
              >
                3D
              </button>
              <button
                className={cx('rounded-sm px-1.5 py-0.5 font-medium transition-colors', viewMode === 'image' ? 'bg-active text-text shadow-xs' : 'text-subtle hover:text-text')}
                onClick={() => setViewMode('image')}
              >
                {t('Render')}
              </button>
            </div>
          )}

          {viewMode === '3d' && (
            <div className="flex rounded-lumen-sm border border-edge bg-base/50 p-0.5 text-[11px]">
              <button
                className={cx('flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium transition-colors', mouseMode === 'orbit' ? 'bg-active text-text shadow-xs' : 'text-subtle hover:text-text')}
                onClick={() => setMouseMode('orbit')}
                title={t('Linke Maustaste: Drehen (Rechtsklick: Verschieben)')}
              >
                <Icon name="lucide:rotate-3d" size={12} />
                <span>{t('Drehen')}</span>
              </button>
              <button
                className={cx('flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium transition-colors', mouseMode === 'pan' ? 'bg-active text-text shadow-xs' : 'text-subtle hover:text-text')}
                onClick={() => setMouseMode('pan')}
                title={t('Linke Maustaste: Ansicht verschieben')}
              >
                <Icon name="lucide:move" size={12} />
                <span>{t('Verschieben')}</span>
              </button>
            </div>
          )}
        </div>

        {viewMode === '3d' && (
          <div className="flex items-center gap-1">
            <button
              className={cx('icon-btn-sm rounded-sm p-1 text-subtle hover:text-text', autoRotate && 'bg-active text-text')}
              onClick={() => setAutoRotate((v) => !v)}
              title={t('Automatisches Drehen')}
            >
              <Icon name="lucide:rotate-cw" size={13} />
            </button>
            <button
              className={cx('icon-btn-sm rounded-sm p-1 text-subtle hover:text-text', showGrid && 'bg-active text-text')}
              onClick={() => setShowGrid((v) => !v)}
              title={t('Gitter umschalten')}
            >
              <Icon name="lucide:grid-3x3" size={13} />
            </button>
            <button
              className={cx('icon-btn-sm rounded-sm p-1 text-subtle hover:text-text', wireframe && 'bg-active text-text')}
              onClick={() => setWireframe((v) => !v)}
              title={t('Drahtgitter')}
            >
              <Icon name="lucide:box" size={13} />
            </button>
            <button
              className="icon-btn-sm rounded-sm p-1 text-subtle hover:text-text"
              onClick={() => resetCamRef.current?.()}
              title={t('Ansicht zentrieren')}
            >
              <Icon name="lucide:focus" size={13} />
            </button>
            {onOpenBlockbench && (
              <button
                className="icon-btn-sm rounded-sm p-1 text-subtle hover:text-text"
                onClick={onOpenBlockbench}
                title={t('In Blockbench öffnen')}
              >
                <Icon name="lucide:external-link" size={13} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Viewport Area */}
      <div ref={containerRef} className="relative h-[320px] w-full min-w-0 select-none bg-radial from-slate-900/60 to-zinc-950/90 sm:h-[360px]">
        {viewMode === '3d' ? (
          <>
            <canvas
              ref={canvasRef}
              className={cx('h-full w-full outline-hidden', mouseMode === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-grab active:cursor-grabbing')}
            />
            {cubeCount === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-[12px] text-subtle">
                {t('Modell hat keine Würfel')}
              </div>
            )}
            {/* Control hints */}
            <div className="pointer-events-none absolute bottom-1.5 left-2 flex items-center gap-1.5 text-[10.5px] text-subtle/80 opacity-70 transition-opacity group-hover/threed:opacity-100">
              <span className="font-mono text-[9.5px] bg-base/60 px-1 py-0.5 rounded-xs">
                {mouseMode === 'orbit' ? t('Links: Drehen · Rechts/Shift: Verschieben') : t('Links: Verschieben · Rechts: Drehen')}
              </span>
              <span>·</span>
              <span className="font-mono text-[9.5px] bg-base/60 px-1 py-0.5 rounded-xs">{t('Rad: Zoom')}</span>
            </div>
            {/* Cube badge */}
            <div className="pointer-events-none absolute right-2 bottom-1.5 rounded-full bg-base/70 px-2 py-0.5 text-[10.5px] font-medium text-subtle backdrop-blur-xs">
              {cubeCount} {t('Würfel')}
            </div>
          </>
        ) : (
          renderUrl ? (
            <div className="flex h-full w-full items-center justify-center p-2">
              <img src={renderUrl} alt={model.name} className="max-h-full max-w-full rounded-sm object-contain" />
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[12px] text-subtle">
              {t('Noch kein Render-Bild vorhanden.')}
            </div>
          )
        )}
      </div>
    </div>
  );
});
