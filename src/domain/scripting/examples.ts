export interface ScriptExample {
  id: string;
  label: string;
  source: string;
}

/** What the editor holds the first time it is opened. */
export const STARTER_SCRIPT = `// Write JavaScript against the scene, then press RUN (Ctrl+Enter).
// Rest the pointer on a name such as scene or add to read what it does.
// The whole run is one step to undo, and a run that fails changes nothing.

const box = scene.add('cube', { name: 'BOX', position: [0, 0.5, 0] });

box.edit((mesh) => {
  mesh.selectFaces((face) => face.normal.y > 0.9);
  mesh.extrude({ offset: 1 });
});
`;

/**
 * Finished models to start from, built the way a game asset is: no face has more
 * than four sides, and parts meet surface to surface rather than passing through
 * one another, with the faces a contact hides left out. Between them they use the
 * modelling operations, deform, custom meshes, linked copies, reading a mesh back,
 * and the mirror, array, bend, twist and subdivision modifiers.
 *
 * Each one adds to the scene rather than clearing it first: an example is run
 * to see what it does, and wiping the work on screen is not what anyone opening
 * one expects. A test runs every one of them, so none can drift out of date or
 * grow a face of more than four sides.
 */
export const SCRIPT_EXAMPLES: readonly ScriptExample[] = [
  {
    id: 'axe',
    label: 'LOW POLY AXE',
    source: `// A low poly axe, all quads. The handle is built in sections that meet ring to ring, so the
// leather grip can take its own colour without a second mesh hidden inside it.
const SEGMENTS = 8;
const HEAD_Y = 1.42; // the middle of the head
const EYE = 0.13; // half the height of the block the handle runs through

// One profile shapes every section, so neighbouring rings line up exactly.
const bow = (y) => -0.04 * Math.sin((Math.PI * Math.min(y, HEAD_Y - EYE)) / (HEAD_Y - EYE));
const radius = (y) => {
  const t = y / 1.6;
  return 0.05 * (1.1 - 0.25 * t + 0.4 * (1 - t) ** 12); // a knob at the foot
};

// A round end split into quads by parallel cuts, rather than left as one many-sided face.
const quadCap = (mesh, onCap) => {
  const index = (v) =>
    (Math.round((Math.atan2(v.z, v.x) / (2 * Math.PI)) * SEGMENTS) + SEGMENTS) % SEGMENTS;
  const sum = SEGMENTS % 4 === 0 ? SEGMENTS / 2 - 1 : SEGMENTS / 2;
  for (let a = 0; a < SEGMENTS; a++) {
    const b = (sum - a + SEGMENTS) % SEGMENTS;
    if (a < b && b - a > 1) {
      mesh.selectVerts((v) => onCap(v) && (index(v) === a || index(v) === b));
      mesh.connect();
    }
  }
};

// A length of handle from y0 to y1. Only an end nothing covers keeps its cap.
const section = (name, color, y0, y1, { cuts, cap, ridges = false }) => {
  const height = y1 - y0;
  const part = scene.add('cylinder', {
    name,
    radius: 1,
    height,
    segments: SEGMENTS,
    capFill: cap !== undefined,
    position: [0, (y0 + y1) / 2, 0],
  });
  part.color = color;
  part.edit((mesh) => {
    const top = (v) => v.y > height / 2 - 1e-6;
    const bottom = (v) => v.y < -height / 2 + 1e-6;
    if (cap) {
      quadCap(mesh, cap === 'top' ? top : bottom);
      // The other end is covered by the next section, so it goes.
      mesh.selectFaces((face) => (cap === 'top' ? face.normal.y < -0.9 : face.normal.y > 0.9));
      mesh.delete({ mode: 'faces' });
    }
    mesh.selectEdges((edge) => Math.abs(edge.a.y - edge.b.y) > height / 2);
    mesh.loopCut({ cuts });
    const step = height / (cuts + 1);
    mesh.deform((v) => {
      const y = v.y + (y0 + y1) / 2;
      const row = Math.round((v.y + height / 2) / step);
      const r = radius(y) * (ridges && row % 2 === 1 ? 1.14 : 1);
      return [v.x * r + bow(y), v.y, v.z * r];
    });
  });
  return part;
};

const pommel = section('POMMEL', '#8a5a3b', 0, 0.12, { cuts: 3, cap: 'bottom' });
const grip = section('GRIP', '#4a2f22', 0.12, 0.5, { cuts: 11, ridges: true });
const handle = section('HANDLE', '#8a5a3b', 0.5, HEAD_Y - EYE, { cuts: 8 });
// The end of the handle showing above the head, standing on its top face.
const end = section('HANDLE END', '#8a5a3b', HEAD_Y + EYE, HEAD_Y + EYE + 0.05, {
  cuts: 1,
  cap: 'top',
});

const head = scene.add('cube', { name: 'HEAD', position: [0, HEAD_Y, 0] });
head.color = '#a7b0b8';
head.edit((mesh) => {
  // The eye the handle runs through.
  mesh.selectVerts();
  mesh.scale({ scale: [0.2, EYE * 2, 0.16] });

  // Out along +X: a narrow neck, then a blade that flares tall and thin.
  mesh.selectFaces((face) => face.normal.x > 0.9);
  mesh.extrude({ offset: 0.1 });
  mesh.scale({ scale: [1, 0.7, 0.75] });
  mesh.extrude({ offset: 0.2 });
  mesh.scale({ scale: [1, 2.3, 0.55] });
  mesh.extrude({ offset: 0.08 });
  mesh.scale({ scale: [1, 1.12, 0.3] });

  // A short poll behind the eye.
  mesh.selectFaces((face) => face.normal.x < -0.9);
  mesh.extrude({ offset: 0.06 });
  mesh.scale({ scale: [1, 0.8, 0.8] });

  // Loops round the head give the cutting edge points to curve through.
  mesh.selectEdges((edge) => Math.abs(edge.a.y - edge.b.y) > 0.3 && edge.center.z > 0);
  mesh.loopCut({ cuts: 4 });

  mesh.deform((v) => {
    const out = Math.max(0, (v.x - 0.2) / 0.28); // 0 at the neck, 1 at the edge
    const across = v.y / 0.28;
    const beard = v.y < 0 ? 1 + 0.7 * out * out : 1;
    return [v.x + 0.07 * out * (1 - across * across), v.y * beard, v.z];
  });
});

scene.group([pommel, grip, handle, end, head], 'AXE');
view.frameSelected();
`,
  },
  {
    id: 'character',
    label: 'LOW POLY CHARACTER',
    source: `// A low poly adventurer, all quads. Each part is a stack of rectangular rings, and parts
// meet face to face rather than passing through each other. Paired parts are modelled on
// one side and mirrored.
const SKIN = '#f0bf8f';
const TUNIC = '#3f7d4e';
const LEATHER = '#5a3b22';
const HAIR = '#6b3e1f';
const parts = [];

const FACING = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

// A part from rectangular rings, bottom to top, each [y, x0, x1, z0, z1]. Neighbouring
// rings are joined by four quads. \`caps\` closes the bottom and the top; \`open\` leaves out
// the faces that point a given way, because they lie against another part.
const loft = (name, color, rings, { caps = [true, true], open = [], mirrored = false } = {}) => {
  const verts = rings.flatMap(([y, x0, x1, z0, z1]) => [
    [x0, y, z0],
    [x1, y, z0],
    [x1, y, z1],
    [x0, y, z1],
  ]);
  const faces = [];
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let i = 0; i < 4; i++) {
      const a = r * 4 + i;
      const b = r * 4 + ((i + 1) % 4);
      faces.push([a, a + 4, b + 4, b]);
    }
  }
  const top = (rings.length - 1) * 4;
  if (caps[0]) faces.push([0, 1, 2, 3]);
  if (caps[1]) faces.push([top + 3, top + 2, top + 1, top]);

  const object = scene.addMesh({ name, verts, faces, position: [0, 0, 0] });
  object.color = color;
  if (open.length > 0) {
    object.edit((mesh) => {
      mesh.selectFaces((face) =>
        open.some((way) => {
          const [x, y, z] = FACING[way];
          return face.normal.x * x + face.normal.y * y + face.normal.z * z > 0.9;
        }),
      );
      mesh.delete({ mode: 'faces' });
    });
  }
  if (mirrored) object.addModifier('mirror');
  parts.push(object);
  return object;
};

// A ring centred on the middle of the body, half as wide and deep as given.
const around = (y, halfWidth, halfDepth) => [y, -halfWidth, halfWidth, -halfDepth, halfDepth];

loft(
  'BOOTS',
  LEATHER,
  [
    [0, 0.03, 0.23, -0.12, 0.18],
    [0.1, 0.03, 0.23, -0.12, 0.18],
    [0.16, 0.04, 0.22, -0.11, 0.1],
  ],
  { mirrored: true },
);

// From the top of the boot to the hem of the tunic: both ends are covered.
loft(
  'LEGS',
  '#3b4a6b',
  [
    [0.16, 0.06, 0.2, -0.07, 0.07],
    [0.52, 0.045, 0.215, -0.085, 0.085],
  ],
  { caps: [false, false], mirrored: true },
);

// The tunic flares to a hem, pinches in at the waist, and is straight from the chest up.
const TUNIC_RINGS = [
  around(0.52, 0.29, 0.18),
  around(0.66, 0.215, 0.135),
  around(0.85, 0.25, 0.15),
  around(1.2, 0.25, 0.15),
];
loft('TUNIC', TUNIC, TUNIC_RINGS);

// The belt is a band whose inner edges rest on the tunic, wherever its height falls.
const tunicAt = (y) => {
  const i = TUNIC_RINGS.findIndex((ring, k) => y <= TUNIC_RINGS[k + 1][0]);
  const [y0, , w0, , d0] = TUNIC_RINGS[i];
  const [y1, , w1, , d1] = TUNIC_RINGS[i + 1];
  const t = (y - y0) / (y1 - y0);
  return [w0 + (w1 - w0) * t, d0 + (d1 - d0) * t];
};
const belt = (y, out) => {
  const [w, d] = tunicAt(y);
  return around(y, w + out, d + out);
};
loft('BELT', LEATHER, [belt(0.62, 0), belt(0.62, 0.015), belt(0.7, 0.015), belt(0.7, 0)], {
  caps: [false, false],
});
const beltFront = (y) => tunicAt(y)[1] + 0.015;
loft(
  'BUCKLE',
  '#e3b341',
  [
    [0.635, -0.045, 0.045, beltFront(0.635), beltFront(0.635) + 0.02],
    [0.685, -0.045, 0.045, beltFront(0.685), beltFront(0.685) + 0.02],
  ],
  { open: ['-z'] },
);

// The arms hang a little away from the body, swung out about the top of the shoulder, so
// a sleeve touches the tunic along that one edge and nowhere else.
const swing = (8 * Math.PI) / 180;
const swingOut = (mesh) =>
  mesh.deform((v) => {
    const [dx, dy] = [v.x - 0.25, v.y - 1.2];
    return [
      0.25 + dx * Math.cos(swing) - dy * Math.sin(swing),
      1.2 + dx * Math.sin(swing) + dy * Math.cos(swing),
      v.z,
    ];
  });
const sleeves = loft(
  'SLEEVES',
  TUNIC,
  [
    [0.94, 0.25, 0.41, -0.085, 0.085],
    [1.2, 0.25, 0.41, -0.085, 0.085],
  ],
  { mirrored: true },
);
sleeves.edit(swingOut);
// Hanging from the bottom of the sleeve, and widening into a hand.
const arms = loft(
  'ARMS',
  SKIN,
  [
    [0.56, 0.26, 0.4, -0.075, 0.075],
    [0.66, 0.26, 0.4, -0.075, 0.075],
    [0.68, 0.27, 0.39, -0.06, 0.06],
    [0.94, 0.27, 0.39, -0.06, 0.06],
  ],
  { caps: [true, false], mirrored: true },
);
arms.edit(swingOut);

loft('NECK', SKIN, [around(1.2, 0.06, 0.06), around(1.25, 0.06, 0.06)], { caps: [false, false] });
// A box with its edges chamfered: a narrower ring at the jaw and at the crown.
loft('HEAD', SKIN, [
  around(1.25, 0.15, 0.14),
  around(1.29, 0.18, 0.17),
  around(1.57, 0.18, 0.17),
  around(1.61, 0.15, 0.14),
]);
loft(
  'NOSE',
  SKIN,
  [
    [1.37, -0.03, 0.03, 0.17, 0.23],
    [1.45, -0.025, 0.025, 0.17, 0.21],
  ],
  { open: ['-z'] },
);
loft(
  'EYES',
  '#2b2b2b',
  [
    [1.435, 0.055, 0.105, 0.17, 0.182],
    [1.505, 0.055, 0.105, 0.17, 0.182],
  ],
  { open: ['-z'], mirrored: true },
);

loft('HAIR', HAIR, [
  [1.61, -0.2, 0.2, -0.24, 0.22],
  [1.7, -0.19, 0.19, -0.23, 0.21],
]);
loft(
  'HAIR',
  HAIR,
  [
    [1.33, -0.2, 0.2, -0.24, -0.17],
    [1.61, -0.2, 0.2, -0.24, -0.17],
  ],
  { caps: [true, false] },
);
loft(
  'FRINGE',
  HAIR,
  [
    [1.55, -0.2, 0.2, 0.17, 0.22],
    [1.61, -0.2, 0.2, 0.17, 0.22],
  ],
  { caps: [true, false] },
);

// The pack hangs flat on the back, and the bedroll rests along its top against the tunic.
loft(
  'PACK',
  '#7a5230',
  [
    [0.86, -0.16, 0.16, -0.29, -0.15],
    [1.15, -0.16, 0.16, -0.29, -0.15],
  ],
  { open: ['+z'] },
);

// A round end split into quads by parallel cuts, rather than left as one eight-sided face.
const quadCap = (mesh, onCap) => {
  const index = (v) => (Math.round((Math.atan2(v.z, v.x) / (2 * Math.PI)) * 8) + 8) % 8;
  for (const [a, b] of [
    [0, 3],
    [4, 7],
  ]) {
    mesh.selectVerts((v) => onCap(v) && (index(v) === a || index(v) === b));
    mesh.connect();
  }
};
const bedroll = scene.add('cylinder', {
  name: 'BEDROLL',
  radius: 0.07,
  height: 0.44,
  segments: 8,
  rotation: [0, 0, 90],
  position: [0, 1.15 + 0.07, -0.15 - 0.07],
});
bedroll.color = '#b5543b';
bedroll.edit((mesh) => {
  quadCap(mesh, (v) => v.y > 0.2);
  quadCap(mesh, (v) => v.y < -0.2);
});
parts.push(bedroll);

scene.group(parts, 'ADVENTURER');
view.frameSelected();
`,
  },
  {
    id: 'staff',
    label: 'WIZARD STAFF',
    source: `// A wizard's staff: a twisted shaft, four linked claws, and a crystal built point by point.
// Every part stands on the one below it, and none passes through another.
const GOLD = '#d4a93a';
const FOOT = 0.14; // the height of the metal foot, where the shaft starts
const TOP = 1.8; // where the shaft ends and the collar starts
const COLLAR = 0.08;

// A round end split into quads by parallel cuts, rather than left as one eight-sided face.
const quadCap = (mesh, onCap) => {
  const index = (v) => (Math.round((Math.atan2(v.z, v.x) / (2 * Math.PI)) * 8) + 8) % 8;
  for (const [a, b] of [
    [0, 3],
    [4, 7],
  ]) {
    mesh.selectVerts((v) => onCap(v) && (index(v) === a || index(v) === b));
    mesh.connect();
  }
};

// The shaft: a square bar, cut into loops so the twist modifier has vertices to turn, with
// a band of rings pushed out for the hand.
const shaft = scene.add('cube', { name: 'SHAFT', position: [0, 0, 0] });
shaft.color = '#6d4c33';
shaft.edit((mesh) => {
  mesh.deform((v) => [v.x * 0.07, FOOT + (v.y + 0.5) * (TOP - FOOT), v.z * 0.07]);
  mesh.selectEdges((edge) => Math.abs(edge.a.y - edge.b.y) > 1);
  mesh.loopCut({ cuts: 24 });
  const step = (TOP - FOOT) / 25;
  mesh.deform((v) => {
    const row = Math.round((v.y - FOOT) / step);
    const ring = v.y > 0.85 && v.y < 1.1 && row % 2 === 1 ? 1.3 : 1;
    return [v.x * ring, v.y, v.z * ring];
  });
});
shaft.addModifier('twist', { angles: { y: 540 } });

// The foot is a cone pointing down, and the shaft stands on its flat top.
const foot = scene.add('cone', {
  name: 'FOOT',
  radius: 0.06,
  height: FOOT,
  segments: 8,
  rotation: [180, 0, 0],
  position: [0, FOOT / 2, 0],
});
foot.color = GOLD;
foot.edit((mesh) => quadCap(mesh, (v) => v.y < 0));

// The collar stands on the top of the shaft.
const collar = scene.add('cylinder', {
  name: 'COLLAR',
  radius: 0.075,
  height: COLLAR,
  segments: 8,
  position: [0, TOP + COLLAR / 2, 0],
});
collar.color = GOLD;
collar.edit((mesh) => {
  quadCap(mesh, (v) => v.y > 0);
  quadCap(mesh, (v) => v.y < 0);
});

// The crystal: six points round its middle and one at each tip, its lower tip resting on
// the collar.
const BASE = TOP + COLLAR;
const verts = [
  [0, 0.3, 0],
  [0, -0.16, 0],
];
for (let i = 0; i < 6; i++) {
  const angle = (i / 6) * Math.PI * 2;
  verts.push([Math.cos(angle) * 0.09, 0, Math.sin(angle) * 0.09]);
}
const faces = [];
for (let i = 0; i < 6; i++) {
  const a = 2 + i;
  const b = 2 + ((i + 1) % 6);
  faces.push([b, a, 0], [a, b, 1]);
}
const crystal = scene.addMesh({ name: 'CRYSTAL', verts, faces, position: [0, BASE + 0.16, 0] });
crystal.color = '#6fd6ff';

// One claw: it stands on the collar, bows out round the widest part of the crystal and
// curls back in over it, narrowing to a point.
const CLAW = 0.33;
const claw = scene.add('cylinder', {
  name: 'CLAW',
  radius: 0.022,
  height: CLAW,
  segments: 6,
  position: [0, 0, 0],
});
claw.color = GOLD;
claw.edit((mesh) => {
  mesh.selectFaces((face) => face.normal.y < -0.9);
  mesh.delete({ mode: 'faces' });
  mesh.selectEdges((edge) => Math.abs(edge.a.y - edge.b.y) > CLAW / 2);
  mesh.loopCut({ cuts: 8 });
  mesh.selectFaces((face) => face.normal.y > 0.9);
  mesh.merge({ mode: 'center' });
  mesh.deform((v) => {
    const t = v.y / CLAW + 0.5;
    const out = 0.1 * Math.sin(0.9 * Math.PI * t) - 0.03 * t;
    const taper = 1 - 0.6 * t;
    return [v.x * taper + out, t * CLAW, v.z * taper];
  });
});

// ...and three linked copies: they share its mesh, so editing one reshapes all four.
const claws = [claw, claw.duplicate(true), claw.duplicate(true), claw.duplicate(true)];
claws.forEach((piece, i) => {
  const turn = 45 + i * 90;
  const radians = (turn * Math.PI) / 180;
  piece.rotation = [0, turn, 0];
  piece.position = [Math.cos(radians) * 0.05, BASE, -Math.sin(radians) * 0.05];
});

const halo = scene.add('torus', {
  name: 'HALO',
  radius: 0.24,
  radius2: 0.01,
  segments: 32,
  rings: 6,
  rotation: [12, 0, 8],
  position: [0, BASE + 0.18, 0],
});
halo.color = GOLD;

scene.group([shaft, foot, collar, crystal, ...claws, halo], 'WIZARD STAFF');
view.frameSelected();
`,
  },
  {
    id: 'bridge',
    label: 'WOODEN BRIDGE',
    source: `// A wooden footbridge over a stream, built from modifiers: an array lays the planks,
// a mirror copies the railing to the far side, and a bend arches the lot.
const span = 4;
const arch = -50; // degrees
const bankTop = 0.1;
const plankWidth = 0.2;
const plankThickness = 0.06;

// The ends of a deck this long, bent through the arch, come down by \`fall\`. Lifting the
// deck by that much, and half a plank, sets the last planks down on the banks.
const turn = Math.abs((arch * Math.PI) / 180) / 2;
const fall = (span / (2 * turn)) * (1 - Math.cos(turn));
const deckY = bankTop + fall + (plankThickness / 2) * Math.cos(turn);

// A bend spreads its angle over the length of the mesh and curls about the object's
// origin, so every part shares the same origin and the same length to follow the same
// curve. Each box is sized from its two corners, written into the mesh.
const part = (name, color, lo, hi) => {
  const object = scene.add('cube', { name, position: [0, deckY, 0] });
  object.color = color;
  object.edit((mesh) =>
    mesh.deform((v) => [v.x < 0 ? lo[0] : hi[0], v.y < 0 ? lo[1] : hi[1], v.z < 0 ? lo[2] : hi[2]]),
  );
  return object;
};
const start = -span / 2;
const deckTop = plankThickness / 2;
const railBottom = 0.585;

const planks = 16;
const deck = part('PLANKS', '#a8743f', [start, -deckTop, -0.5], [start + plankWidth, deckTop, 0.5]);
deck.addModifier('array', {
  count: planks,
  relativeOffset: [(span - plankWidth) / (planks - 1) / plankWidth, 0, 0],
});
deck.addModifier('bend', { angles: { z: arch } });

// The posts stand on the planks and hold the rail up from underneath.
const postWidth = 0.08;
const posts = part(
  'POSTS',
  '#6b4527',
  [start, deckTop, 0.42],
  [start + postWidth, railBottom, 0.5],
);
posts.addModifier('array', {
  count: 5,
  relativeOffset: [(span - postWidth) / 4 / postWidth, 0, 0],
});
posts.addModifier('mirror', { axes: { x: false, z: true } });
posts.addModifier('bend', { angles: { z: arch } });

// The rail is one long box: loop cuts give the bend points to curve it through.
const rails = part(
  'RAILS',
  '#6b4527',
  [start, railBottom, 0.41],
  [-start, railBottom + 0.07, 0.51],
);
rails.edit((mesh) => {
  mesh.selectEdges((edge) => Math.abs(edge.a.x - edge.b.x) > 1);
  mesh.loopCut({ cuts: 16 });
});
rails.addModifier('mirror', { axes: { x: false, z: true } });
rails.addModifier('bend', { angles: { z: arch } });

// The stream runs between the two banks, and its ends, pressed against them, are left out.
const water = scene.add('cube', { name: 'STREAM', position: [0, -0.15, 0], scale: [3.6, 0.1, 3] });
water.color = '#4d8fc4';
water.edit((mesh) => {
  mesh.selectFaces((face) => Math.abs(face.normal.x) > 0.9);
  mesh.delete({ mode: 'faces' });
});
const banks = [-1, 1].map((side) => {
  const bank = scene.add('cube', {
    name: 'BANK',
    position: [side * 2.6, bankTop - 0.15, 0],
    scale: [1.6, 0.3, 3],
  });
  bank.color = '#6f9e3c';
  return bank;
});

scene.group([deck, posts, rails, water, ...banks], 'FOOTBRIDGE');
view.frameSelected();
return \`Laid \${planks} planks across the stream\`;
`,
  },
  {
    id: 'chest',
    label: 'TREASURE CHEST',
    source: `// A treasure chest, all quads: a box, a rounded lid built point by point, iron bands that
// wrap them both, and a lock with its keyhole pushed in.
const WOOD = '#8b5a2b';
const IRON = '#4a4f57';
const GOLD = '#e3b341';
const WIDTH = 1.2;
const HEIGHT = 0.6; // where the box ends and the lid starts
const R = 0.375; // half the depth, which is the lid's radius
const ARC = 6; // sides round the lid
const parts = [];

// The box has no top: the lid sits on its rim and closes it.
const box = scene.add('cube', {
  name: 'BOX',
  position: [0, HEIGHT / 2, 0],
  scale: [WIDTH, HEIGHT, 2 * R],
});
box.color = WOOD;
box.edit((mesh) => {
  mesh.selectFaces((face) => face.normal.y > 0.9);
  mesh.delete({ mode: 'faces' });
});
parts.push(box);

// A point round the lid's curve, from the front edge (0) over the top to the back (ARC).
const arc = (k, out = 0) => {
  const angle = (k / ARC) * Math.PI;
  return [HEIGHT + (R + out) * Math.sin(angle), (R + out) * Math.cos(angle)]; // [y, z]
};

// The lid: the curve at each end, joined by a quad per side. Each end is closed by three
// quads fanned round a point in the middle of its bottom edge, and the bottom is left open.
const lidVerts = [];
for (const x of [-WIDTH / 2, WIDTH / 2]) {
  for (let k = 0; k <= ARC; k++) {
    const [y, z] = arc(k);
    lidVerts.push([x, y, z]);
  }
  lidVerts.push([x, HEIGHT, 0]);
}
const right = ARC + 2;
const lidFaces = [];
for (let k = 0; k < ARC; k++) lidFaces.push([k, right + k, right + k + 1, k + 1]);
for (let k = 0; k < ARC; k += 2) {
  lidFaces.push([ARC + 1, k, k + 1, k + 2]);
  lidFaces.push([right + ARC + 1, right + k + 2, right + k + 1, right + k]);
}
const lid = scene.addMesh({ name: 'LID', verts: lidVerts, faces: lidFaces, position: [0, 0, 0] });
lid.color = WOOD;
parts.push(lid);

// A band: a strip lying on the front of the box, over the lid and down the back, standing
// proud of them. Its inside lies on the wood and its ends on the floor, so neither is built.
const PROUD = 0.02;
const path = [
  [0, R, 0, 1],
  ...Array.from({ length: ARC + 1 }, (_, k) => [...arc(k), k]),
  [0, -R, 0, -1],
];
const bandVerts = [];
const point = ([y, z, k, side], out) => {
  if (side === 1 || side === -1) return [y, z + side * out]; // straight up the box
  return arc(k, out);
};
for (const step of path) {
  const [y, z] = point(step, 0);
  const [oy, oz] = point(step, PROUD);
  bandVerts.push([0.38, y, z], [0.46, y, z], [0.38, oy, oz], [0.46, oy, oz]);
}
const bandFaces = [];
for (let i = 0; i + 1 < path.length; i++) {
  const [a, b] = [i * 4, (i + 1) * 4];
  bandFaces.push([a + 2, a + 3, b + 3, b + 2]); // the outside
  bandFaces.push([a, a + 2, b + 2, b]); // the edge facing the middle
  bandFaces.push([a + 1, b + 1, b + 3, a + 3]); // the edge facing the end
}
const bands = scene.addMesh({
  name: 'BANDS',
  verts: bandVerts,
  faces: bandFaces,
  position: [0, 0, 0],
});
bands.color = IRON;
bands.addModifier('mirror');
parts.push(bands);

// The lock plate stands on the front of the box. Its keyhole is an inset, pushed in.
const lock = scene.add('cube', { name: 'LOCK', position: [0, 0, 0] });
lock.color = GOLD;
lock.edit((mesh) => {
  mesh.deform((v) => [v.x * 0.14, 0.5 + v.y * 0.16, R + 0.01 + v.z * 0.02]);
  mesh.selectFaces((face) => face.normal.z < -0.9);
  mesh.delete({ mode: 'faces' });
  mesh.selectFaces((face) => face.normal.z > 0.9);
  mesh.inset({ thickness: 0.055 });
  mesh.extrude({ offset: -0.012 });
});
parts.push(lock);

// A round end split into quads by parallel cuts, rather than left as one twelve-sided face.
const quadCap = (mesh, onCap) => {
  const index = (v) => (Math.round((Math.atan2(v.z, v.x) / (2 * Math.PI)) * 12) + 12) % 12;
  for (const [a, b] of [
    [0, 5],
    [1, 4],
    [6, 11],
    [7, 10],
  ]) {
    mesh.selectVerts((v) => onCap(v) && (index(v) === a || index(v) === b));
    mesh.connect();
  }
};

// Coins lying flat in front of it, apart from one another, and a short stack.
const COIN = 0.015;
const coins = [
  [-0.35, 0, 0.62],
  [-0.18, 0, 0.75],
  [0.05, 0, 0.6],
  [0.3, 0, 0.7],
  [0.42, 0, 0.95],
  [-0.05, 0, 0.92],
  [0.18, 0, 0.88],
  [0.19, 1, 0.885],
  [0.175, 2, 0.875],
];
coins.forEach(([x, level, z], i) => {
  const coin = scene.add('cylinder', {
    name: 'COIN',
    radius: 0.06,
    height: COIN,
    segments: 12,
    rotation: [0, i * 17, 0],
    position: [x, COIN / 2 + level * COIN, z],
  });
  coin.color = GOLD;
  coin.edit((mesh) => {
    quadCap(mesh, (v) => v.y > 0);
    quadCap(mesh, (v) => v.y < 0);
  });
  parts.push(coin);
});

scene.group(parts, 'TREASURE CHEST');
view.frameSelected();
`,
  },
  {
    id: 'potions',
    label: 'POTION BOTTLES',
    source: `// Potion bottles: each is a cage of quads, extruded from a cylinder into a neck, then
// rounded off by a subdivision surface modifier and shaded smooth. Smoothing is only as
// clean as the cage under it, so the cage has no face of more than four sides.
const NECK = 0.075; // every bottle's neck, so one cork fits them all
const LIP = 0.07; // the flare and the band of the lip
const MOUTH = 0.1; // how deep the cork's recess goes
const parts = [];

// A round end split into quads by parallel cuts, rather than left as one eight-sided face.
const quadCap = (mesh, onCap) => {
  const index = (v) => (Math.round((Math.atan2(v.z, v.x) / (2 * Math.PI)) * 8) + 8) % 8;
  for (const [a, b] of [
    [0, 3],
    [4, 7],
  ]) {
    mesh.selectVerts((v) => onCap(v) && (index(v) === a || index(v) === b));
    mesh.connect();
  }
};

const bottle = (x, color, { radius, height, neck }) => {
  const glass = scene.add('cylinder', {
    name: 'BOTTLE',
    radius,
    height,
    segments: 8,
    position: [x, height / 2, 0],
  });
  glass.color = color;
  const lipTop = height / 2 + 0.05 + neck + LIP;
  glass.edit((mesh) => {
    // A ring inset round the base keeps the bottom flat once it is smoothed.
    mesh.selectFaces((face) => face.normal.y < -0.9);
    mesh.inset({ thickness: radius * 0.3 });
    quadCap(mesh, (v) => v.y < -height / 2 + 1e-4 && Math.hypot(v.x, v.z) < radius * 0.8);

    // Shoulders, neck and lip, all from the top face, which an inset narrows to the neck.
    mesh.selectFaces((face) => face.normal.y > 0.9);
    mesh.inset({ thickness: (radius - NECK) * Math.cos(Math.PI / 8) });
    mesh.extrude({ offset: 0.05 });
    mesh.extrude({ offset: neck });
    mesh.extrude({ offset: 0.03 });
    mesh.scale({ scale: [1.4, 1, 1.4] });
    mesh.extrude({ offset: LIP - 0.03 });
    // The mouth: the lip inset and pushed down into a closed recess for the cork.
    mesh.inset({ thickness: 0.03 });
    mesh.extrude({ offset: -MOUTH });
    quadCap(mesh, (v) => Math.abs(v.y - (lipTop - MOUTH)) < 1e-4 && Math.hypot(v.x, v.z) < 0.09);

    mesh.selectFaces();
    mesh.shade({ smooth: true });
  });
  glass.addModifier('subsurf', { levels: 1 });

  // The cork stands in the recess, clear of the glass all round, with its top showing.
  const cork = scene.add('cylinder', {
    name: 'CORK',
    radius: 0.058,
    height: MOUTH,
    segments: 8,
    position: [x, height / 2 + lipTop, 0],
  });
  cork.color = '#c49a6c';
  cork.edit((mesh) => {
    quadCap(mesh, (v) => v.y > 0);
    mesh.selectFaces((face) => face.normal.y < -0.9);
    mesh.delete({ mode: 'faces' });
  });
  parts.push(glass, cork);
};

bottle(-0.8, '#8e44ad', { radius: 0.35, height: 0.55, neck: 0.25 });
bottle(0, '#c0392b', { radius: 0.25, height: 0.9, neck: 0.2 });
bottle(0.7, '#27ae60', { radius: 0.2, height: 0.35, neck: 0.15 });

scene.group(parts, 'POTIONS');
view.frameSelected();
`,
  },
];
