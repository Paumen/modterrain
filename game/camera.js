import { ArcRotateCamera, Vector3, Scalar } from '../vendor/babylon/babylon.js';

/* A third-person rig on Babylon's ArcRotateCamera, with one departure from the
 * stock behaviour: elevation is not an input, it is a function of zoom.
 *
 * Pulled in, the camera drops towards the ground and looks along it — close,
 * and about the character. Pushed out, it climbs and looks down — a map of the
 * island. That is one axis of control doing the work of two, which is what
 * makes the whole camera reachable with a single thumb.
 *
 * beta is Babylon's angle from straight up: near zero is directly overhead,
 * near pi/2 is level with the horizon. So "lower camera" is a *larger* beta,
 * which is why BETA_NEAR is the bigger of the two.
 *
 * Gestures drive a target, and the camera is damped towards it, rather than
 * going through the camera's own `inertialAlphaOffset`. Those offsets are a
 * velocity that Babylon re-applies every frame until it decays, so a drag
 * lands roughly 1/(1 - inertia) times further than the finger travelled — a
 * measured 14 radians of orbit for a 220px swipe. A touch camera has to track
 * the finger, so the finger sets the target and the damping only smooths the
 * approach.
 */

/* Closest is far enough back that a 1.7-unit character reads as a character
 * rather than filling the screen; widest frames the whole 157x134 island. */
const MIN_RADIUS = 14;
const MAX_RADIUS = 170;

const BETA_NEAR = 1.16; // ~66 deg from vertical: low, along the ground
const BETA_FAR = 0.52;  // ~30 deg from vertical: high, looking down

// Radians of orbit per pixel of horizontal drag: a thumb-width swipe is ~75 deg.
const ORBIT_PER_PIXEL = 0.006;
// Fraction of the zoom range per pixel of vertical drag: most of a screen height.
const ZOOM_PER_PIXEL = 0.0016;

/* Fraction of the remaining distance still left after one second. Small enough
 * that the camera sits on the finger during a drag, large enough to round off
 * the steps between pointer events. */
const CAMERA_SETTLE = 1e-6;
// The focus lags further behind on purpose, so walking does not jog the view.
const FOCUS_SETTLE = 1e-3;

export class CameraRig {
  #alpha;
  #radius;

  constructor(scene, { alpha = -Math.PI / 4, radius = MAX_RADIUS * 0.8 } = {}) {
    const camera = new ArcRotateCamera('camera', alpha, BETA_FAR, radius, Vector3.Zero(), scene);
    camera.lowerRadiusLimit = MIN_RADIUS;
    camera.upperRadiusLimit = MAX_RADIUS;
    camera.minZ = 0.5;
    camera.maxZ = 700;
    /* Deliberately never attachControl'd: input.js owns the gestures, and
     * Babylon's own pointer handling would fight the tap-to-move. */

    this.scene = scene;
    this.camera = camera;
    this.focus = camera.target.clone();
    this.#alpha = alpha;
    this.#radius = radius;

    scene.onBeforeRenderObservable.add(() => this.#update());
  }

  /** Horizontal drag: orbit, one swipe to one turn of the world. */
  orbit(pixels) {
    this.#alpha -= pixels * ORBIT_PER_PIXEL;
  }

  /** Vertical drag: zoom. Dragging down pulls the camera in towards the ground. */
  zoom(pixels) {
    const range = MAX_RADIUS - MIN_RADIUS;
    this.#radius = Scalar.Clamp(this.#radius - pixels * ZOOM_PER_PIXEL * range, MIN_RADIUS, MAX_RADIUS);
  }

  /** How far out we are, 0 at the closest and 1 at the widest. */
  get zoomFraction() {
    return Scalar.Clamp((this.camera.radius - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS), 0, 1);
  }

  /** The point the camera orbits. Followed with a lag so movement stays calm. */
  follow(position) {
    this.focus.copyFrom(position);
  }

  snapTo(position) {
    this.focus.copyFrom(position);
    this.camera.target.copyFrom(position);
  }

  #update() {
    // Frame-rate independent: the same settle time at 30fps and at 120fps.
    const seconds = this.scene.getEngine().getDeltaTime() / 1000;
    const camera = 1 - Math.pow(CAMERA_SETTLE, seconds);
    const focus = 1 - Math.pow(FOCUS_SETTLE, seconds);

    this.camera.alpha = Scalar.Lerp(this.camera.alpha, this.#alpha, camera);
    this.camera.radius = Scalar.Lerp(this.camera.radius, this.#radius, camera);
    this.camera.beta = Scalar.Lerp(BETA_NEAR, BETA_FAR, this.zoomFraction);

    Vector3.LerpToRef(this.camera.target, this.focus, focus, this.camera.target);
  }
}
