import { useEffect } from 'react';

import { type ProjectDocument, parseProject } from '@kernel/index';
import { useEditorStore } from '@store/index';
import type { SceneAsset } from '@store/types';

import { hydrateAssets, projectText } from '../services/assets';
import {
  type NumberedCopy,
  autosaveLocationLabel,
  autosaveStem,
  clearAutosaveLocation,
  forgetBrowserCopy,
  pickAutosaveLocation,
  readAutosaveLocation,
  sceneFingerprint,
  writeAutosaveLocation,
  writeNumberedCopy,
} from '../services/autosave';
import { canPickFolder, mayWrite, mayWriteNow } from '../services/download';
import { decodeScenePayload, scenePayloadIn } from '../services/sceneLink';

/**
 * Whether this page load has already put its opening scene on screen.
 *
 * Module scope rather than a ref: walking to DOCS and back remounts this hook,
 * and an empty scene at that point is one the user emptied on purpose. Putting
 * a cube back in front of them would be the editor arguing.
 */
let opened = false;

/**
 * Says whether this page load counts as already opened.
 *
 * A test asking for the browser's own first run passes false; one that builds
 * its own scene passes true, so no cube lands in the middle of it.
 */
export function setOpeningSceneDone(done: boolean): void {
  opened = done;
}

/**
 * Runs the folder picker and keeps what it hands back as the location, or
 * says why not. Only inside a click: the picker opens on nothing else.
 */
async function askForLocation(): Promise<FileSystemDirectoryHandle | null> {
  const state = useEditorStore.getState();
  const pick = await pickAutosaveLocation(state.autosaveLocation);
  if (pick.status === 'cancelled') return null;
  if (pick.status === 'failed') {
    state.pushToast('error', `Could not use that folder for autosave: ${pick.reason}`);
    return null;
  }

  state.setAutosaveLocation(pick.folder, true);
  await writeAutosaveLocation(pick.folder);
  return pick.folder;
}

/**
 * Asks where the numbered copies go, for the LOCATION row in PREFS. Leaves
 * autosave on or off as it was.
 */
export async function chooseAutosaveLocation(): Promise<boolean> {
  const location = await askForLocation();
  if (location) {
    useEditorStore
      .getState()
      .pushToast('success', `Auto-saves go to ${autosaveLocationLabel(location)}`);
  }
  return location !== null;
}

/**
 * Asks the browser again for leave to write to the location autosave already
 * has, which a restart takes away. Resolves whether it was given.
 */
export async function allowAutosaveLocation(): Promise<boolean> {
  const state = useEditorStore.getState();
  const location = state.autosaveLocation;
  if (!location) return chooseAutosaveLocation();

  const label = autosaveLocationLabel(location);
  try {
    if (!(await mayWrite(location))) {
      state.pushToast('warning', `Autosave cannot write to ${label} until it is allowed`);
      return false;
    }
  } catch (error) {
    state.pushToast('error', `Could not reach ${label}: ${(error as Error).message}`);
    return false;
  }

  state.setAutosaveLocation(location, true);
  return true;
}

/**
 * Forgets the location, for RESET in PREFS: the row goes back to Not chosen,
 * and turning autosave on asks for one again, now and after a reload.
 */
export async function forgetAutosaveLocation(): Promise<void> {
  useEditorStore.getState().setAutosaveLocation(null, false);
  await clearAutosaveLocation();
}

/**
 * Turns autosave on.
 *
 * Run by the switch itself, because a folder picker only opens on a click:
 * with no location chosen yet, turning autosave on is where one is asked for,
 * and with one whose permission has lapsed, it is where that is asked back.
 * Resolves whether autosave ended up on.
 */
export async function turnAutosaveOn(): Promise<boolean> {
  // Auto-saves only ever go into a folder, and this browser cannot hand one
  // over. PREFS greys the switch out; this covers anything else calling it.
  if (!canPickFolder()) {
    useEditorStore
      .getState()
      .pushToast('warning', 'Autosave writes to a folder, which this browser cannot give it');
    return false;
  }

  const { autosaveLocation, autosaveLocationReady } = useEditorStore.getState();
  const location = autosaveLocation ?? (await askForLocation());
  if (!location) return false;
  if (autosaveLocation && !autosaveLocationReady && !(await allowAutosaveLocation())) return false;

  const state = useEditorStore.getState();
  state.setPreferences({ autosaveEnabled: true });
  state.pushToast('success', `Autosave is on, writing to ${autosaveLocationLabel(location)}`);
  return true;
}

/**
 * Finds the location autosave was writing to when the editor was last open,
 * so PREFS can show it whether autosave is on or not.
 *
 * Nothing needs saying when the browser kept the permission, which it does
 * across a reload and, where the user chose it, on every visit. Otherwise it
 * takes a click to ask again and the dialog is where that happens. Nothing is
 * auto-saved until it does.
 *
 * Autosave on with nowhere to write is turned off: in a browser with no folder
 * picker, or with no location chosen, which is how a preference saved by a
 * build that kept its copies in the browser arrives.
 */
async function restoreAutosaveLocation(): Promise<void> {
  if (!canPickFolder()) {
    const state = useEditorStore.getState();
    if (state.autosaveEnabled) state.setPreferences({ autosaveEnabled: false });
    return;
  }

  const location = await readAutosaveLocation();
  const ready = location ? await mayWriteNow(location).catch(() => false) : false;

  const state = useEditorStore.getState();
  state.setAutosaveLocation(location, ready);
  if (!state.autosaveEnabled) return;

  if (!location) state.setPreferences({ autosaveEnabled: false });
  else if (!ready && state.dialog === null) state.openDialog('autosaveLocation');
}

/** Writes the scene as the location's next numbered copy, reporting rather than throwing. */
async function copyTo(
  location: FileSystemDirectoryHandle,
  stem: string,
  document: ProjectDocument,
  assets: Record<string, SceneAsset>,
): Promise<NumberedCopy> {
  try {
    // A whole .3doo, images and all, so a copy opens on its own the way a
    // saved file does.
    return await writeNumberedCopy(location, stem, await projectText(document, assets));
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message };
  }
}

/**
 * Opens the scene a `#scene=` link carries, in place of the cube.
 *
 * The link is taken off the address bar first, whatever happens next: a reload
 * is a fresh tab, and opening the link a second time over work done since
 * would throw that work away without a word. The scene is in no file, so it
 * counts as unsaved work, and leaving the tab asks first.
 */
async function openLinkedScene(payload: string): Promise<void> {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  const state = useEditorStore.getState();
  try {
    const document = parseProject(await decodeScenePayload(payload));
    state.loadProjectDocument(document, true, hydrateAssets(document.assets ?? []));
    state.clearHistory();
    state.pushToast('success', `Opened ${document.name} from the link`);
  } catch (error) {
    state.addPrimitive('cube');
    state.markSaved();
    state.pushToast('error', `Could not open the scene in the link: ${(error as Error).message}`);
  }
}

/**
 * What the editor opens on, and the autosave that keeps it.
 *
 * On mount it opens on a cube, the way Blender does: an empty viewport gives
 * you nothing to try a tool against, and the first thing anybody does with a
 * fresh tab is add a cube to have something to press keys at. The browser
 * keeps no copy of a project, so there is no earlier session to come back to:
 * the numbered copies are files, and FILE > OPEN is the way back to one. A
 * page opened from a scene link (`#scene=`, see `services/sceneLink.ts`) opens
 * on the scene the link carries instead.
 *
 * After that it writes on an interval, to one place only: a new numbered
 * `.3doo` in the `3doo-auto-saves` folder of the location the user chose,
 * named after the project's file. Only when the scene differs from the last
 * one stored, by SAVE or by an earlier tick, so an idle editor does not keep
 * writing copies of itself, and each copy that lands turns the disk in the
 * status bar.
 *
 * Nothing is written while the AUTOSAVE preference is off, which it is until
 * the user turns it on, or while the location waits for the browser's leave to
 * write there.
 */
export function useAutosave(): void {
  const interval = useEditorStore((state) => state.autosaveInterval);

  useEffect(() => {
    if (opened) return;
    opened = true;

    void restoreAutosaveLocation();
    void forgetBrowserCopy();

    const state = useEditorStore.getState();
    // Something is already on the table: a scene built before this mounted.
    if (state.objects.length > 0) return;

    // A link handed over a scene to open, which takes the cube's place.
    const linked = scenePayloadIn(window.location.hash);
    if (linked) {
      void openLinkedScene(linked);
      return;
    }

    // Undoable like any other add, so anyone who wants the empty viewport is
    // one Ctrl+Z from it.
    state.addPrimitive('cube');
    // The cube is the editor's doing, not the user's. A tab opened and left
    // alone has nothing worth keeping, so it is not counted as a change.
    state.markSaved();
  }, []);

  useEffect(() => {
    // A scene link pasted over this tab's own address changes only the hash,
    // which reloads nothing. A reload is what opens it, behind the same offer
    // to save that F5 gets when there is work in no file.
    const openPastedLink = () => {
      if (!scenePayloadIn(window.location.hash)) return;
      const state = useEditorStore.getState();
      if (state.dirty) state.openDialog('reload');
      else window.location.reload();
    };
    window.addEventListener('hashchange', openPastedLink);
    return () => window.removeEventListener('hashchange', openPastedLink);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = useEditorStore.getState();
      if (!state.autosaveEnabled) return;
      // Nowhere it may write yet. The flag stays up, so what has changed is
      // written on the first tick after the browser allows it.
      const location = state.autosaveLocationReady ? state.autosaveLocation : null;
      if (!location) return;
      // Nothing has been touched since the last save, or since the scene
      // arrived: an editor sitting open with nobody at it does not keep
      // filling the folder with the same document.
      if (!state.dirty) return;
      if (state.objects.length === 0) return;

      const document = state.snapshotDocument();
      const fingerprint = sceneFingerprint(document);
      // Touched is not changed. An edit taken back with Ctrl+Z, or a folder
      // folded in the outliner, raises the flag on a scene the last save
      // already holds, whether SAVE or this timer made it.
      const unchanged = fingerprint === state.savedFingerprint;
      // Marked before the write rather than after it, so an edit made while it
      // is in flight raises the flag again and is caught by the next tick
      // instead of being swallowed by this one.
      state.markSaved(fingerprint);
      if (unchanged) return;

      const label = autosaveLocationLabel(location);
      // Named at the moment of writing: a SAVE AS since the last tick renames
      // every copy after it.
      const stem = autosaveStem(state.projectFile, state.projectName);

      void copyTo(location, stem, document, state.assets).then((copy) => {
        const current = useEditorStore.getState();
        if (copy.status === 'written') {
          // Noted once the copy has landed rather than when it was sent: the
          // disk in the status bar is there to say the work reached a file,
          // and one for a write that failed would be a lie. No toast goes
          // with it: the disk says enough, and a message on every tick, for a
          // write nobody asked for, is noise.
          current.noteAutosaved();
          return;
        }

        // Put back as pending, unless something has stored a scene since: a
        // SAVE that landed while this was in flight already holds what this
        // failed to write.
        if (current.savedFingerprint === fingerprint) current.markDirty();
        if (copy.status === 'failed') {
          current.pushToast('warning', `Could not write the auto-save to ${label}: ${copy.reason}`);
        } else if (current.autosaveLocation === location) {
          // Asking again takes a click, so the location waits for PREFS rather
          // than raising a warning every time the timer comes round.
          current.setAutosaveLocation(location, false);
        }
      });
    }, interval * 1000);

    return () => window.clearInterval(timer);
  }, [interval]);
}
