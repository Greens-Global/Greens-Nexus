// Google Photorealistic 3D Tiles under the site model (Oct 20 2026). Loaded only
// when the "Realistic 3D" view is chosen, so neither 3d-tiles-renderer nor the
// glTF / Draco loaders are in the main bundle.
//
// The key is a Google Maps Platform BROWSER key: it ships to the page, so it must
// be restricted in Google Cloud to HTTP referrers (the Nexus domains only) and to
// the Map Tiles API. It is read from VITE_GOOGLE_MAPS_KEY at build time; with no
// key the view is never offered. The public customer page (/map/) never uses it
// (Google bills per root-tile session) - SiteModelPanel only offers it to owners.
//
// Google's terms require the data providers' credit on screen while tiles show:
// the viewer reports it through onAttribution and the panel prints it.
import * as THREE from 'three';
import { geoFrame, enuToModelWorld } from './siteModelGeo.js';

export const GOOGLE_TILES_KEY = (import.meta.env && import.meta.env.VITE_GOOGLE_MAPS_KEY) || '';
export const photorealAvailable = () => !!GOOGLE_TILES_KEY;

/**
 * Starts streaming tiles around the model's origin. Resolves to a handle with
 * update() (call once a frame before rendering), groundY(), attribution() and
 * dispose(); rejects when the library or the tileset cannot load. `onFail` is
 * also called later if no real ground shows up at the site (no 3D coverage).
 */
export async function attachPhotoreal({ scene, camera, renderer, model, center, probes: probeAt = [], onFail }) {
  if (!GOOGLE_TILES_KEY) throw new Error('No Google Maps key');
  // Single-file imports, not the plugin indexes (those pull every overlay and loader).
  const [{ TilesRenderer }, { GoogleCloudAuthPlugin }, { GLTFExtensionsPlugin }, { TilesFadePlugin }, { DRACOLoader }] = await Promise.all([
    import('3d-tiles-renderer/three'),
    import('3d-tiles-renderer/src/core/plugins/GoogleCloudAuthPlugin.js'),
    import('3d-tiles-renderer/src/three/plugins/GLTFExtensionsPlugin.js'),
    import('3d-tiles-renderer/src/three/plugins/fade/TilesFadePlugin.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
  ]);
  const geo = geoFrame(model.frame);
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: GOOGLE_TILES_KEY, autoRefreshToken: true }));
  // Draco decoder is self-hosted (public/draco/): CSP allows no script CDN.
  const draco = new DRACOLoader().setDecoderPath('/draco/');
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.errorTarget = 12;
  tiles.setCamera(camera); tiles.setResolutionFromRenderer(camera, renderer);

  // Put the model's origin (lat0, lon0) at the world origin: globe (ECEF) ->
  // local east / north / up (the inverse ENU frame) -> the model's axes, with
  // the model's own meters-per-degree stretch (enuToModelWorld) so a unit's u / v
  // lands on the same latitude / longitude the build placed it at. The vertical
  // offset is found by probing the mesh under the lot, since the ellipsoid
  // height of the ground is not the lot's grade.
  const D2R = Math.PI / 180; const enu = new THREE.Matrix4();
  tiles.ellipsoid.getObjectFrame(geo.lat0 * D2R, geo.lon0 * D2R, 0, 0, 0, 0, enu, 0 /* ENU_FRAME */);
  const r = enuToModelWorld(model.frame); const rot = new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
  // Not decomposed: the east stretch is not a plain scale of the globe's axes.
  tiles.group.matrixAutoUpdate = false; tiles.group.matrix.copy(rot.multiply(enu.invert())); tiles.group.matrixWorldNeedsUpdate = true;
  const holder = new THREE.Group(); holder.add(tiles.group); scene.add(holder);

  // Anything new in the mesh (a tile loaded, a finer one swapped in) bumps the
  // version, so the viewer re-samples the surface heights it keeps per unit.
  let version = 0; const bump = () => { version++; };
  tiles.addEventListener('load-model', bump); tiles.addEventListener('dispose-model', bump); tiles.addEventListener('tile-visibility-change', bump);
  let lastErr = null; tiles.addEventListener('load-error', (e) => { lastErr = e; });
  // Rays go through the scene graph of the tiles on screen: the renderer's own
  // bounding-volume shortcut (optimizeRaycast) missed whole rows of stalls and
  // sometimes hit ~115 m up in the air under this frame (Oct 20 2026).
  tiles.optimizeRaycast = false;
  const ray = new THREE.Raycaster(); const down = new THREE.Vector3(0, -1, 0); const from = new THREE.Vector3(); let groundY = null; let probes = 0; const t0 = performance.now();
  let failed = false;
  /** The mesh's top surface straight under (u, v), in the tileset's own heights (before the lot offset). */
  function surfaceAt(u, v) {
    if (!tiles.root) return null;
    ray.set(from.set(u, 4000 + holder.position.y, -v), down); ray.far = 9000;
    const h = ray.intersectObject(tiles.group, true)[0];
    return h ? h.point.y - holder.position.y : null;
  }
  function probe() {
    probes++;
    // Several open spots on the lot; the lower quartile skips roofs and parked RVs.
    const ys = [center, ...probeAt].map((p) => surfaceAt(p[0], p[1])).filter((y) => y != null).sort((a, b) => a - b);
    if (ys.length) { const y = ys[Math.floor((ys.length - 1) / 4)]; groundY = groundY == null ? y : groundY + (y - groundY) * 0.5; holder.position.y = -groundY; holder.updateMatrixWorld(true); }
    // No mesh under the site = no coverage here: the root failed, or nothing is
    // left to load after 25 s (a slow machine still streaming gets up to 90 s).
    const st = tiles.stats || {}; const busy = (st.queued || 0) + (st.downloading || 0) + (st.parsing || 0) > 0; const age = performance.now() - t0;
    if (!failed && groundY == null && ((lastErr && !tiles.root) || (age > 25000 && !busy) || age > 90000)) { failed = true; onFail && onFail(lastErr); }
  }
  let lastProbe = 0;
  return {
    update(now) {
      camera.updateMatrixWorld(); tiles.setResolutionFromRenderer(camera, renderer); tiles.update();
      if (now - lastProbe > (probes < 30 ? 700 : 4000)) { lastProbe = now; probe(); }
    },
    groundY: () => groundY,
    /** The mesh's top surface under (u, v) in the tileset's heights, or null where no tile is loaded;
     *  add offsetY() for the world height (it settles over the first seconds as the lot is probed). */
    surfaceAt,
    offsetY: () => holder.position.y,
    /** Changes whenever the loaded mesh changes (a tile loaded, swapped or dropped). */
    version: () => version,
    /** The credit line Google requires: the data providers of the tiles in view. */
    attribution() {
      const list = tiles.getAttributions ? tiles.getAttributions() : [];
      const text = list.filter((a) => a.type === 'string').map((a) => a.value).filter(Boolean).join('; ');
      // The providers list usually names Google itself - say it once.
      if (!text) return 'Google';
      return /\bGoogle\b/.test(text) ? text : `Google · ${text}`;
    },
    dispose() { try { tiles.dispose(); } catch { /* already gone */ } draco.dispose(); scene.remove(holder); },
  };
}
