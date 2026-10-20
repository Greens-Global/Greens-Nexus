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
import { geoFrame, enuToWorld } from './siteModelGeo.js';

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
  // local east / north / up (the inverse ENU frame) -> the model's axes. The
  // vertical offset is found by probing the mesh under the lot, since the
  // ellipsoid height of the ground is not the lot's grade.
  const D2R = Math.PI / 180; const enu = new THREE.Matrix4();
  tiles.ellipsoid.getObjectFrame(geo.lat0 * D2R, geo.lon0 * D2R, 0, 0, 0, 0, enu, 0 /* ENU_FRAME */);
  const r = enuToWorld(model.frame); const rot = new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
  rot.multiply(enu.invert()).decompose(tiles.group.position, tiles.group.quaternion, tiles.group.scale);
  const holder = new THREE.Group(); holder.add(tiles.group); scene.add(holder);

  let lastErr = null; tiles.addEventListener('load-error', (e) => { lastErr = e; });
  const ray = new THREE.Raycaster(); const down = new THREE.Vector3(0, -1, 0); let groundY = null; let probes = 0; const t0 = performance.now();
  let failed = false;
  function probe() {
    probes++;
    // Several open spots on the lot; the lower quartile skips roofs and parked RVs.
    const ys = [center, ...probeAt].map((p) => { ray.set(new THREE.Vector3(p[0], 4000, -p[1]), down); ray.far = 9000; const h = ray.intersectObject(tiles.group, true)[0]; return h ? h.point.y - holder.position.y : null; }).filter((y) => y != null).sort((a, b) => a - b);
    if (ys.length) { const y = ys[Math.floor((ys.length - 1) / 4)]; groundY = groundY == null ? y : groundY + (y - groundY) * 0.5; holder.position.y = -groundY; }
    // No mesh under the site after 25 s (or the root failed) = no coverage here.
    if (!failed && groundY == null && (performance.now() - t0 > 25000 || (lastErr && !tiles.root))) { failed = true; onFail && onFail(lastErr); }
  }
  let lastProbe = 0;
  return {
    update(now) {
      camera.updateMatrixWorld(); tiles.setResolutionFromRenderer(camera, renderer); tiles.update();
      if (now - lastProbe > (probes < 30 ? 700 : 4000)) { lastProbe = now; probe(); }
    },
    groundY: () => groundY,
    /** The credit line Google requires: the data providers of the tiles in view. */
    attribution() {
      const list = tiles.getAttributions ? tiles.getAttributions() : [];
      const text = list.filter((a) => a.type === 'string').map((a) => a.value).filter(Boolean).join('; ');
      return text ? `Google · ${text}` : 'Google';
    },
    dispose() { try { tiles.dispose(); } catch { /* already gone */ } draco.dispose(); scene.remove(holder); },
  };
}
