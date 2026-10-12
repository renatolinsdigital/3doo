import { type Axis, type Vec3, vec3 } from './vec3';

/** The six straight-on views, named for the side the camera stands on. */
export const STRAIGHT_VIEWS = ['front', 'back', 'right', 'left', 'top', 'bottom'] as const;

export type StraightView = (typeof STRAIGHT_VIEWS)[number];

/**
 * What each straight-on view shows: the world directions that run right and up
 * across its picture, and the one that points back at the camera.
 *
 * These are the editor's own cameras, the ones Shift and a number pick, and a
 * test holds the snapshot renderer to them. Top looks down with -Z up the
 * picture, so the front of a model is at the bottom of it.
 */
export const VIEW_AXES: Record<StraightView, { right: Vec3; up: Vec3; toward: Vec3 }> = {
  front: { right: vec3(1, 0, 0), up: vec3(0, 1, 0), toward: vec3(0, 0, 1) },
  back: { right: vec3(-1, 0, 0), up: vec3(0, 1, 0), toward: vec3(0, 0, -1) },
  right: { right: vec3(0, 0, -1), up: vec3(0, 1, 0), toward: vec3(1, 0, 0) },
  left: { right: vec3(0, 0, 1), up: vec3(0, 1, 0), toward: vec3(-1, 0, 0) },
  top: { right: vec3(1, 0, 0), up: vec3(0, 0, -1), toward: vec3(0, 1, 0) },
  bottom: { right: vec3(1, 0, 0), up: vec3(0, 0, 1), toward: vec3(0, -1, 0) },
};

/**
 * The two world axes a view's picture spans, across first and then up, which
 * is the order a point seen from that view is written in: `[x, y]` from the
 * front, `[z, y]` from the side, `[x, z]` from above. Front and back see the
 * same plane, mirrored, and a point keeps its world values in both.
 */
export const VIEW_PLANES: Record<StraightView, readonly [Axis, Axis]> = {
  front: ['x', 'y'],
  back: ['x', 'y'],
  right: ['z', 'y'],
  left: ['z', 'y'],
  top: ['x', 'z'],
  bottom: ['x', 'z'],
};
