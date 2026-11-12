import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { MODIFIER_TYPES, OPERATOR_SPECS } from '@domain/scripting/reference';

import { HomeModule } from './HomeModule';

const reel = () => screen.getByRole('button', { name: /sound/i });
const frame = () => screen.getByTitle('3DOO demo reel') as HTMLIFrameElement;

const setUserActivation = (hasBeenActive: boolean) =>
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { hasBeenActive, isActive: false },
  });

const mount = (activated: boolean) => {
  setUserActivation(activated);
  render(<HomeModule />);
  const post = vi.spyOn(frame().contentWindow as Window, 'postMessage');
  fireEvent.load(frame());
  return post;
};

const fromPlayer = (message: object) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify(message),
        source: frame().contentWindow,
      }),
    );
  });

const commands = (post: ReturnType<typeof vi.spyOn>) =>
  post.mock.calls.map(([message]) => JSON.parse(String(message)));

const lastSound = (post: ReturnType<typeof vi.spyOn>) =>
  post.mock.calls
    .map(([message]) => JSON.parse(String(message)).func)
    .filter((func) => func === 'mute' || func === 'unMute')
    .at(-1);

describe('HomeModule figures', () => {
  const stat = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

  it('counts the operations and modifiers the editor really has', () => {
    render(<HomeModule />);

    // Selecting and moving are not operations a visitor would count, and the
    // three booleans run on objects rather than through the operator list.
    const operations =
      OPERATOR_SPECS.filter((spec) => spec.group !== 'selection' && spec.group !== 'transform')
        .length + 3;
    const modifierCard = screen.getByRole('heading', { name: 'NON-DESTRUCTIVE MODIFIERS' })
      .parentElement as HTMLElement;

    // The page used to claim 20 operations and 10 modifiers long after the
    // editor had grown past both, while its own modifier card listed twelve.
    expect(stat('MESH OPERATIONS')).toBe(String(operations));
    expect(stat('MODIFIERS')).toBe(String(MODIFIER_TYPES.length));
    expect(within(modifierCard).getAllByRole('listitem')).toHaveLength(MODIFIER_TYPES.length);
  });
});

describe('HomeModule demo reel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'userActivation');
  });

  it('embeds the reel muted and without the player controls', () => {
    mount(false);

    const url = new URL(frame().src);
    expect(url.pathname).toBe('/embed/KBKQk15FBj0');
    expect(url.searchParams.get('autoplay')).toBe('1');
    expect(url.searchParams.get('mute')).toBe('1');
    // YouTube's own loop reloads the video and lays its title and buttons over
    // every restart, so the reel must not ask for it.
    expect(url.searchParams.has('loop')).toBe(false);
    expect(url.searchParams.get('controls')).toBe('0');
    expect(url.searchParams.get('enablejsapi')).toBe('1');
    expect(frame()).toHaveAttribute('tabindex', '-1');
  });

  it('plays with sound when the visitor has already used the page', () => {
    const post = mount(true);

    expect(lastSound(post)).toBe('unMute');
    expect(reel()).toHaveAccessibleName('Turn the sound off');
  });

  it('applies the sound again once the player says it is ready', () => {
    const post = mount(true);
    post.mockClear();

    fromPlayer({ event: 'onReady' });

    expect(lastSound(post)).toBe('unMute');
  });

  it('starts muted on a fresh visit and turns the sound on at the first click elsewhere', () => {
    const post = mount(false);

    expect(lastSound(post)).toBe('mute');
    expect(reel()).toHaveAccessibleName('Turn the sound on');

    act(() => {
      fireEvent.pointerDown(document.body);
    });

    expect(lastSound(post)).toBe('unMute');
    expect(reel()).toHaveAccessibleName('Turn the sound off');
  });

  it('toggles the sound each time the reel is clicked', () => {
    const post = mount(true);

    fireEvent.click(reel());
    expect(lastSound(post)).toBe('mute');
    expect(reel()).toHaveAccessibleName('Turn the sound on');

    fireEvent.click(reel());
    expect(lastSound(post)).toBe('unMute');
    expect(reel()).toHaveAccessibleName('Turn the sound off');
  });

  it('turns the sound on when the first gesture is a click on the muted reel', () => {
    const post = mount(false);

    fireEvent.pointerDown(reel());
    fireEvent.click(reel());

    expect(lastSound(post)).toBe('unMute');
  });

  it('keeps the player hidden behind the poster until its opening overlay has gone', () => {
    mount(true);

    fromPlayer({ event: 'infoDelivery', info: { currentTime: 1 } });
    expect(frame()).not.toHaveClass('home__reel-video--shown');

    fromPlayer({ event: 'infoDelivery', info: { currentTime: 4 } });
    expect(frame()).toHaveClass('home__reel-video--shown');
  });

  it('seeks back to the start when the reel ends and hides the player over the restart', () => {
    const post = mount(true);
    post.mockClear();

    fromPlayer({ event: 'infoDelivery', info: { currentTime: 20, playerState: 1 } });
    expect(commands(post)).toEqual([]);
    expect(frame()).toHaveClass('home__reel-video--shown');

    fromPlayer({ event: 'infoDelivery', info: { currentTime: 35.04, playerState: 0 } });
    expect(commands(post)).toContainEqual({ event: 'command', func: 'seekTo', args: [0, true] });
    // A seek brings YouTube's title and buttons back for a few seconds, so the
    // player has to be covered before the restart, not after the next report.
    expect(frame()).not.toHaveClass('home__reel-video--shown');
  });
});
