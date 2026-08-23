import { Modal } from '@shared/components';
import { useEditorStore } from '@store/index';

import { DEFAULT_KEYMAP, formatBinding } from '../../keymap/keymap';

import './ShortcutOverlay.scss';

export function ShortcutOverlay() {
  const open = useEditorStore((state) => state.dialog === 'shortcuts');
  const closeDialog = useEditorStore((state) => state.closeDialog);

  const groups = DEFAULT_KEYMAP.reduce<Record<string, typeof DEFAULT_KEYMAP>>((accumulator, binding) => {
    (accumulator[binding.group] ??= []).push(binding);
    return accumulator;
  }, {});

  return (
    <Modal title="KEYBOARD SHORTCUTS" open={open} onClose={closeDialog}>
      <div className="shortcuts">
        {Object.entries(groups).map(([group, bindings]) => (
          <section key={group} className="shortcuts__group">
            <h3 className="shortcuts__heading">{group}</h3>
            <dl className="shortcuts__list">
              {bindings.map((binding) => (
                <div key={`${binding.id}-${binding.key}`} className="shortcuts__row">
                  <dt className="shortcuts__keys">{formatBinding(binding)}</dt>
                  <dd className="shortcuts__action">
                    {binding.label}
                    {binding.mode ? (
                      <span className="shortcuts__mode">{binding.mode}</span>
                    ) : null}
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
              <dd className="shortcuts__action">Orbit (Blender preset)</dd>
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
              <dt className="shortcuts__keys">Alt + Click</dt>
              <dd className="shortcuts__action">Loop select (edge mode)</dd>
            </div>
            <div className="shortcuts__row">
              <dt className="shortcuts__keys">Drag</dt>
              <dd className="shortcuts__action">Box select</dd>
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
