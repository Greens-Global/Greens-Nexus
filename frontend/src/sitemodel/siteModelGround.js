// The realistic ground under the satellite look (Oct 20 2026, Visesh: "looks so
// flat and I want reality"). One terrain mesh, ~24 km across, raised from the
// free AWS Terrain Tiles (Terrarium PNGs) and draped with Esri World Imagery at
// several zooms - sharp next to the lot, coarse toward a horizon that melts into
// haze, so there is never a photo edge. The developed lot stays flat at its own
// grade (y = 0) so units, lines and labels sit exactly where they always have.
//
// Everything streams in after the scene is up: the flat photo plane shows first,
// then sharper imagery and the hills arrive. A tile that fails is skipped (the
// coarser layer shows through); if no elevation arrives the ground stays flat.
import * as THREE from 'three';
import { geoFrame, lonLatToTile, tileRange, tileMeters, decodeTerrarium, developedHull, distanceOutside, flattenWeight } from './siteModelGeo.js';

const ESRI = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?blankTile=false`;
// Virtual-hosted bucket URL: CSP img-src names exactly this host (public/_headers).
const TERRARIUM = (z, x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;
export const ELEVATION_CREDIT = 'Elevation: AWS Terrain Tiles (USGS, others)';

/** The haze and sky colors (sRGB), shared with the viewer's fog and lights. */
export const ATMOSPHERE = { haze: 0xc9d5df, zenith: 0x6d98c8, groundTint: 0x9b9787 };

function loadImage(url, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url;
  });
}

/** Fetch a block of tiles into one canvas, at most `limit` requests at a time. */
async function mosaic(range, urlOf, signal, limit = 8) {
  const nx = range.x1 - range.x0 + 1, ny = range.y1 - range.y0 + 1;
  const cv = document.createElement('canvas'); cv.width = nx * 256; cv.height = ny * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: false });
  const jobs = []; for (let y = range.y0; y <= range.y1; y++) for (let x = range.x0; x <= range.x1; x++) jobs.push([x, y]);
  let ok = 0; let next = 0;
  const worker = async () => {
    while (next < jobs.length && !signal.aborted) {
      const [x, y] = jobs[next++]; const img = await loadImage(urlOf(range.z, x, y), signal);
      if (img && !signal.aborted) { ctx.drawImage(img, (x - range.x0) * 256, (y - range.y0) * 256, 256, 256); ok++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return { canvas: cv, ok, total: jobs.length, range };
}

/** A tile range centered on a lon/lat, `half` meters each way. */
function rangeAround(lon, lat, half, z) {
  const dLat = half / 110900, dLon = half / (111320 * Math.cos((lat * Math.PI) / 180));
  return tileRange(lon - dLon, lat - dLat, lon + dLon, lat + dLat, z);
}

/**
 * Builds the ground and adds it to `scene`. `center` = [u, v] of the lot's middle.
 * Returns { mesh, heightAt(u, v), ready (Promise), dispose() }.
 */
export function createRealGround(scene, model, opts) {
  const { renderer, images = {}, center, onChange = () => {} } = opts;
  const geo = geoFrame(model.frame);
  const abort = new AbortController(); const signal = abort.signal;
  const [cLon, cLat] = geo.uvToLl(center[0], center[1]);

  // ---- mesh: a grid whose spacing grows away from the lot (sinh), ~3 m at the
  // middle and a few hundred meters at the 12 km rim, 201 x 201 vertices ----
  const N = 200, R = 12000, A = 5.9; const sA = Math.sinh(A);
  const coord = (i) => (R * Math.sinh(A * ((i / N) * 2 - 1))) / sA;
  const pos = new Float32Array((N + 1) * (N + 1) * 3); const idx = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const k = (j * (N + 1) + i) * 3; pos[k] = center[0] + coord(i); pos[k + 1] = 0; pos[k + 2] = -(center[1] + coord(j)); }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(center[0], 0, -center[1]), R * 1.5);

  // ---- material: Lambert (lights, shadows, fog) sampling up to six imagery
  // layers by world position; each fades out at its own edge and where its
  // tiles are missing (alpha), so the next coarser layer shows through ----
  const LAYERS = 6; const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); blank.needsUpdate = true;
  const uniforms = { gBase: { value: new THREE.Color(ATMOSPHERE.groundTint) } };
  for (let i = 0; i < LAYERS; i++) { uniforms[`gT${i}`] = { value: blank }; uniforms[`gM${i}`] = { value: new THREE.Matrix3() }; uniforms[`gOn${i}`] = { value: 0 }; }
  /** Make any lit material show the imagery by world position (the ground, and
   *  building roofs, which then wear their real roof from the photo). */
  function drape(m, key = 'ground') {
   m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGeo;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGeo = (modelMatrix * vec4(transformed, 1.0)).xz;');
    let decl = 'varying vec2 vGeo;\nuniform vec3 gBase;\n';
    let body = 'vec3 gp = vec3(vGeo, 1.0); vec4 gcol = vec4(gBase, 1.0); vec2 guv; vec4 gs; float gw;\n';
    for (let i = 0; i < LAYERS; i++) {
      decl += `uniform sampler2D gT${i}; uniform mat3 gM${i}; uniform float gOn${i};\n`;
      // gOn is uniform, so the branch is too (safe for mipmapped sampling inside it).
      body += `if (gOn${i} > 0.5) { guv = (gM${i} * gp).xy; gw = smoothstep(0.0, 0.03, guv.x) * smoothstep(0.0, 0.03, 1.0 - guv.x) * smoothstep(0.0, 0.03, guv.y) * smoothstep(0.0, 0.03, 1.0 - guv.y);`
        + ` gs = texture2D(gT${i}, guv); gcol.rgb = mix(gcol.rgb, gs.rgb, gw * gs.a); }\n`;
    }
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <map_fragment>', `${body}diffuseColor *= gcol;`);
   };
   m.customProgramCacheKey = () => `nexus-drape-${key}`; return m;
  }
  const mat = drape(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const mesh = new THREE.Mesh(g, mat); mesh.receiveShadow = true; mesh.renderOrder = -1;
  scene.add(mesh);

  /** Matrix taking world (x, z, 1) to the texture uv of a north-up mercator mosaic. */
  function mosaicMatrix(range) {
    const nx = range.x1 - range.x0 + 1, ny = range.y1 - range.y0 + 1;
    const toUv = (x, z) => { const [lon, lat] = geo.uvToLl(x, -z); const t = lonLatToTile(lon, lat, range.z); return [(t[0] - range.x0) / nx, 1 - (t[1] - range.y0) / ny]; };
    return affineFrom(toUv, center[0], -center[1], 200);
  }
  /** Matrix for a picture whose four corners (uv frame) are known: [nw, ne, se, sw]. */
  function cornerMatrix(c) {
    // world (x, z) of nw, ne, sw -> texture (0,1), (1,1), (0,0)
    const p0 = [c[0][0], -c[0][1]], p1 = [c[1][0], -c[1][1]], p3 = [c[3][0], -c[3][1]];
    const m = new THREE.Matrix3().set(p1[0] - p0[0], p3[0] - p0[0], p0[0], p1[1] - p0[1], p3[1] - p0[1], p0[1], 0, 0, 1).invert();
    // that gives (s, t) with s along nw->ne and t along nw->sw; texture v = 1 - t
    return new THREE.Matrix3().set(1, 0, 0, 0, -1, 1, 0, 0, 1).multiply(m);
  }
  function setLayer(i, tex, m) { uniforms[`gT${i}`].value = tex; uniforms[`gM${i}`].value = m; uniforms[`gOn${i}`].value = 1; onChange(); }
  const owned = [];
  function texOf(src) {
    const t = src instanceof HTMLCanvasElement ? new THREE.CanvasTexture(src) : new THREE.Texture(src);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; owned.push(t); return t;
  }

  // Layer order, coarse to fine: 0 = z11 horizon, 1 = z14 region, 2 = the wide
  // photo shipped with the model, 3 = z17 surroundings, 4 = z18 next to the lot,
  // 5 = the detail photo the model was fitted to (always on top over the lot).
  const loader = new THREE.TextureLoader();
  const still = (src, i, corners) => { if (src && corners) loader.load(src, (t) => { if (signal.aborted) { t.dispose(); return; } t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); owned.push(t); setLayer(i, t, cornerMatrix(corners)); }); };
  still(images.detail, 5, model.image && model.image.uv);
  still(images.wide, 2, model.imageWide && model.imageWide.uv);
  const imagery = (async () => {
    const plan = [[0, 11, 14000], [1, 14, 5000], [3, 17, 900], [4, 18, 420]];
    for (const [i, z, half0] of plan) {
      let half = half0;
      if (signal.aborted) return;
      let r = rangeAround(cLon, cLat, half, z);
      // keep each mosaic inside a 4096 px texture
      while ((r.x1 - r.x0 + 1) > 16 || (r.y1 - r.y0 + 1) > 16) r = rangeAround(cLon, cLat, (half *= 0.85), z);
      const m = await mosaic(r, ESRI, signal);
      if (signal.aborted) return;
      if (m.ok > 0) setLayer(i, texOf(m.canvas), mosaicMatrix(r));
    }
  })();

  // ---- elevation: z15 next to the site, z11 for the hills around it ----
  const hull = developedHull(model);
  const elev = [];   // { range, w, h, data: Float32Array }
  function sampleElev(lon, lat) {
    for (const e of elev) {
      const t = lonLatToTile(lon, lat, e.range.z); const px = (t[0] - e.range.x0) * 256 - 0.5, py = (t[1] - e.range.y0) * 256 - 0.5;
      if (px < 0 || py < 0 || px > e.w - 2 || py > e.h - 2) continue;
      const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0; const d = e.data; const W = e.w;
      const a = d[y0 * W + x0], b = d[y0 * W + x0 + 1], c = d[(y0 + 1) * W + x0], dd = d[(y0 + 1) * W + x0 + 1];
      if (!Number.isFinite(a + b + c + dd)) continue;
      return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + dd * fx * fy;
    }
    return null;
  }
  let lotH = 0; let raised = false;
  function heightAtUv(u, v) {
    if (!raised) return 0;
    const [lon, lat] = geo.uvToLl(u, v); const h = sampleElev(lon, lat); if (h == null) return 0;
    return (h - lotH) * (1 - flattenWeight(distanceOutside(hull, u, v)));
  }
  const elevation = (async () => {
    for (const [z, half] of [[15, 1400], [11, 13000]]) {
      if (signal.aborted) return;
      const r = rangeAround(cLon, cLat, half, z); const m = await mosaic(r, TERRARIUM, signal, 6);
      if (signal.aborted || !m.ok) continue;
      const ctx = m.canvas.getContext('2d'); const { data } = ctx.getImageData(0, 0, m.canvas.width, m.canvas.height);
      const f = new Float32Array(m.canvas.width * m.canvas.height);
      for (let i = 0; i < f.length; i++) f[i] = data[i * 4 + 3] < 255 ? NaN : decodeTerrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      elev.push({ range: r, w: m.canvas.width, h: m.canvas.height, data: f });
    }
    if (!elev.length || signal.aborted) return;
    // The lot's grade: the median height under the developed area.
    const hs = []; for (let k = 0; k < 41; k++) { const p = hull[(k * 7) % Math.max(1, hull.length)] || center; const q = [(p[0] + center[0]) / 2, (p[1] + center[1]) / 2]; const [lon, lat] = geo.uvToLl(q[0], q[1]); const h = sampleElev(lon, lat); if (h != null) hs.push(h); }
    { const [lon, lat] = geo.uvToLl(center[0], center[1]); const h = sampleElev(lon, lat); if (h != null) hs.push(h); }
    if (!hs.length) return;
    hs.sort((a, b) => a - b); lotH = hs[hs.length >> 1]; raised = true;
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, heightAtUv(p.getX(i), -p.getZ(i)));
    p.needsUpdate = true; g.computeVertexNormals();
    // The photo already carries its own sun and shade: soften our relief lighting by
    // half (normals tipped toward up) so slopes read in 3D without going muddy.
    const nrm = g.attributes.normal; for (let i = 0; i < nrm.count; i++) { const x = nrm.getX(i) * 0.5, y = nrm.getY(i) * 0.5 + 0.5, z = nrm.getZ(i) * 0.5; const l = Math.hypot(x, y, z) || 1; nrm.setXYZ(i, x / l, y / l, z / l); }
    nrm.needsUpdate = true; onChange();
  })();

  return {
    mesh,
    /** The ground's height (meters, lot grade = 0) at a model point. */
    heightAt: heightAtUv,
    drape,
    ready: Promise.all([imagery, elevation]).catch(() => {}),
    hasElevation: () => raised,
    tileMeters: (z) => tileMeters(cLat, z),
    dispose() { abort.abort(); owned.forEach((t) => t.dispose()); blank.dispose(); g.dispose(); mat.dispose(); scene.remove(mesh); },
  };
}

/** Least-squares-free affine fit: sample `fn` at a point and two offsets. */
function affineFrom(fn, x, z, d) {
  const a = fn(x, z), b = fn(x + d, z), c = fn(x, z + d);
  const ax = (b[0] - a[0]) / d, az = (c[0] - a[0]) / d, bx = (b[1] - a[1]) / d, bz = (c[1] - a[1]) / d;
  return new THREE.Matrix3().set(ax, az, a[0] - ax * x - az * z, bx, bz, a[1] - bx * x - bz * z, 0, 0, 1);
}

/** A sky dome: haze at the horizon rising to a clear blue, a soft glow toward
 *  the sun. Tone-mapped like everything else so its horizon meets the fog. */
export function createSky(sunDir) {
  const g = new THREE.SphereGeometry(30000, 32, 16);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { haze: { value: new THREE.Color(ATMOSPHERE.haze) }, zenith: { value: new THREE.Color(ATMOSPHERE.zenith) }, sun: { value: new THREE.Vector3(...sunDir).normalize() } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 haze; uniform vec3 zenith; uniform vec3 sun; varying vec3 vDir;
      void main(){ float h = max(vDir.y, 0.0); vec3 c = mix(haze, zenith, pow(smoothstep(0.0, 0.55, h), 0.8));
        float s = max(dot(normalize(vDir), sun), 0.0); c += vec3(1.0, 0.93, 0.8) * (pow(s, 8.0) * 0.12 + pow(s, 400.0) * 0.6);
        if (vDir.y < 0.0) c = haze;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(g, m); sky.frustumCulled = false; sky.renderOrder = -10; return sky;
}
