// Caricamento del riconoscimento della posa. Usa i file in app/vendor (scaricati al primo avvio),
// altrimenti li chiede a Internet. I video non escono mai dal computer: analisi solo locale.
const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODELS = {
  full: { file: 'pose_landmarker_full.task', url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task' },
  lite: { file: 'pose_landmarker_lite.task', url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task' },
};
let shared = null;

async function exists(url) {
  try { return (await fetch(url, { method: 'HEAD' })).ok; } catch { return false; }
}

async function loadRuntime() {
  if (shared) return shared;
  shared = (async () => {
    const local = await exists('vendor/vision_bundle.mjs') && await exists('vendor/wasm/vision_wasm_internal.wasm');
    const lib = await import(local ? new URL('vendor/vision_bundle.mjs', location.href).href : `${CDN}/vision_bundle.mjs`);
    const fileset = await lib.FilesetResolver.forVisionTasks(local ? new URL('vendor/wasm', location.href).href : `${CDN}/wasm`);
    return { lib, fileset };
  })();
  try { return await shared; } catch (e) { shared = null; throw e; }
}

// Restituisce { detect(video, ts), delegate, close() }.
export async function createPose(modelKind = 'full') {
  if (window.__poseFactory) return window.__poseFactory(modelKind); // solo per i test automatici
  const { lib, fileset } = await loadRuntime();
  const m = MODELS[modelKind];
  const path = (await exists(`vendor/${m.file}`)) ? new URL(`vendor/${m.file}`, location.href).href : m.url;
  const build = (delegate) => lib.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: path, delegate },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let delegate = 'GPU', lm;
  try { lm = await build('GPU'); } catch { delegate = 'CPU'; lm = await build('CPU'); }
  return { delegate, detect: (video, ts) => lm.detectForVideo(video, ts).landmarks?.[0] ?? null, close: () => lm.close() };
}
