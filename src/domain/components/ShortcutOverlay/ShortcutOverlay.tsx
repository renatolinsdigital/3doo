import { Modal } from '@shared/components';
import { useEditorStore } from '@store/index';

import { DEFAULT_KEYMAP, formatBinding } from '../../keymap/keymap';

import './ShortcutOverlay.scss';

export function ShortcutOverlay() {
  const open = useEditorStore((state) => state.dialog === 'shortcuts');
  const closeDialog = useEditorStore((state) => state.closeDialog);

  const groups = DEFAULT_KEYMAP.reduce<Record<string, typeof DEFAULT_KEYMAP>>(
    (accumulator, binding) => {
      (accumulator[binding.group] ??= []).push(binding);
      return accumulator;
    },
    {},
  );

  return (
    <Modal title="KEYBOARD SHORTCUTS" open={open} onClose={closeDialog}>
      <div className="shortcuts">
        {Object.entries(groups).map(([group, bindings]) => (
          <section key={group} className="shortcuts__group">
            <h3 className="shortcuts__heading">{group}</h3>
            <dl className="shortcuts__list">
              {bindings.map((binding) => (
                <div
                  key={`${binding.id}-${formatBinding(binding)}-${binding.mode ?? 'both'}`}
                  className="shortcuts__row"
                >
                  <dt className="shortcuts__keys">{formatBinding(binding)}</dt>
                  <dd className="shortcuts__action">
                    {binding.label}
                    {binding.mode ? <span className="shortcuts__mode">{binding.mode}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        <section className="shortcuts__group">
          <h3 className="shortcuts__heading">Navigation</h3>
          <dl className="shortcuts__list">
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">MMB</dt>
              <dd className="shortcuts__action">Orbit</dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Shift + MMB</dt>
              <dd className="shortcuts__action">Pan</dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Wheel</dt>
              <dd className="shortcuts__action">Zoom</dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Shift + number</dt>
              <dd className="shortcuts__action">
                The camera keys under VIEW answer from the number row and the numpad alike
              </dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Shift + Click</dt>
              <dd className="shortcuts__action">
                Toggle in or out of the selection (the pointer wears a plus or a minus)
              </dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Alt + Click</dt>
              <dd className="shortcuts__action">
                Loop select, edge and face mode (the pointer wears a ring)
              </dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Shift + Alt + Click</dt>
              <dd className="shortcuts__action">
                Toggle a whole loop, by whether the element clicked is selected
              </dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Drag</dt>
              <dd className="shortcuts__action">Region select: square, circle or lasso (V)</dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Shift + Drag</dt>
              <dd className="shortcuts__action">Add a region to the selection</dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Shift + Ctrl + Drag</dt>
              <dd className="shortcuts__action">
                Drop a region from the selection, leaving the rest
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <p className="shortcuts__credit">
        Developed by{' '}
        <a
          href="https://www.linkedin.com/in/renatolinsdigital/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Renato Lins
        </a>
      </p>
    </Modal>
  );
}
